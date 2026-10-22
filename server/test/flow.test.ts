import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LINE_HEADER, SIGNATURE_HEADER, sign } from "@mella/shared";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { runDue } from "../src/schedules.ts";

/** Bout en bout sans réseau : PGlite en mémoire, modèle factice, relais simulé par inject. */
let app: App;
const ME = "+33611111111";
let n = 0;

async function relay(method: "GET" | "POST", url: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const res = await app.http.inject({
    method,
    url,
    payload: method === "POST" ? raw : undefined,
    headers: { "content-type": "application/json", [LINE_HEADER]: "l1", [SIGNATURE_HEADER]: sign("s1", method === "GET" ? url : raw) },
  });
  return res;
}

async function say(text: string) {
  await relay("POST", "/relay/inbound", { lineId: "l1", messages: [{ guid: `g${++n}`, from: ME, sentAt: new Date().toISOString(), text }] });
  await app.tick();
}

async function drain(): Promise<string[]> {
  const res = await relay("GET", "/relay/outbox?wait=0");
  const msgs = res.json().messages as Array<{ id: number; text?: string; tapback?: string }>;
  await relay("POST", "/relay/ack", { lineId: "l1", results: msgs.map((m) => ({ id: m.id, ok: true })) });
  return msgs.map((m) => m.text ?? `[${m.tapback}]`);
}

beforeAll(async () => {
  app = await createApp(loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", MELLA_DEBOUNCE_MS: "0", MELLA_ADMIN_TOKEN: "adm", LOG_LEVEL: "silent" } as any));
});
afterAll(() => app.stop());

describe("Mell de bout en bout", () => {
  it("refuse un relais mal signé", async () => {
    const res = await app.http.inject({ method: "POST", url: "/relay/inbound", payload: "{}", headers: { "content-type": "application/json", [LINE_HEADER]: "l1", [SIGNATURE_HEADER]: "t=1,v1=00" } });
    expect(res.statusCode).toBe(401);
  });

  it("accueille avec confettis et garde le code d'attribution", async () => {
    await say("Salut Mell ! (k7q2)");
    const out = await drain();
    expect(out[0].toLowerCase()).toContain("tu es dedans");
    const u = (await app.db.query(`SELECT attribution_code, lang FROM users WHERE handle = $1`, [ME])).rows[0];
    expect(u).toEqual({ attribution_code: "k7q2", lang: "fr" });
  });

  it("envoie une fiche contact Mell à l'inscription (pour que les aperçus s'affichent)", async () => {
    const who = "+33622222222";
    await relay("POST", "/relay/inbound", { lineId: "l1", messages: [{ guid: "gc1", from: who, sentAt: new Date().toISOString(), text: "Hello" }] });
    await app.tick();
    const row = (await app.db.query(`SELECT o.text FROM outbox o JOIN users u ON u.id = o.user_id WHERE u.handle = $1 AND o.kind = 'contact'`, [who])).rows[0];
    expect(row.text).toContain("BEGIN:VCARD");
    expect(row.text).toContain("FN:Mell");
    expect(row.text).toContain("+33100000000");
    await drain(); // ne pas laisser l'accueil de ce test dans la file des suivants
  });

  it("ignore un message rejoué par le relais", async () => {
    await relay("POST", "/relay/inbound", { lineId: "l1", messages: [{ guid: "g1", from: ME, sentAt: new Date().toISOString(), text: "Salut Mell ! (k7q2)" }] });
    await app.tick();
    expect(await drain()).toEqual([]);
  });

  it("programme un rappel, puis l'envoie à l'heure avec le texte préparé", async () => {
    await say("rappelle-moi dans 5 minutes de sortir le linge");
    expect((await drain()).join(" ")).toContain("je te le rappelle");
    expect(await runDue(app.db, loadConfig({} as any), new Date(Date.now() + 6 * 60_000))).toBe(1);
    expect(await drain()).toEqual(["Rappel : sortir le linge"]);
  });

  it("répond à un merci par une simple réaction", async () => {
    await say("merci");
    expect(await drain()).toEqual(["[love]"]);
  });

  it("propose une tâche, l'exécute après un seul oui, et attend la banque pour payer", async () => {
    await say("achète des piles pour 30 €");
    const proposal = await drain();
    expect(proposal.join(" ")).toContain("30,00");
    await say("oui vas-y");
    const after = await drain();
    expect(after.join(" ")).toContain("banque");
    const t = (await app.db.query(`SELECT status, spent_cents FROM tasks ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(t).toEqual({ status: "awaiting_bank", spent_cents: 1999 });
  });
});
