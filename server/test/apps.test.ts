import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Composio } from "../src/apps/composio.ts";
import { AppsService } from "../src/apps/service.ts";
import { getUser } from "../src/users.ts";

/**
 * Connecteurs Composio : un faux backend Composio, et on vérifie le parcours (lien, promotion, lecture),
 * la garde d'écriture (une tâche validée), et que Gmail connecté par Composio passe par le proxy.
 */
let app: App;
let apps: AppsService;
let userId: string;

// Faux backend Composio : auth_configs, link, account (actif), tools, execute, proxy Gmail.
function fakeComposio(): typeof fetch {
  const state = { linked: new Set<string>() };
  return (async (input: any, init: any) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v3\.1/, "");
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const json = (v: any, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (path.startsWith("/auth_configs") && init?.method !== "POST") return json({ items: [] });
    if (path === "/auth_configs") return json({ toolkit: { slug: body.toolkit.slug }, auth_config: { id: `ac_${body.toolkit.slug}`, is_composio_managed: true } });
    if (path === "/connected_accounts/link") {
      const id = `acc_${body.user_id.slice(0, 6)}_${body.auth_config_id}`;
      state.linked.add(id);
      return json({ connected_account_id: id, redirect_url: `https://connect.composio.dev/link/${id}`, expires_at: new Date(Date.now() + 600_000).toISOString() });
    }
    if (path.startsWith("/connected_accounts/")) {
      const id = path.split("/").pop()!;
      if (init?.method === "DELETE") { state.linked.delete(id); return json({ success: true }); }
      const slug = id.includes("gmail") ? "gmail" : id.includes("notion") ? "notion" : "slack";
      return json({ id, user_id: userId, status: "ACTIVE", toolkit: { slug }, auth_config: { id: `ac_${slug}`, is_composio_managed: true }, data: { scope: slug === "gmail" ? "https://www.googleapis.com/auth/gmail.modify" : "read write" } });
    }
    if (path === "/tools/execute/proxy") {
      // Profil Gmail (login) et une recherche de messages.
      if (String(body.endpoint).includes("/profile")) return json({ status: 200, data: { emailAddress: "moss@gmail.com" } });
      if (String(body.endpoint).includes("/messages")) return json({ status: 200, data: { messages: [] } });
      return json({ status: 200, data: {} });
    }
    if (path === "/tools") {
      return json({ items: [
        { slug: "NOTION_SEARCH", version: "1", name: "Search", description: "search pages", toolkit: { slug: "notion" }, tags: ["readOnlyHint"], input_parameters: { type: "object" } },
        { slug: "NOTION_CREATE_PAGE", version: "1", name: "Create page", description: "create a page", toolkit: { slug: "notion" }, tags: [], input_parameters: { type: "object" } },
      ] });
    }
    if (path.startsWith("/tools/NOTION_SEARCH")) return json({ slug: "NOTION_SEARCH", version: "1", name: "Search", description: "s", toolkit: { slug: "notion" }, tags: ["readOnlyHint"], input_parameters: { type: "object" } });
    if (path.startsWith("/tools/NOTION_CREATE_PAGE")) return json({ slug: "NOTION_CREATE_PAGE", version: "1", name: "Create", description: "c", toolkit: { slug: "notion" }, tags: [], input_parameters: { type: "object" } });
    if (path.startsWith("/tools/execute/")) return json({ successful: true, data: { ok: true } });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
}

beforeAll(async () => {
  apps = new AppsService(new Composio("key", fakeComposio()));
  app = await createApp(loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", LOG_LEVEL: "silent" } as any), { apps });
  userId = (await app.db.query(`INSERT INTO users (handle, line_id, name) VALUES ('+33633333333', 'l1', 'Moss') RETURNING id`)).rows[0].id;
});
afterAll(() => app.stop());

const tool = async (name: string, a: Record<string, unknown> = {}) => JSON.parse(await (await import("../src/tools.ts")).runTool(app.db, await getUser(app.db, userId), name, JSON.stringify(a)));

describe("connecteurs Composio", () => {
  it("connecte une app : lien dans le fil, puis promotion en actif, et le fait remis à l'agent", async () => {
    const r = await tool("connect_app", { service: "notion" });
    expect(r.connect_link_sent).toBe(true);
    expect((await app.db.query(`SELECT 1 FROM app_connect_pending WHERE user_id = $1 AND service = 'notion'`, [userId])).rows.length).toBe(1);
    expect(await apps.promote(app.db)).toBeGreaterThanOrEqual(1);
    const conn = (await app.db.query(`SELECT status, login FROM app_connections WHERE user_id = $1 AND service = 'notion'`, [userId])).rows[0];
    expect(conn.status).toBe("active");
    // Plus de bulle écrite d'avance : l'agent reçoit le fait et reprend ce qu'elle attendait (20/10).
    const fact = (await app.db.query(`SELECT text FROM messages WHERE user_id = $1 AND direction = 'in' AND guid LIKE 'connected:%' ORDER BY id DESC LIMIT 1`, [userId])).rows[0];
    expect(fact.text).toContain("Notion vient d'être connecté");
  });

  it("app_do lit directement, mais refuse d'écrire sans tâche validée", async () => {
    const list = await tool("app_do", { service: "notion", query: "chercher" });
    expect(list.tools.map((t: any) => t.slug)).toContain("NOTION_SEARCH");
    const read = await tool("app_do", { service: "notion", tool: "NOTION_SEARCH", args: { q: "x" } });
    expect(read.result).toContain("ok");
    const blocked = await tool("app_do", { service: "notion", tool: "NOTION_CREATE_PAGE", args: { title: "x" } });
    expect(blocked.error).toContain("accord");
    const task = (await import("../src/tasks.ts")).authorizeNow(app.db, userId, { title: "Créer une page Notion", actions: ["app_write"], spendCapCents: 0 }, 24);
    const done = await tool("app_do", { service: "notion", tool: "NOTION_CREATE_PAGE", args: { title: "x" }, task_id: (await task).id });
    expect(done.result).toContain("ok");
  });

  it("Gmail connecté par Composio : la recherche passe par le proxy, sans écran Google", async () => {
    await apps.connect(app.db, userId, "gmail");
    await apps.promote(app.db);
    const conn = (await app.db.query(`SELECT service, account_id, login FROM app_connections WHERE user_id = $1 AND service = 'gmail'`, [userId])).rows[0];
    expect(conn.account_id).toBeTruthy();
    expect(conn.login).toBe("moss@gmail.com");
    // gmail_search doit répondre (liste vide), preuve que l'appel a bien traversé le proxy Composio.
    const r = await tool("gmail_search", { query: "is:unread" });
    expect(r.count).toBe(0);
  });

  it("déconnecte une app", async () => {
    expect((await tool("disconnect_app", { service: "notion" })).disconnected).toBe(true);
    expect((await app.db.query(`SELECT 1 FROM app_connections WHERE user_id = $1 AND service = 'notion'`, [userId])).rows.length).toBe(0);
  });
});
