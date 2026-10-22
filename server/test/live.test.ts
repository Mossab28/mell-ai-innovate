import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { openDb, migrate, type Db } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { seedLines } from "../src/lines.ts";
import { findOrCreateUser, type User } from "../src/users.ts";
import { installBrowserRuntime, SessionManager } from "../src/browser/index.ts";
import { ProfileStore } from "../src/browser/profiles.ts";
import { registerLiveRoutes, startLive } from "../src/browser/live.ts";
import type { BrowserEngine, PageDriver, StorageState } from "../src/browser/types.ts";

class BrowserPage {
  state: StorageState;
  closed = false;
  urls: string[] = [];
  failScreencast = false;
  cdp = Object.assign(new EventEmitter(), {
    send: async (method: string) => {
      if (method === "Page.startScreencast" && this.failScreencast) throw new Error("screencast unavailable");
    },
    detach: async () => {},
  });
  constructor(state?: StorageState) {
    this.state = structuredClone(state ?? { cookies: [], origins: [] });
  }
  async storageState() { return structuredClone(this.state); }
  async close() { this.closed = true; }
  async playwright() {
    return {
      setViewportSize: async () => {},
      goto: async (url: string) => { this.urls.push(url); },
      context: () => ({ newCDPSession: async () => this.cdp }),
      mouse: { click: async () => {}, wheel: async () => {} },
      keyboard: { insertText: async () => {}, press: async () => {} },
    };
  }
}

function mobileClient(html: string, fetch: (url: string, options: any) => Promise<{ ok: boolean; status: number }>) {
  const nodes = new Map<string, any>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", textContent: "", innerHTML: "", disabled: false,
      listeners: {} as Record<string, (event: any) => void>,
      addEventListener(name: string, fn: (event: any) => void) { this.listeners[name] = fn; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 412, height: 780 }),
      focus: () => {},
    });
    return nodes.get(id)!;
  };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById: node, body: node("body") },
    EventSource: class { onmessage: unknown; addEventListener() {} close() {} },
    fetch, setTimeout: (fn: () => void) => fn(), location: { reload() {} },
  });
  return node;
}

const state = (value: string): StorageState => ({ cookies: [{ name: "sid", value, domain: "example.com", path: "/" }], origins: [] });

