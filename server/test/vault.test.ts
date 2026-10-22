import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LINE_HEADER, SIGNATURE_HEADER, sign } from "@mella/shared";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { runTool } from "../src/tools.ts";
import { getUser } from "../src/users.ts";
import { MemoryVault, OpenBaoVault, VaultService, type FillTarget } from "../src/vault/index.ts";
import { issueLink } from "../src/vault/links.ts";
import { screenSecret } from "../src/vault/detect.ts";
import { generateTotp, parseTotpSeed } from "../src/vault/totp.ts";

const PW = "Hunter2!xq";
let app: App;
let page = { url: "https://resy.com/login", typed: [] as Array<[string, string]> };
const browser = async (): Promise<FillTarget> => ({ url: async () => page.url, fill: async (role, value) => void page.typed.push([role, value]) });

async function inbound(text: string, guid: string) {
  const raw = JSON.stringify({ lineId: "l1", messages: [{ guid, from: "+33622222222", sentAt: new Date().toISOString(), text }] });
  await app.http.inject({ method: "POST", url: "/relay/inbound", payload: raw, headers: { "content-type": "application/json", [LINE_HEADER]: "l1", [SIGNATURE_HEADER]: sign("s1", raw) } });
}
const outbox = async () => (await app.db.query<{ text: string }>(`SELECT text FROM outbox WHERE kind = 'text' ORDER BY id`)).rows.map((r) => r.text);
const userId = async () => (await app.db.query<{ id: string }>(`SELECT id FROM users WHERE handle = '+33622222222'`)).rows[0].id;

beforeAll(async () => {
  app = await createApp(
    loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", MELLA_DEBOUNCE_MS: "0", LOG_LEVEL: "silent", MELLA_PUBLIC_URL: "https://mella.test" } as any),
    { vault: new VaultService(new MemoryVault()), browser },
  );
});
afterAll(() => app.stop());

describe("détection d'un secret tapé dans le fil", () => {
  it("attrape mot de passe, paire mail/mot de passe, clé 2FA et carte", () => {
    expect(screenSecret(`mon mot de passe resy.com c'est ${PW}`).caught).toEqual({ kind: "login", site: "resy.com", username: undefined, secret: PW });
    expect(screenSecret(`resy : moss@gmail.com / ${PW}`).caught).toMatchObject({ kind: "login", site: "resy", username: "moss@gmail.com", secret: PW });
    expect(screenSecret("clé 2FA resy : JBSW Y3DP EHPK 3PXP").caught).toMatchObject({ kind: "totp", site: "resy", secret: "JBSWY3DPEHPK3PXP" });
    expect(screenSecret("ma carte 4242 4242 4242 4242 exp 12/28").caught).toEqual({ kind: "card" });
  });
  it("laisse passer les phrases normales", () => {
    for (const t of ["le mot de passe est faux", "j'ai oublié mon mdp resy", "rappelle-moi demain à 9h", "mon numéro c'est 06 12 34 56 78"]) {
      expect(screenSecret(t).caught, t).toBeUndefined();
    }
  });
});

describe("coffre de bout en bout", () => {
  it("range un mot de passe envoyé dans le fil sans jamais le stocker ni le répéter", async () => {
    await inbound("Salut Mell !", "v1");
    await inbound(`mon mot de passe resy.com c'est ${PW}`, "v2");
    const all = JSON.stringify([await outbox(), (await app.db.query(`SELECT text FROM messages`)).rows]);
    expect(all).not.toContain(PW);
    expect(all).toContain("vault://login/resy.com");
    expect((await outbox()).join(" ")).toContain("Supprime ton message");
    expect(await app.vault.backend.getLoginForInjection(await userId(), "resy.com")).toEqual({ username: "", password: PW });
  });

  it("injecte dans la page du bon site, refuse ailleurs, et ne rend jamais la valeur au modèle", async () => {
    const user = await getUser(app.db, await userId());
    const listed = await runTool(app.db, user, "vault_list", "{}");
    expect(listed).toContain("vault://login/resy.com");
    expect(listed).not.toContain(PW);
    const task = (await app.db.query(`INSERT INTO tasks (user_id, title, actions, status, expires_at) VALUES ($1, 'Réserver chez Bocca', ARRAY['log_in'], 'authorized', now() + interval '1 hour') RETURNING id`, [user.id])).rows[0];
    const out = await runTool(app.db, user, "vault_fill", JSON.stringify({ task_id: task.id, ref: "vault://login/resy.com" }));
    expect(out).not.toContain(PW);
    expect(page.typed).toContainEqual(["password", PW]);
    page = { url: "https://resy-login.xyz/", typed: [] };
    expect(await runTool(app.db, user, "vault_fill", JSON.stringify({ task_id: task.id, ref: "vault://login/resy.com" }))).toContain("rien n'a été tapé");
    expect(page.typed).toEqual([]);
  });

  it("saisie par lien à usage unique, puis confirmation dans le fil", async () => {
    const id = await userId();
    const { url } = await issueLink(app.db, "https://mella.test", { userId: id, kind: "login", site: "opentable.com" });
    const path = new URL(url).pathname;
    expect((await app.http.inject({ method: "GET", headers: { "accept-language": "fr-FR" }, url: path })).statusCode).toBe(200);
    const form = "site=opentable.com&username=moss%40gmail.com&password=S3cret%21pass&seed=JBSWY3DPEHPK3PXP";
    const post = () => app.http.inject({ method: "POST", url: path, payload: form, headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://mella.test" } });
    expect((await post()).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(410);
    expect(await app.vault.backend.totpCode(id, "opentable.com")).toMatch(/^\d{6}$/);
    expect((await outbox()).at(-1)).toContain("opentable.com (2FA)");
  });

  it("efface tout le coffre d'une personne", async () => {
    const id = await userId();
    await app.vault.deleteUser(app.db, id, { actor: "system" });
    expect(await app.vault.backend.getLoginForInjection(id, "resy.com")).toBeUndefined();
    expect(await app.vault.list(app.db, id)).toEqual([]);
  });
});

// Contre le vrai OpenBao (tunnel ouvert) : MELLA_VAULT_TEST_ADDR=http://127.0.0.1:8200 MELLA_VAULT_TEST_TOKEN=... pnpm test
describe.skipIf(!process.env.MELLA_VAULT_TEST_ADDR)("OpenBao réel", () => {
  it("chiffre par personne, calcule le TOTP côté coffre et efface tout", async () => {
    const bao = new OpenBaoVault({ addr: process.env.MELLA_VAULT_TEST_ADDR!, token: process.env.MELLA_VAULT_TEST_TOKEN! });
    const u = crypto.randomUUID();
    await bao.putLogin(u, "resy.com", { username: "moss", password: PW });
    expect(await bao.getLoginForInjection(u, "resy.com")).toEqual({ username: "moss", password: PW });
    await bao.putTotpSeed(u, "resy.com", "JBSWY3DPEHPK3PXP");
    const code = await bao.totpCode(u, "resy.com");
    const p = parseTotpSeed("JBSWY3DPEHPK3PXP");
    expect([generateTotp(p), generateTotp(p, Date.now() - 30_000)]).toContain(code);
    await bao.deleteUser(u);
    expect(await bao.getLoginForInjection(u, "resy.com")).toBeUndefined();
    expect(await bao.totpCode(u, "resy.com")).toBeUndefined();
  });
});
