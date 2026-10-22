import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

// L'espace /me (21/10) : le coffre est visible dans l'espace dès qu'on est connecté (cartes dessinées, identifiants, infos perso),
// sans code en plus ; sans session, rien. Les connecteurs sont des plateaux d'icônes par rubrique, sans rien qui se déplie.
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("espace /me : coffre derrière un code", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let user: string;
  let cookie: string;
  const post = (url: string, form: Record<string, string> = {}) =>
    app.http.inject({ method: "POST", url, headers: { cookie, "accept-language": "fr-FR", "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(form).toString() });
  const get = (url: string) => app.http.inject({ method: "GET", url, headers: { cookie, "accept-language": "fr-FR" } });

  beforeAll(async () => {
    app = await createApp(loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", LOG_LEVEL: "silent", MELLA_PUBLIC_URL: "https://askmell.test", MELLA_VAULT: "memory" } as any));
    user = (await app.db.query(`INSERT INTO users (handle, line_id, name, status, lang) VALUES ('+33600000001', 'l1', 'Test', 'active', 'fr') RETURNING id`)).rows[0].id;
    await app.db.query(`INSERT INTO personal_info (user_id, field, value) VALUES ($1, 'address', '1 rue Secrète')`, [user]);
    const token = randomBytes(24).toString("base64url");
    await app.db.query(`INSERT INTO web_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [sha(token), user]);
    cookie = `mell_s=${token}`;
  });
  afterAll(async () => { await app.http.close(); });

  it("range les connecteurs par rubrique, sans Composio ni dépliant, et montre le coffre", async () => {
    const r = await get("/me");
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Notes et tâches");
    expect(r.body).toContain('class="tile"');
    expect(r.body).not.toContain("<details");
    expect(r.body).not.toContain("Composio");
    expect(r.body).toContain("1 rue Secrète");
  });

  it("sans session, ni l'espace ni le coffre", async () => {
    const r = await app.http.inject({ method: "GET", url: "/me" });
    expect(r.headers.location).toBe("/login");
    expect(r.body).not.toContain("1 rue Secrète");
  });

  it("retirer une info perso se fait depuis l'espace, et l'ancienne page du coffre y renvoie", async () => {
    expect((await get("/me/coffre")).headers.location).toBe("/me#coffre");
    const d = await post("/me/personal/delete", { field: "address" });
    expect(d.headers.location).toBe("/me#coffre");
    expect((await app.db.query(`SELECT 1 FROM personal_info WHERE user_id = $1`, [user])).rows.length).toBe(0);
  });
});
