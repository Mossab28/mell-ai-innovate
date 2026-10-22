import { createConnection } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { ensureAddress } from "../src/mail/address.ts";
import { parseGmailConfirm, runInbox } from "../src/mail/process.ts";
import { runMailTool } from "../src/mail/tools.ts";
import { startSmtp } from "../src/mail/smtp.ts";
import { getUser } from "../src/users.ts";

/** Adresse mail de Mell : réception par le vrai serveur SMTP, puis ce que Mell en fait selon l'expéditeur. */
let app: App;
let cfg: Config;
let smtp: ReturnType<typeof startSmtp>;
let userId: string;
let address: string;

// Pas de DNS en test : DMARC passe pour tout le monde, DKIM google.com pour Gmail.
const auth = async (raw: Buffer) =>
  ({ dmarc: { status: { result: "pass" } }, dkim: { results: /forwarding-noreply@google\.com/.test(raw.toString()) ? [{ signingDomain: "google.com", status: { result: "pass" } }] : [] } }) as any;

beforeAll(async () => {
  cfg = loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", MELLA_MAIL_DOMAINS: "mell.test", LOG_LEVEL: "silent" } as any);
  app = await createApp(cfg);
  smtp = startSmtp(app.db, cfg, { auth });
  await new Promise((r) => setTimeout(r, 50));
  userId = (await app.db.query(`INSERT INTO users (handle, line_id, name) VALUES ('+33644444444', 'l1', 'Mossab') RETURNING id`)).rows[0].id;
  address = (await ensureAddress(app.db, cfg, await getUser(app.db, userId)))!;
  await app.db.query(`INSERT INTO mail_addresses (user_id, address, source) VALUES ($1, 'moss@gmail.com', 'user')`, [userId]);
});
afterAll(async () => {
  await smtp.close();
  await app.stop();
});

/** Un échange SMTP minimal. Rend les réponses du serveur, ligne par ligne. */
function send(from: string, rcpt: string, data: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(smtp.port(), "127.0.0.1");
    const steps = [`EHLO test.local`, `MAIL FROM:<${from}>`, `RCPT TO:<${rcpt}>`, "DATA", `${data.replace(/\n/g, "\r\n")}\r\n.`, "QUIT"];
    const replies: string[] = [];
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\r\n");
      buf = lines.pop()!;
      for (const l of lines) {
        if (/^\d{3} /.test(l)) {
          replies.push(l);
          if (/^5/.test(l) && replies.length > 1) steps.splice(0, steps.length, "QUIT");
          const next = steps.shift();
          if (next) sock.write(`${next}\r\n`);
        }
      }
    });
    sock.on("close", () => resolve(replies));
    sock.on("error", reject);
  });
}

const mail = (from: string, subject: string, body: string, extra = "") =>
  `From: ${from}\nTo: paul@exemple.fr\nSubject: ${subject}\nMessage-ID: <${Math.random().toString(36).slice(2)}@test>\n${extra}Content-Type: text/plain; charset=utf-8\n\n${body}`;

const judgeSays = (verdict: object) => ({ chat: async () => ({ text: JSON.stringify(verdict), toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }) }) as any;
const outbox = async () => (await app.db.query(`SELECT text FROM outbox WHERE user_id = $1 AND kind = 'text' ORDER BY id`, [userId])).rows.map((r) => r.text as string);

describe("adresse mail de Mell", () => {
  it("donne une adresse lisible, toujours la même", async () => {
    expect(address).toMatch(/^mossab\.[a-z2-9]{4}@mell\.test$/);
    expect(await ensureAddress(app.db, cfg, await getUser(app.db, userId))).toBe(address);
  });

  it("refuse une adresse inconnue dès le destinataire", async () => {
    const r = await send("x@exemple.fr", "personne@mell.test", mail("x@exemple.fr", "Salut", "Coucou"));
    expect(r.some((l) => l.startsWith("550"))).toBe(true);
  });

  it("un mail d'elle (en copie) devient un travail de fond", async () => {
    const r = await send("moss@gmail.com", address, mail("Moss <moss@gmail.com>", "Dîner jeudi", "Mell, trouve-nous une table jeudi soir.\n\n> Paul : partant pour jeudi ?"));
    expect(r.filter((l) => l.startsWith("250")).length).toBeGreaterThanOrEqual(3);
    await runInbox(app.db, cfg, judgeSays({ notify: false }));
    const job = (await app.db.query(`SELECT request FROM jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0];
    expect(job.request).toContain("envoyé par elle-même depuis moss@gmail.com");
    expect(job.request).toContain("trouve-nous une table jeudi soir");
  });

  it("sa boîte qui fait suivre : le juge décide, et Mell la prévient en un texto", async () => {
    await send("moss+caf_=x=mell.test@gmail.com", address, mail("Paul <paul@exemple.fr>", "Jeudi ?", "On se voit jeudi 20 h ?", `X-Forwarded-For: moss@gmail.com ${address}\nX-Forwarded-To: ${address}\n`));
    await runInbox(app.db, cfg, judgeSays({ notify: true, message: "Paul te propose jeudi 20 h. Je lui réponds ?", owner: [] }));
    const row = (await app.db.query(`SELECT kind, forwarded_by, status FROM inbox WHERE user_id = $1 AND subject = 'Jeudi ?'`, [userId])).rows[0];
    expect(row).toMatchObject({ kind: "forwarded", forwarded_by: "moss@gmail.com", status: "done" });
    expect(await outbox()).toContain("Paul te propose jeudi 20 h. Je lui réponds ?");
  });

  it("Gmail demande d'accepter un transfert d'une boîte inconnue : on lui demande, puis son oui le débloque", async () => {
    await send(
      "forwarding-noreply@google.com",
      address,
      mail("Gmail Team <forwarding-noreply@google.com>", "(#482913377) Gmail Forwarding Confirmation - Receive Mail from alex.pro@gmail.com", "Confirmation code: 482913377"),
    );
    await runInbox(app.db, cfg, judgeSays({ notify: false }));
    expect((await outbox()).some((t) => t.includes("recevoir les mails de alex.pro@gmail.com"))).toBe(true);
    const out = JSON.parse(await runMailTool(app.db, await getUser(app.db, userId), "mail_add_address", { address: "alex.pro@gmail.com" }));
    expect(out.resumed).toBe(1);
    // Pas de lien dans ce faux mail : Mell lui donne le code.
    expect((await outbox()).some((t) => t.includes("482913377"))).toBe(true);
  });

  it("lit une confirmation Gmail en français comme en anglais", () => {
    expect(parseGmailConfirm("(n° 123456789) Confirmation de transfert Gmail - Recevoir des e-mails de Jean.Dupont@gmail.com", "https://mail-settings.google.com/mail/vf-%5BAB%5D-x9 code")).toEqual({
      code: "123456789",
      address: "jean.dupont@gmail.com",
      link: "https://mail-settings.google.com/mail/vf-%5BAB%5D-x9",
    });
  });
});
