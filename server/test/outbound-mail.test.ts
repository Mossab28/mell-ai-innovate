import { createServer } from "node:http";
import { EmailClient } from "@azure/communication-email";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { getUser, type User } from "../src/users.ts";
import { authorizeNow } from "../src/tasks.ts";
import { ensureAddress } from "../src/mail/address.ts";
import { installMailRuntime } from "../src/mail/runtime.ts";
import { runMailTool } from "../src/mail/tools.ts";

// The real SDK talks only to this local HTTP service. The database, guards and cards stay real.
let app: App;
let cfg: Config;
let user: User;
let other: User;
let replyTo: string;
let client: EmailClient;
let messages: any[] = [];
let requests = 0;
let mode: "success" | "ambiguous" = "success";
const provider = createServer(async (req, res) => {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(Buffer.from(part));
  if (req.method === "POST") {
    messages.push(JSON.parse(Buffer.concat(parts).toString()));
    requests++;
    if (mode === "ambiguous") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "ServiceUnavailable", message: "secret provider diagnostic" } }));
      return;
    }
    res.writeHead(202, { "content-type": "application/json", "operation-location": `http://127.0.0.1:${(provider.address() as any).port}/emails/operations/send-1`, "retry-after": "0" });
    res.end(JSON.stringify({ id: "send-1", status: "Running" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "send-1", status: "Succeeded" }));
});

beforeAll(async () => {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const connection = `endpoint=http://127.0.0.1:${(provider.address() as any).port}/;accesskey=dGVzdA==`;
  client = new EmailClient(connection, { allowInsecureConnection: true, retryOptions: { maxRetries: 0 } });
  cfg = loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", MELLA_MAIL_DOMAINS: "askmell.com", MELLA_MAIL_FROM: "mell@askmell.com", MELLA_AZURE_EMAIL_CONNECTION_STRING: connection, LOG_LEVEL: "silent" });
  app = await createApp(cfg);
  const ids = (await app.db.query(`INSERT INTO users (handle, line_id, name) VALUES ('+33655555001', 'l1', 'Moss'), ('+33655555002', 'l1', 'Other') RETURNING id`)).rows;
  user = await getUser(app.db, ids[0].id);
  other = await getUser(app.db, ids[1].id);
  replyTo = (await ensureAddress(app.db, cfg, user))!;
  installMailRuntime({ db: app.db, cfg, emailClient: client } as any);
});
beforeEach(() => { messages = []; requests = 0; mode = "success"; });
afterAll(async () => {
  await app.stop();
  await new Promise<void>((resolve, reject) => provider.close((e) => e ? reject(e) : resolve()));
});

const input = (subject: string) => ({ to: ["paul@example.com"], cc: ["julie@example.com"], subject, body: "Jeudi à 20 h, avec plaisir." });
const run = async (name: string, args: object, who = user) => JSON.parse(await runMailTool(app.db, who, name, args));
const task = async (who = user, recipients = ["paul@example.com", "julie@example.com"]) => authorizeNow(app.db, who.id, { title: "Répondre", actions: ["send_email"], spendCapCents: 0, recipients }, 24);
const post = (id: string) => app.http.inject({ method: "POST", url: `/c/${id}/act/send_mail`, payload: "", headers: { "content-type": "application/x-www-form-urlencoded" } });

