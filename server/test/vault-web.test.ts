import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { openDb, migrate, type Db } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { seedLines } from "../src/lines.ts";
import { findOrCreateUser, type User } from "../src/users.ts";
import { MemoryVault } from "../src/vault/memory.ts";
import { VaultService } from "../src/vault/service.ts";
import { issueLink, peekLink, type LinkKind } from "../src/vault/links.ts";
import { registerVaultRoutes } from "../src/vault/web.ts";
import type { LoginSecret } from "../src/vault/types.ts";

const PASSWORD = "test-only-password-DO-NOT-ECHO";
const SEED = "JBSWY3DPEHPK3PXP";
const cfg = loadConfig({ MELLA_LLM: "fake", MELLA_PUBLIC_URL: "https://mella.test", MELLA_SEED_LINES: "vault-web|+33100000000|test-only", LOG_LEVEL: "silent" } as any);

class FailingVault extends MemoryVault {
  failTotp = false;
  failLoginAfterWrite = false;
  loginWrites = 0;
  async putLogin(userId: string, site: string, login: LoginSecret) {
    this.loginWrites++;
    const ref = await super.putLogin(userId, site, login);
    if (this.failLoginAfterWrite) throw new Error(`unsafe provider message ${login.password}`);
    return ref;
  }
  async putTotpSeed(userId: string, site: string, seed: string) {
    if (this.failTotp) throw new Error(`unsafe provider message ${seed}`);
    return super.putTotpSeed(userId, site, seed);
  }
}

