import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Composio } from "../src/apps/composio.ts";
import { AppsService } from "../src/apps/service.ts";
import { googleRuntime } from "../src/google/runtime.ts";
import { runGoogleTool } from "../src/google/tools.ts";
import { googleContext } from "../src/google/prompt.ts";
import { getUser, type User } from "../src/users.ts";
import { SCOPES } from "../src/google/oauth.ts";

let app: App;
let apps: AppsService;
let serial = 0;
const accounts = new Map<string, { user: string; toolkit: string; status: number }>();
const gmailUrl = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const calendarUrl = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

// Only the external HTTP boundary is replaced. Real connection promotion, DB,
// tool routing and Google API status handling run against separate toolkit accounts.
const backend: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const path = url.pathname.replace("/api/v3.1", "");
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (path === "/auth_configs" && !body) return json({ items: [] });
  if (path === "/auth_configs") return json({ toolkit: body.toolkit, auth_config: { id: `ac_${body.toolkit.slug}`, is_composio_managed: true } });
  if (path === "/connected_accounts/link") {
    const id = `ca_service_${++serial}`;
    accounts.set(id, { user: body.user_id, toolkit: body.auth_config_id.slice(3), status: 200 });
    return json({ connected_account_id: id, redirect_url: `https://connect.composio.dev/link/${id}`, expires_at: new Date(Date.now() + 600_000).toISOString() });
  }
  if (path.startsWith("/connected_accounts/")) {
    const id = path.split("/").pop()!;
    const acc = accounts.get(id);
    if (init?.method === "DELETE") {
      accounts.delete(id);
      return json({ success: true });
    }
    if (!acc) return json({}, 404);
    return json({ id, user_id: acc.user, status: "ACTIVE", toolkit: { slug: acc.toolkit }, auth_config: { id: `ac_${acc.toolkit}`, is_composio_managed: true }, data: { scope: acc.toolkit === "gmail" ? "https://www.googleapis.com/auth/gmail.modify" : "https://www.googleapis.com/auth/calendar" } });
  }
  if (path === "/tools/execute/proxy") {
    const acc = accounts.get(body.connected_account_id);
    if (!acc) return json({ status: 401, data: {} });
    const needed = String(body.endpoint).includes("gmail.googleapis.com") ? "gmail" : "googlecalendar";
    if (acc.toolkit !== needed) return json({ status: 403, data: { error: { message: "wrong toolkit" } } });
    if (acc.status !== 200) return json({ status: acc.status, data: { error: { message: "temporary or revoked" } } });
    if (String(body.endpoint).includes("/profile")) return json({ status: 200, data: { emailAddress: "mail@example.test" } });
    if (String(body.endpoint).endsWith("/calendars/primary")) return json({ status: 200, data: { id: "agenda@example.test" } });
    return json({ status: 200, data: { account: body.connected_account_id, messages: [], items: [] } });
  }
  return json({}, 404);
};