describe("prise en main : cycle de vie", () => {
  let db: Db;
  let http: FastifyInstance;
  let user: User;
  let sessions: SessionManager;
  let fallback: SessionManager;
  let profiles: ProfileStore;
  let pages: BrowserPage[];
  let links: string[];
  let failSave = false;
  let failScreencast = false;
  let number = 0;
  const cfg = loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "live|+33100000000|test-only", LOG_LEVEL: "silent" } as any);

  beforeAll(async () => {
    db = await openDb(undefined);
    await migrate(db);
    await seedLines(db, cfg.seedLines);
  });
  beforeEach(async () => {
    user = (await findOrCreateUser(db, `live-user-${++number}`, "live", "bonjour")).user;
    profiles = new ProfileStore(Buffer.alloc(32, 3).toString("base64"));
    pages = [];
    links = [];
    failSave = false;
    failScreencast = false;
    const q: Pick<Db, "query"> = { query: async (sql, params) => {
      if (failSave && sql.includes("INSERT INTO browser_profiles")) throw new Error("profile storage unavailable");
      return db.query(sql, params);
    } };
    const engine: BrowserEngine = {
      name: "test-browser",
      open: async (options) => {
        const page = new BrowserPage(options.storageState);
        page.failScreencast = failScreencast;
        pages.push(page);
        return page as unknown as PageDriver;
      },
      close: async () => {},
    };
    const make = () => new SessionManager(q, profiles, { engine: "patchright", home: "/unused", headless: true }, undefined, async () => engine);
    sessions = make();
    fallback = make();
    installBrowserRuntime({ db, cfg, llm: {} as any, sessions, fallback });
    http = Fastify({ logger: false });
    await registerLiveRoutes(http, { db, cfg });
  });
  afterEach(async () => {
    failSave = false;
    for (const path of links) await http.inject({ method: "POST", url: `${path}/cancel` });
    await sessions.closeAll();
    await fallback.closeAll();
    await http.close();
    installBrowserRuntime(undefined);
    vi.useRealTimers();
  });
  afterAll(async () => { await db.close(); });

  const start = async (site = "Example", startUrl = "https://example.com/login") => {
    const url = await startLive(db, cfg, user.id, { site, startUrl });
    const path = new URL(url).pathname;
    links.push(path);
    return path;
  };

  it("sauvegarde le profil courant avant de fermer le navigateur", async () => {
    await sessions.open(user.id);
    pages[0].state = state("latest");
    await sessions.close(user.id);
    expect((await profiles.load(db, user.id))?.cookies[0].value).toBe("latest");
    expect(pages[0].closed).toBe(true);
  });

  it.each(["close", "reap"])("garde la nouvelle connexion quand le secours périmé se ferme : %s", async (finish) => {
    if (finish === "reap") vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    await profiles.save(db, user.id, state("before"));
    await fallback.open(user.id);
    const stale = pages[0];
    if (finish === "reap") await vi.advanceTimersByTimeAsync(5 * 60_000);
    const path = await start();
    pages[1].state = state("connected");
    expect((await http.inject({ method: "POST", url: `${path}/done` })).statusCode).toBe(200);

    if (finish === "reap") await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
    else await fallback.close(user.id);

    expect(stale.closed).toBe(true);
    expect((await profiles.load(db, user.id))?.cookies[0].value).toBe("connected");
  });

  it("recharge le secours périmé avant de sauvegarder sa nouvelle progression", async () => {
    await profiles.save(db, user.id, state("before"));
    const stale = await fallback.open(user.id);
    const path = await start();
    pages[1].state = state("connected");
    await http.inject({ method: "POST", url: `${path}/done` });

    expect(fallback.current(user.id)).toBeUndefined();
    const resumed = await fallback.open(user.id) as unknown as BrowserPage;
    expect(resumed).not.toBe(stale);
    expect(resumed.state.cookies[0].value).toBe("connected");
    resumed.state = state("fallback-progress");
    await fallback.save(user.id);
    expect(sessions.current(user.id)).toBeUndefined();
    await sessions.close(user.id);

    expect((await profiles.load(db, user.id))?.cookies[0].value).toBe("fallback-progress");
    await sessions.open(user.id);
    expect(pages.at(-1)?.state.cookies[0].value).toBe("fallback-progress");
  });

  it("garde le contrôle humain et le profil précédent en renouvelant un contexte périmé", async () => {
    await profiles.save(db, user.id, state("before"));
    await sessions.open(user.id);
    await fallback.open(user.id);
    pages[1].state = state("fallback-progress");
    await fallback.save(user.id);

    const path = await start();
    expect(pages[0].closed).toBe(true);
    expect(pages.at(-1)?.state.cookies[0].value).toBe("fallback-progress");
    await expect(fallback.open(user.id)).rejects.toThrow(/main|contrôle/);
    pages.at(-1)!.state = state("cancelled");
    expect((await http.inject({ method: "POST", url: `${path}/cancel` })).statusCode).toBe(200);
    await fallback.close(user.id);
    expect((await profiles.load(db, user.id))?.cookies[0].value).toBe("fallback-progress");
  });

  it("ne restaure pas un profil oublié en fermant le secours resté ouvert", async () => {
    await profiles.save(db, user.id, state("connected"));
    await sessions.open(user.id);
    await fallback.open(user.id);

    expect(await sessions.forget(user.id)).toBe(true);
    await fallback.close(user.id);

    expect(await profiles.load(db, user.id)).toBeUndefined();
  });

  it("annuler jette les changements du navigateur sans supprimer le profil précédent", async () => {
    await profiles.save(db, user.id, state("before"));
    const path = await start();
    pages[0].state = state("cancelled");
    expect((await http.inject({ method: "POST", url: `${path}/cancel` })).statusCode).toBe(200);
    expect(pages[0].closed).toBe(true);
    await sessions.open(user.id);
    expect(pages.at(-1)?.state.cookies[0].value).toBe("before");
    expect((await profiles.load(db, user.id))?.cookies[0].value).toBe("before");
  });

  it("expirer jette la session saisie pendant la prise en main", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const path = await start();
    pages[0].state = state("expired");
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect((await http.inject({ method: "GET", url: path })).statusCode).toBe(410);
    expect(pages[0].closed).toBe(true);
    expect(await profiles.load(db, user.id)).toBeUndefined();
  });

  it("ne confirme pas une sauvegarde échouée et permet de réessayer", async () => {
    const path = await start();
    pages[0].state = state("connected");
    failSave = true;
    const failed = await http.inject({ method: "POST", url: `${path}/done` });
    expect(failed.statusCode).toBe(503);
    expect((await db.query("SELECT id FROM outbox WHERE user_id = $1", [user.id])).rows).toHaveLength(0);
    expect((await http.inject({ method: "GET", url: path })).statusCode).toBe(200);
    failSave = false;
    expect((await http.inject({ method: "POST", url: `${path}/done` })).statusCode).toBe(200);
    expect((await profiles.load(db, user.id))?.cookies[0].value).toBe("connected");
  });

  it("confirme la session sauvegardée sans inventer un état connecté", async () => {
    const path = await start();
    await http.inject({ method: "POST", url: `${path}/done` });
    const messages = (await db.query<{ text: string }>("SELECT text FROM outbox WHERE user_id = $1", [user.id])).rows;
    expect(messages).toHaveLength(1);
    expect(messages[0].text).not.toMatch(/reste connecté|stay signed in/);
    expect((await http.inject({ method: "GET", url: path })).statusCode).toBe(410);
  });

  it("bloque les moteurs et le remplissage agent pendant la prise en main", async () => {
    const path = await start();
    await expect(sessions.open(user.id)).rejects.toThrow(/main|contrôle/);
    await expect(fallback.open(user.id)).rejects.toThrow(/main|contrôle/);
    await expect(sessions.provider(user.id, "task")).rejects.toThrow(/main|contrôle/);
    await http.inject({ method: "POST", url: `${path}/done` });
    await expect(sessions.open(user.id)).resolves.toBeDefined();
  });

  it("refuse de prendre la main pendant une action agent en cours", async () => {
    await fallback.open(user.id);
    fallback.setBusy(user.id, true);
    await expect(start()).rejects.toThrow(/occupé|cours/);
    fallback.setBusy(user.id, false);
  });

  it("attend toutes les opérations agent déjà commencées avant la prise en main", async () => {
    await sessions.open(user.id);
    sessions.setBusy(user.id, true);
    try {
      sessions.setBusy(user.id, true);
      sessions.setBusy(user.id, false);
      await expect(start()).rejects.toThrow(/occupé|cours/);
    } finally {
      sessions.setBusy(user.id, false);
    }
    await expect(start()).resolves.toMatch(/^\/l\//);
  });

  it("libère le contrôle et jette le contexte si la diffusion ne démarre pas", async () => {
    failScreencast = true;
    await expect(start()).rejects.toThrow("screencast unavailable");
    expect(pages[0].closed).toBe(true);
    failScreencast = false;
    await expect(sessions.open(user.id)).resolves.toBeDefined();
  });

  it.each(["file:///etc/passwd", "http://localhost:8200/", "http://169.254.169.254/", "http://10.0.0.1/"])("refuse une adresse de connexion interne : %s", async (url) => {
    await expect(start("Example", url)).rejects.toThrow();
    expect(pages).toHaveLength(0);
  });

  it("affiche le nom du site comme du texte sans injecter son HTML", async () => {
    const path = await start('<img src=x onerror="alert(1)">');
    const response = await http.inject({ method: "GET", url: path });
    expect(response.body).not.toContain('<img src=x');
    expect(response.body).toContain("&lt;img");
  });
  it("transmet un collage mobile même quand InputEvent.data est null", async () => {
    const path = await start();
    const sent: any[] = [];
    const node = mobileClient((await http.inject({ method: "GET", url: path })).body, async (_url, options) => {
      sent.push(JSON.parse(options.body));
      return { ok: true, status: 200 };
    });
    node("kb").value = "test-only pasted value";
    node("kb").listeners.input({ inputType: "insertFromPaste", data: null });
    await vi.waitFor(() => expect(sent).toEqual([{ type: "text", text: "test-only pasted value" }]));
    expect(node("kb").value).toBe("");
  });

  it("attend la réponse au clic avant de transmettre la frappe", async () => {
    const path = await start();
    const sent: any[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const node = mobileClient((await http.inject({ method: "GET", url: path })).body, async (_url, options) => {
      sent.push(JSON.parse(options.body));
      if (sent.length === 1) await first;
      return { ok: true, status: 200 };
    });
    node("screen").listeners.click({ clientX: 100, clientY: 100 });
    node("kb").value = "a";
    node("kb").listeners.input({ inputType: "insertText", data: "a" });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    try { expect(sent).toHaveLength(1); } finally { release(); }
    await vi.waitFor(() => expect(sent.map((e) => e.type)).toEqual(["tap", "text"]));
  });

  it("attend la dernière saisie avant de demander la sauvegarde", async () => {
    const path = await start();
    const sent: string[] = [];
    let release!: () => void;
    const input = new Promise<void>((resolve) => { release = resolve; });
    const node = mobileClient((await http.inject({ method: "GET", url: path })).body, async (url) => {
      sent.push(url);
      if (url.endsWith("/input")) await input;
      return { ok: true, status: 200 };
    });
    node("kb").value = "a";
    node("kb").listeners.input({ inputType: "insertText", data: "a" });
    const done = node("ok").onclick();
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    try { expect(sent).toEqual([`${path}/input`]); } finally { release(); }
    await done;
    expect(sent).toEqual([`${path}/input`, `${path}/done`]);
  });

  it("garde le formulaire visible quand le serveur refuse la sauvegarde", async () => {
    const path = await start();
    const node = mobileClient((await http.inject({ method: "GET", url: path })).body, async () => ({ ok: false, status: 503 }));
    await node("ok").onclick();
    expect(node("body").innerHTML).toBe("");
    expect(node("status").textContent).toMatch(/Réessaie|retry/i);
    expect(node("ok").disabled).toBe(false);
  });

  it("refuse un remplissage déjà préparé si la personne prend ensuite la main", async () => {
    await sessions.open(user.id);
    const target = await sessions.provider(user.id, "task");
    await start();
    await expect(target!.fill("password", "test-only")).rejects.toThrow(/main|contrôle/);
  });

});