describe("mobile vault deposit", () => {
  let db: Db;
  let http: FastifyInstance;
  let user: User;
  let backend: FailingVault;
  let vault: VaultService;
  let sequence = 0;
  beforeAll(async () => { db = await openDb(undefined); await migrate(db); await seedLines(db, cfg.seedLines); });
  beforeEach(async () => {
    user = (await findOrCreateUser(db, `vault-web-${++sequence}`, "vault-web", "bonjour")).user;
    backend = new FailingVault(); vault = new VaultService(backend);
    http = Fastify({ logger: false });
    await registerVaultRoutes(http, { db, cfg, vault });
  });
  afterEach(async () => { await http.close(); });
  afterAll(async () => { await db.close(); });

  const link = async (kind: LinkKind = "login", site: string | undefined = "booking.com", taskId?: string) => new URL((await issueLink(db, cfg.publicUrl, { userId: user.id, kind, site, taskId })).url).pathname;
  const submit = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => http.inject({
    method: "POST", url: path, payload: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", "accept-language": "fr-FR", origin: cfg.publicUrl, ...headers },
  });
  const credentials = () => ({ site: "booking.com", username: "dummy@example.test", password: PASSWORD });
  const task = async (owner = user.id) => (await db.query<{ id: string }>(`INSERT INTO tasks (user_id, title, actions, status, expires_at) VALUES ($1, 'Test website task', ARRAY['log_in'], 'authorized', now() + interval '1 hour') RETURNING id`, [owner])).rows[0].id;

  it("serves a private mobile form and generic lock PNG without consuming the link", async () => {
    const path = await link();
    const response = await http.inject({ method: "GET", headers: { "accept-language": "fr-FR" }, url: path });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('autocomplete="current-password"');
    expect(response.body).toContain('autocomplete="username"');
    expect(response.body).toContain("Autres mots de passe");
    expect(response.body).not.toMatch(/Authentification à deux facteurs/); // la 2FA se demande à part (lien totp), plus sur le formulaire de connexion
    expect(response.body).not.toMatch(/<script|https:\/\/booking/);
    expect(response.body).not.toMatch(/name="site"/);
    expect(response.body).toContain("Utilisé uniquement sur booking.com.");
    const image = /property="og:image" content="([^"]+)"/.exec(response.body)?.[1];
    expect(image).toBe("https://mella.test/assets/mell-vault-lock.png");
    expect(image).not.toContain(path);
    const png = await http.inject({ method: "GET", headers: { "accept-language": "fr-FR" }, url: new URL(image!).pathname });
    expect(png.headers["content-type"]).toBe("image/png");
    expect(png.rawPayload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(await peekLink(db, path.split("/").at(-1)!)).toBeDefined();
    expect((await http.inject({ method: "GET", headers: { "accept-language": "fr-FR" }, url: path })).statusCode).toBe(200);
  });

  it.each<Record<string, string>>([
    { origin: "https://evil.test" },
    { origin: "null" },
    { origin: cfg.publicUrl, "sec-fetch-site": "cross-site" },
    { origin: cfg.publicUrl, "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors" },
  ])("rejects a cross-origin submission without using the link: %j", async (headers) => {
    const path = await link();
    expect((await submit(path, credentials(), headers)).statusCode).toBe(403);
    expect(await vault.list(db, user.id)).toHaveLength(0);
    expect((await submit(path, credentials())).statusCode).toBe(200);
  });

  it("accepte le formulaire d'une page sans référent (Origin: null) quand le navigateur dit same-origin", async () => {
    const path = await link();
    expect((await submit(path, credentials(), { origin: "null", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" })).statusCode).toBe(200);
    expect(await vault.list(db, user.id)).toHaveLength(1);
  });

  it("requires browser origin evidence, accepts same-origin fetch metadata", async () => {
    const path = await link();
    const payload = new URLSearchParams(credentials()).toString();
    expect((await http.inject({ method: "POST", url: path, payload, headers: { "content-type": "application/x-www-form-urlencoded" } })).statusCode).toBe(403);
    expect((await http.inject({ method: "POST", url: path, payload, headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" } })).statusCode).toBe(200);
  });

  it("refuses a changed destination, keeps the bound destination and never echoes secrets", async () => {
    const path = await link();
    const response = await submit(path, { ...credentials(), site: "evil.test", seed: SEED });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Utilisé uniquement sur booking.com.");
    expect(response.body).not.toContain(PASSWORD);
    expect(response.body).not.toContain(SEED);
    expect(response.body).not.toContain("evil.test");
    expect(await vault.list(db, user.id)).toHaveLength(0);
    expect((await submit(path, credentials())).statusCode).toBe(200);
  });

  it("rejects overlength credentials instead of silently truncating them", async () => {
    const path = await link();
    const changes: Array<Record<string, string>> = [{ password: "p".repeat(1025) }, { username: "u".repeat(321) }, { seed: "s".repeat(2049) }];
    for (const change of changes) {
      expect((await submit(path, { ...credentials(), ...change })).statusCode).toBe(400);
    }
    expect(backend.loginWrites).toBe(0);
    expect((await submit(path, credentials())).statusCode).toBe(200);
    expect(await backend.getLoginForInjection(user.id, "booking.com")).toMatchObject({ password: PASSWORD });
  });

  it("keeps invalid seeds, passwords and arbitrary invalid site input out of errors", async () => {
    const path = await link("login", undefined);
    const response = await submit(path, { ...credentials(), site: "<secret-site>", seed: "invalid-secret-seed" });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("secret-site");
    expect(response.body).not.toContain("invalid-secret-seed");
    expect(response.body).not.toContain(PASSWORD);
  });

  it("permits exactly one concurrent write and rejects expiry/replay", async () => {
    const path = await link();
    const results = await Promise.all([submit(path, credentials()), submit(path, credentials())]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 410]);
    expect(backend.loginWrites).toBe(1);
    expect((await http.inject({ method: "GET", headers: { "accept-language": "fr-FR" }, url: path })).statusCode).toBe(410);
    const expired = await link();
    await db.query("UPDATE vault_links SET expires_at = now() - interval '1 second' WHERE user_id = $1", [user.id]);
    expect((await submit(expired, credentials())).statusCode).toBe(410);
  });

  it("rejects a task belonging to another user even when the link exists", async () => {
    const other = (await findOrCreateUser(db, `vault-other-${sequence}`, "vault-web", "bonjour")).user;
    const path = await link();
    await db.query("UPDATE vault_links SET task_id = $1 WHERE user_id = $2", [await task(other.id), user.id]);
    expect((await submit(path, credentials())).statusCode).toBe(410);
    expect(backend.loginWrites).toBe(0);
  });

  it("preserves a confirmed login when TOTP fails, offers a new TOTP link and resumes only after completion", async () => {
    const taskId = await task();
    const path = await link("login", "booking.com", taskId);
    backend.failTotp = true;
    const response = await submit(path, { ...credentials(), seed: SEED });
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("Identifiants enregistrés");
    expect(response.body).not.toContain(PASSWORD);
    expect(response.body).not.toContain(SEED);
    expect((await vault.list(db, user.id)).map((r) => r.ref)).toEqual(["vault://login/booking.com"]);
    expect((await db.query("SELECT id FROM jobs WHERE user_id = $1", [user.id])).rows).toHaveLength(0);
    expect((await submit(path, credentials())).statusCode).toBe(410);
    const retry = /href="([^"\s]*\/v\/[A-Za-z0-9_-]+)"/.exec(response.body)?.[1];
    expect(retry).toBeDefined();
    const retryPath = new URL(retry!, cfg.publicUrl).pathname;
    expect((await peekLink(db, retryPath.split("/").at(-1)!))?.kind).toBe("totp");
    backend.failTotp = false;
    expect((await submit(retryPath, { site: "booking.com", seed: SEED })).statusCode).toBe(200);
    expect(backend.loginWrites).toBe(1);
    expect((await db.query("SELECT id FROM jobs WHERE user_id = $1", [user.id])).rows).toHaveLength(1);
  });

  it("allows retry after uncertain external write without claiming nothing was saved", async () => {
    const path = await link();
    backend.failLoginAfterWrite = true;
    const response = await submit(path, credentials());
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("confirmation");
    expect(response.body).not.toMatch(/rien.{0,20}enregistré|nothing.{0,20}saved/i);
    expect(response.body).not.toContain(PASSWORD);
    expect((await http.inject({ method: "GET", headers: { "accept-language": "fr-FR" }, url: path })).statusCode).toBe(200);
    backend.failLoginAfterWrite = false;
    expect((await submit(path, credentials())).statusCode).toBe(200);
    expect((await vault.list(db, user.id)).map((r) => r.ref)).toEqual(["vault://login/booking.com"]);
  });

  it("keeps personal and card deposits, without a guaranteed bank approval claim or card echo", async () => {
    const personal = await link("personal", undefined);
    expect((await submit(personal, { full_name: "Test Person" })).statusCode).toBe(200);
    const card = await link("card", undefined);
    const form = await http.inject({ method: "GET", headers: { "accept-language": "fr-FR" }, url: card });
    expect(form.body).not.toMatch(/chaque paiement.{0,60}banque/);
    const bad = await submit(card, { number: "4242424242424242", exp: "12/99", cvc: "x-secret-cvc", holder: "Test" });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain("4242424242424242");
    expect(bad.body).not.toContain("x-secret-cvc");
    expect((await submit(card, { number: "4242424242424242", exp: "12/99", cvc: "123", holder: "Test" })).statusCode).toBe(200);
  });
});