beforeAll(async () => {
  apps = new AppsService(new Composio("test", backend));
  app = await createApp(loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", LOG_LEVEL: "silent" } as any), { apps });
});
afterAll(() => app.stop());

async function user(): Promise<User> {
  const id = (await app.db.query(`INSERT INTO users (handle, line_id) VALUES ($1, 'l1') RETURNING id`, [`service-test-${++serial}`])).rows[0].id;
  return getUser(app.db, id);
}
async function connect(u: User, service: "gmail" | "calendar") {
  await apps.connect(app.db, u.id, service);
  await apps.promote(app.db);
  return apps.accountId(app.db, u.id, service);
}
const api = (u: User, service: "gmail" | "calendar") => googleRuntime()!.api<{ account: string }>(app.db, u.id, service === "gmail" ? SCOPES.gmailRead : SCOPES.calendarEvents, "GET", service === "gmail" ? gmailUrl : calendarUrl);

describe("Google services remain independent", () => {
  it("routes Gmail and Calendar through their own accounts after connecting both", async () => {
    const u = await user();
    const mail = await connect(u, "gmail");
    const calendar = await connect(u, "calendar");
    expect(mail).not.toBe(calendar);
    expect(await api(u, "gmail")).toEqual({ account: mail, messages: [], items: [] });
    expect(await api(u, "calendar")).toEqual({ account: calendar, messages: [], items: [] });
    expect((await apps.connected(app.db, u.id)).map((x) => x.service).sort()).toEqual(["calendar", "gmail"]);
    expect(await googleContext(app.db, u)).toContain("agenda@example.test");
  });

  it("reconnects Calendar without changing Gmail, and disconnects just Calendar", async () => {
    const u = await user();
    const mail = await connect(u, "gmail");
    const first = await connect(u, "calendar");
    const second = await connect(u, "calendar");
    expect(second).not.toBe(first);
    expect(accounts.has(first!)).toBe(false); // l'ancien compte est supprimé chez Composio
    expect((await api(u, "gmail")).account).toBe(mail);
    expect((await api(u, "calendar")).account).toBe(second);
    const result = JSON.parse(await runGoogleTool(app.db, u, "google_disconnect", { service: "calendar" }));
    expect(result.disconnected).toBe(true);
    await expect(api(u, "calendar")).rejects.toMatchObject({ code: "not_connected" });
    expect((await api(u, "gmail")).account).toBe(mail);
    expect(await apps.accountId(app.db, u.id, "calendar")).toBeUndefined();
  });

  it("does not use Gmail credentials for missing Calendar or revoke Gmail after Calendar fails", async () => {
    const u = await user();
    const mail = await connect(u, "gmail");
    await expect(api(u, "calendar")).rejects.toMatchObject({ code: "not_connected" });
    const calendar = (await connect(u, "calendar"))!;
    accounts.get(calendar)!.status = 503;
    await expect(api(u, "calendar")).rejects.toMatchObject({ code: "unavailable" });
    expect(await apps.accountId(app.db, u.id, "calendar")).toBe(calendar);
    accounts.get(calendar)!.status = 401;
    await expect(api(u, "calendar")).rejects.toMatchObject({ code: "reconnect" });
    await expect(api(u, "calendar")).rejects.toMatchObject({ code: "reconnect" });
    expect((await api(u, "gmail")).account).toBe(mail);
  });

  it("offers Calendar through managed auth even without a custom Google client", async () => {
    const u = await user();
    const result = JSON.parse(await runGoogleTool(app.db, u, "google_connect_link", { service: "calendar" }));
    expect(result.connect_link_sent).toBe(true);
    const pending = (await app.db.query(`SELECT service FROM app_connect_pending WHERE user_id = $1`, [u.id])).rows;
    expect(pending).toEqual([{ service: "calendar" }]);
    // Une carte « Mell × Google Agenda » dont le lien est à notre nom (askmell.com/connect/<jeton>), jamais l'écran Composio en clair.
    const links = (await app.db.query(`SELECT kind, text FROM outbox WHERE user_id = $1`, [u.id])).rows;
    expect(links).toHaveLength(1);
    expect(links[0].kind).toBe("card");
    expect(links[0].text).toMatch(/^Connecte Google Agenda à Mell\nhttps:\/\/\S+$/);
  });

  it("leaves legacy app-password Gmail and direct OAuth metadata unchanged when Calendar connects", async () => {
    for (const method of ["app_password", "oauth"]) {
      const u = await user();
      await app.db.query(`INSERT INTO google_connections (user_id, email, scopes, method) VALUES ($1, 'legacy@example.test', $2, $3)`, [u.id, [SCOPES.gmailRead, SCOPES.gmailCompose], method]);
      await connect(u, "calendar");
      const legacy = await googleRuntime()!.connection(app.db, u.id);
      expect(legacy).toMatchObject({ method, email: "legacy@example.test", status: "active", scopes: [SCOPES.gmailRead, SCOPES.gmailCompose] });
      expect((await api(u, "calendar")).account).toBe(await apps.accountId(app.db, u.id, "calendar"));
    }
  });

  it("migrates a legacy Gmail identity without granting it Calendar access", async () => {
    const u = await user();
    accounts.set("ca_legacy_mail", { user: u.id, toolkit: "gmail", status: 200 });
    await app.db.query(`INSERT INTO google_connections (user_id, email, scopes, method, composio_account_id, composio_auth_config_id) VALUES ($1, 'legacy@example.test', $2, 'composio', 'ca_legacy_mail', 'ac_gmail')`, [u.id, ["https://www.googleapis.com/auth/gmail.modify"]]);
    const sql = await readFile(new URL("../migrations/023_google_service_connections.sql", import.meta.url), "utf8");
    for (const stmt of sql.split(/;\s*$/m).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await app.db.query(stmt);
    expect((await api(u, "gmail")).account).toBe("ca_legacy_mail");
    await expect(api(u, "calendar")).rejects.toMatchObject({ code: "not_connected" });
    await connect(u, "calendar");
    expect((await api(u, "gmail")).account).toBe("ca_legacy_mail");
  });
});