describe("Mell outbound mail without Google", () => {
  it("drafts a review card with the exact sender, reply-to, To and Cc without sending", async () => {
    const result = await run("mail_draft", input("Review"));
    expect(result).toMatchObject({ drafted: true, card_sent: true });
    const card = (await app.db.query(`SELECT * FROM cards WHERE id = $1`, [result.draft_id])).rows[0];
    expect(card.meta.mailProvider).toBe("mell");
    const page = await app.http.inject({ method: "GET", url: `/c/${card.id}` });
    for (const text of ["mell@askmell.com", replyTo, "paul@example.com", "julie@example.com", "Jeudi à 20 h, avec plaisir."]) expect(page.body).toContain(text);
    expect(messages).toEqual([]);
  });

  it("requires an authorized task belonging to this user", async () => {
    const foreign = await task(other);
    for (const task_id of [undefined, foreign.id]) {
      expect(await run("mail_send", { ...input("Ownership"), task_id })).toMatchObject({ sent: false, decision: "needs_approval" });
    }
    expect(messages).toEqual([]);
  });

  it("denies and audits a Cc recipient outside the task scope", async () => {
    const t = await task(user, ["paul@example.com"]);
    expect(await run("mail_send", { ...input("Recipient guard"), task_id: t.id })).toMatchObject({ sent: false, decision: "needs_approval" });
    const step = (await app.db.query(`SELECT * FROM task_steps WHERE task_id = $1`, [t.id])).rows[0];
    expect(step.decision).toBe("needs_approval");
    expect(step.detail).toContain("julie@example.com");
    expect(messages).toEqual([]);
  });

  it("sends using fixed identities and an owned inbox message for reply threading", async () => {
    const id = (await app.db.query(`INSERT INTO inbox (user_id, message_id, kind) VALUES ($1, '<original@example.com>', 'other') RETURNING id`, [user.id])).rows[0].id;
    const t = await task();
    const result = await run("mail_send", { ...input("Reply"), task_id: t.id, reply_to_id: Number(id), from: "spoof@example.com", replyTo: "spoof@example.com" });
    expect(result).toMatchObject({ accepted: true, status: "accepted" });
    expect(result.delivered).not.toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ senderAddress: "mell@askmell.com", replyTo: [{ address: replyTo }], recipients: { to: [{ address: "paul@example.com" }], cc: [{ address: "julie@example.com" }] }, headers: { "In-Reply-To": "<original@example.com>", References: "<original@example.com>" } });
    const row = (await app.db.query(`SELECT status, provider_id FROM outbound_mail WHERE user_id = $1 AND task_id = $2`, [user.id, t.id])).rows[0];
    expect(row).toMatchObject({ status: "accepted", provider_id: "send-1" });
  });

  it("deduplicates simultaneous sends and keeps that protection after runtime recreation", async () => {
    const t = await task();
    const args = { ...input("Deduplicate"), task_id: t.id };
    const results = await Promise.all([run("mail_send", args), run("mail_send", args)]);
    expect(results.some((r) => r.accepted)).toBe(true);
    expect(results.some((r) => r.duplicate)).toBe(true);
    installMailRuntime({ db: app.db, cfg, emailClient: client } as any);
    expect(await run("mail_send", args)).toMatchObject({ accepted: true, duplicate: true });
    expect(requests).toBe(1);
  });

  it("sends a card once even when its button is clicked concurrently", async () => {
    const draft = await run("mail_draft", input("Card once"));
    expect(draft.drafted).toBe(true);
    const responses = await Promise.all([post(draft.draft_id), post(draft.draft_id)]);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    await post(draft.draft_id);
    expect(requests).toBe(1);
    const t = (await app.db.query(`SELECT recipients FROM tasks WHERE id = (SELECT task_id FROM outbound_mail WHERE draft_id = $1)`, [draft.draft_id])).rows[0];
    expect(t.recipients.sort()).toEqual(["julie@example.com", "paul@example.com"]);
  });

  it("sending an approved draft in chat closes its card and a later click cannot resend it", async () => {
    const draft = await run("mail_draft", input("Chat draft"));
    const t = await task();
    const result = await run("mail_send", { task_id: t.id, draft_id: draft.draft_id, to: ["spoof@example.com"], body: "replace the approved body" });
    expect(result).toMatchObject({ accepted: true });
    const page = await app.http.inject({ method: "GET", url: `/c/${draft.draft_id}` });
    expect(page.body).not.toContain("/act/send_mail");
    await post(draft.draft_id);
    expect(requests).toBe(1);
    expect(messages[0].content.plainText).toBe("Jeudi à 20 h, avec plaisir.");
  });

  it("persists ambiguous provider errors and never retries or exposes raw diagnostics", async () => {
    mode = "ambiguous";
    const t = await task();
    const args = { ...input("Provider error"), task_id: t.id };
    const first = await run("mail_send", args);
    expect(first).toMatchObject({ accepted: false, status: "unknown" });
    expect(JSON.stringify(first)).not.toContain("secret provider diagnostic");
    expect(await run("mail_send", args)).toMatchObject({ accepted: false, status: "unknown", duplicate: true });
    expect(requests).toBe(1);
  });

  it("keeps an uncertain card locked and never renders a false sent confirmation", async () => {
    mode = "ambiguous";
    const draft = await run("mail_draft", input("Uncertain card"));
    expect(draft.drafted).toBe(true);
    const response = await post(draft.draft_id);
    expect(response.body).not.toContain("Envoyé ✓");
    await post(draft.draft_id);
    const page = await app.http.inject({ method: "GET", url: `/c/${draft.draft_id}` });
    expect(page.body).not.toContain("Envoyé ✓");
    expect(page.body).not.toContain(`/act/send_mail`);
    expect(requests).toBe(1);
  });
});
