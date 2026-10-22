import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PlaywrightDriver } from "./playwright.ts";
import { BridgeEngine } from "./bridge.ts";
import { STEALTH_INIT_SCRIPT, stealthProfile } from "./stealth.ts";
import { BrowserError, type BrowserEngine, type OpenOptions, type PageDriver } from "./types.ts";
import { webBotAuth } from "../webbotauth.ts";

/**
 * Les moteurs comparés au banc, tous open source et auto-hébergeables, sans Docker :
 *
 *   patchright      Chrome stable piloté par Patchright (Playwright patché : pas de Runtime.enable,
 *                   pas de drapeaux d'automatisation). Moteur retenu par défaut.
 *   murmell-chrome  Chrome stable + playwright-core + profil et script d'init de Murmell.
 *   rebrowser       Chrome stable + rebrowser-playwright-core (projet figé en mai 2025).
 *   camoufox        Firefox patché en C++ (empreinte cohérente), joint par le protocole Playwright.
 *   nodriver        Chrome piloté en CDP brut depuis Python, par un pont JSON (bridge.ts).
 *   steel           steel-browser (API open source, Puppeteer + injection d'empreinte), joint en CDP.
 *   browserless     Browserless open source (SSPL), route /chrome avec stealth, joint en CDP.
 *   lightpanda      Navigateur sans rendu écrit en Zig, joint en CDP.
 *
 * Local : le moteur se lance sur cette machine. Distant : MELLA_BROWSER_WS pointe sur l'hôte
 * (infra/browser/host.mjs sur PwnAI, à travers un tunnel SSH ; rien n'écoute ailleurs que sur
 * 127.0.0.1).
 */

export const ENGINES = ["patchright", "murmell-chrome", "rebrowser", "camoufox", "nodriver", "steel", "browserless", "lightpanda", "agentcore"] as const;
export type EngineName = (typeof ENGINES)[number];

export interface EngineConfig {
  engine: EngineName;
  /** Point d'entrée d'un hôte distant (ws://127.0.0.1:port/...). Absent : lancement local. */
  ws?: string;
  /** Dossier des binaires (Chrome, Python, Lightpanda...). */
  home: string;
  headless: boolean;
  /** Pont nodriver distant : commande SSH qui lance le pont sur l'hôte. */
  ssh?: string;
  /** Sortie par un proxy (IP mobile louée) : MELLA_BROWSER_PROXY=http://user:pass@hote:port. Ignoré avec un hôte distant (ws). */
  proxy?: { server: string; username?: string; password?: string };
  /**
   * Navigateur géré d'AWS (Bedrock AgentCore Browser) : une session par navigateur, signée en Web Bot Auth sous
   * l'identité d'AWS, reconnue par Cloudflare, Akamai, HUMAN, DataDome et F5. MELLA_AGENTCORE_BROWSER = id du
   * navigateur créé avec browserSigning (sinon aws.browser.v1, non signé), MELLA_AGENTCORE_REGION, session en secondes.
   */
  agentcore?: { browserId: string; region: string; sessionSeconds: number };
}

function proxyFromEnv(url: string | undefined): EngineConfig["proxy"] {
  if (!url) return undefined;
  const u = new URL(url);
  return { server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`, ...(u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}) };
}

export function engineConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const engine = (env.MELLA_BROWSER_ENGINE ?? "patchright") as EngineName;
  if (!ENGINES.includes(engine)) throw new Error(`moteur inconnu : ${engine} (${ENGINES.join(", ")})`);
  return {
    engine,
    ws: env.MELLA_BROWSER_WS || undefined,
    home: env.MELLA_BROWSER_HOME ?? join(homedir(), ".cache", "mella-browser"),
    // macOS : headless, rien ne doit jamais apparaître sur l'écran de la machine (macOS ramène sur
    // l'écran une fenêtre posée hors de l'écran, et un Chrome fenêtré vole le focus au lancement).
    // Linux : vraie fenêtre dans Xvfb quand DISPLAY existe, headless sinon.
    headless: env.MELLA_BROWSER_HEADLESS ? env.MELLA_BROWSER_HEADLESS === "1" : platform() !== "linux" || !env.DISPLAY,
    ssh: env.MELLA_BROWSER_SSH || undefined,
    proxy: proxyFromEnv(env.MELLA_BROWSER_PROXY),
    agentcore: {
      browserId: env.MELLA_AGENTCORE_BROWSER || "aws.browser.v1",
      region: env.MELLA_AGENTCORE_REGION || "eu-west-3",
      sessionSeconds: Number(env.MELLA_AGENTCORE_SESSION_SECONDS ?? 1800),
    },
  };
}

export function chromePath(home: string): string {
  const p = join(home, "chrome", "path");
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  if (platform() === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return "/usr/bin/google-chrome-stable";
}

/** Fenêtré sur macOS (MELLA_BROWSER_HEADLESS=0, pour déboguer) : posé au plus loin, macOS le ramène en partie. */
const OFFSCREEN = platform() === "darwin" ? ["--window-position=-2400,-2400"] : [];

/**
 * Chrome headless se trahit par son agent utilisateur (« HeadlessChrome ») et par un écran de
 * 800 x 600 plus petit que sa fenêtre. On remet ce qu'un vrai Chrome de bureau montre : même
 * version, même système, écran et densité d'un portable courant. Rendu WebGL, client hints et
 * permissions sont déjà ceux du vrai Chrome (vérifié le 15/10/2026).
 */
export function headlessContextFix(version: string): Record<string, unknown> {
  const major = version.split(".")[0] || "150";
  const mac = platform() === "darwin";
  const os = mac ? "Macintosh; Intel Mac OS X 10_15_7" : "X11; Linux x86_64";
  return {
    userAgent: `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    viewport: { width: 1280, height: 773 },
    screen: mac ? { width: 1512, height: 982 } : { width: 1920, height: 1080 },
    deviceScaleFactor: mac ? 2 : 1,
  };
}
const BASE_ARGS = ["--no-first-run", "--no-default-browser-check", "--lang=fr-FR", "--window-size=1280,860"];

const DEFAULT_CTX = (o: OpenOptions) => ({
  locale: o.locale ?? "fr-FR",
  timezoneId: o.timezoneId ?? "Europe/Paris",
  storageState: o.storageState as any,
});

/**
 * Web Bot Auth : chaque requête du navigateur porte la signature de Mell pour l'hôte visé (RFC 9421). Les sites qui
 * vérifient les agents signés nous laissent passer ; les autres ignorent trois en-têtes de plus. Sans clé, rien.
 */
async function signRequests(ctx: any): Promise<void> {
  const w = webBotAuth();
  if (!w || typeof ctx.route !== "function") return;
  await ctx.route("**/*", (route: any, request: any) => {
    try {
      const u = new URL(request.url());
      if (u.protocol !== "https:") return route.continue();
      return route.continue({ headers: { ...request.headers(), ...w.headersFor(u.host) } });
    } catch {
      return route.continue();
    }
  });
}

/** Moteurs à l'API Playwright : un navigateur, un contexte isolé par ouverture. */
class PwEngine implements BrowserEngine {
  private browser: any;
  private starting?: Promise<any>;

  constructor(
    readonly name: EngineName,
    private readonly start: () => Promise<any>,
    private readonly context: (browser: any, o: OpenOptions) => Promise<any>,
    private readonly cleanup: () => Promise<void> = async () => {},
  ) {}

  private async ensure(): Promise<any> {
    if (this.browser?.isConnected?.()) return this.browser;
    this.starting ??= this.start().finally(() => (this.starting = undefined));
    this.browser = await this.starting;
    return this.browser;
  }

  async open(o: OpenOptions): Promise<PageDriver> {
    const browser = await this.ensure();
    try {
      const ctx = await this.context(browser, o);
      if (this.name !== "agentcore") await signRequests(ctx);
      const page = ctx.pages?.()[0] ?? (await ctx.newPage());
      return new PlaywrightDriver(this.name, ctx, page, true);
    } catch (e) {
      throw new BrowserError(`ouverture impossible (${this.name}) : ${e instanceof Error ? e.message.split("\n")[0] : e}`, "session_perdue");
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
    await this.cleanup();
  }
}

/** Lance un processus qui annonce son point d'entrée sur stdout (Camoufox, serveurs locaux). */
function spawnAndWait(cmd: string, args: string[], match: RegExp, env: NodeJS.ProcessEnv, timeoutMs = 60_000, cwd?: string): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} : pas de point d'entrée après ${timeoutMs} ms`));
    }, timeoutMs);
    const onLine = (line: string) => {
      const m = match.exec(line);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[1] ?? m[0] });
      }
    };
    createInterface({ input: child.stdout! }).on("line", onLine);
    createInterface({ input: child.stderr! }).on("line", onLine);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} s'est arrêté (code ${code})`));
    });
  });
}

export async function makeEngine(cfg: EngineConfig): Promise<BrowserEngine> {
  const chrome = chromePath(cfg.home);
  const headful = !cfg.headless;
  switch (cfg.engine) {
    case "patchright": {
      const { chromium } = await import("patchright");
      // Réglages recommandés par Patchright : vrai Chrome, pas d'agent utilisateur ni d'en-têtes inventés.
      return new PwEngine(
        "patchright",
        () => (cfg.ws ? chromium.connect(cfg.ws) : chromium.launch({ executablePath: chrome, headless: cfg.headless, proxy: cfg.proxy, args: [...BASE_ARGS, ...(cfg.headless ? [] : OFFSCREEN)] })),
        (b, o) => b.newContext({ ...DEFAULT_CTX(o), ...(cfg.headless && !cfg.ws ? headlessContextFix(b.version()) : { viewport: null }) }),
      );
    }
    case "murmell-chrome": {
      const { chromium } = await import("playwright-core");
      return new PwEngine(
        "murmell-chrome",
        async () => {
          if (cfg.ws) return chromium.connect(cfg.ws);
          const p = stealthProfile("155.0.0.0");
          return chromium.launch({ executablePath: chrome, headless: cfg.headless, proxy: cfg.proxy, args: [...p.args, ...(cfg.headless ? [] : OFFSCREEN), "--no-first-run"] });
        },
        async (b, o) => {
          const p = stealthProfile(b.version?.() ?? "155.0.0.0");
          // Murmell tourne sous Linux : sur un Mac, l'agent utilisateur suit la machine.
          const ua = platform() === "darwin" ? p.userAgent.replace("X11; Linux x86_64", "Macintosh; Intel Mac OS X 10_15_7") : p.userAgent;
          const ctx = await b.newContext({
            ...DEFAULT_CTX(o),
            userAgent: ua,
            locale: p.locale,
            timezoneId: p.timezoneId,
            extraHTTPHeaders: { "Accept-Language": p.acceptLanguage },
            viewport: { width: 1280, height: 800 },
          });
          await ctx.addInitScript(STEALTH_INIT_SCRIPT);
          return ctx;
        },
      );
    }
    case "rebrowser": {
      process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE ??= "addBinding";
      const { chromium } = (await import("rebrowser-playwright-core" as string)) as any;
      return new PwEngine(
        "rebrowser",
        () => (cfg.ws ? chromium.connect(cfg.ws) : chromium.launch({ executablePath: chrome, headless: cfg.headless, proxy: cfg.proxy, args: [...BASE_ARGS, ...(cfg.headless ? [] : OFFSCREEN), "--disable-blink-features=AutomationControlled"], ignoreDefaultArgs: ["--enable-automation"] })),
        (b, o) => b.newContext({ ...DEFAULT_CTX(o), ...(cfg.headless && !cfg.ws ? headlessContextFix(b.version()) : { viewport: null }) }),
      );
    }
    case "camoufox": {
      // Le client doit avoir la version de Playwright du serveur Camoufox (1.62).
      const { firefox } = (await import("playwright-camoufox" as string)) as any;
      let child: ChildProcess | undefined;
      return new PwEngine(
        "camoufox",
        async () => {
          if (cfg.ws) return firefox.connect(cfg.ws);
          const py = join(cfg.home, "py", "bin", "python");
          const script = new URL("../../../infra/browser/camoufox_server.py", import.meta.url).pathname;
          const s = await spawnAndWait(py, [script, "--port", "0", ...(cfg.headless ? ["--headless"] : [])], /(ws:\/\/\S+)/, process.env);
          child = s.child;
          return firefox.connect(s.url);
        },
        // Camoufox fixe lui-même une empreinte cohérente : on ne surcharge que langue et fuseau.
        (b, o) => b.newContext({ storageState: o.storageState as any, viewport: null }),
        async () => killTree(child),
      );
    }
    case "steel":
    case "browserless":
    case "lightpanda": {
      const { chromium } = await import("playwright-core");
      let child: ChildProcess | undefined;
      return new PwEngine(
        cfg.engine,
        async () => {
          let ws = cfg.ws;
          if (!ws) {
            const s = await startLocalCdpServer(cfg, chrome, headful);
            child = s.child;
            ws = s.url;
          }
          // steel répond en HTTP avant que son Chrome soit prêt : on retente la connexion un moment.
          for (let i = 0; ; i++) {
            try {
              return await chromium.connectOverCDP(ws, { timeout: 30_000 });
            } catch (e) {
              if (i >= 20) throw e;
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
        },
        async (b, o) => {
          // steel et Browserless posent leur empreinte et leur furtivité sur le contexte qu'ils
          // créent eux-mêmes : on le reprend et on y verse les cookies. Lightpanda n'en a qu'un.
          const existing = b.contexts()[0];
          if (existing && cfg.engine !== "lightpanda") {
            if (o.storageState?.cookies?.length) await existing.addCookies(o.storageState.cookies).catch(() => {});
            return existing;
          }
          try {
            return await b.newContext(DEFAULT_CTX(o));
          } catch {
            return existing;
          }
        },
        async () => killTree(child),
      );
    }
    case "nodriver":
      return new BridgeEngine(cfg);
    case "agentcore":
      return new AgentCoreEngine(cfg.agentcore ?? { browserId: "aws.browser.v1", region: "eu-west-3", sessionSeconds: 1800 });
  }
}

/**
 * Navigateur géré d'AWS : une session par ouverture. Seul le contexte livré avec la session porte la signature
 * Web Bot Auth d'AWS (un contexte créé ensuite ne l'a pas, mesuré le 18/10) ; une session par tâche donne donc
 * la signature et l'isolement des cookies d'une personne à la fois. La session s'arrête avec le contexte.
 */
class AgentCoreEngine implements BrowserEngine {
  readonly name = "agentcore";
  private readonly sessions = new Map<string, () => Promise<void>>();

  constructor(private readonly ac: { browserId: string; region: string; sessionSeconds: number }) {}

  async open(o: OpenOptions): Promise<PageDriver> {
    const { chromium } = await import("playwright-core");
    const { BedrockAgentCoreClient, StartBrowserSessionCommand, StopBrowserSessionCommand } = await import("@aws-sdk/client-bedrock-agentcore");
    const { region, browserId, sessionSeconds } = this.ac;
    const client = new BedrockAgentCoreClient({ region });
    let browser: any;
    let id: string | undefined;
    const stop = async () => {
      if (!id || !this.sessions.has(id)) return;
      this.sessions.delete(id);
      await browser?.close().catch(() => {});
      await client.send(new StopBrowserSessionCommand({ browserIdentifier: browserId, sessionId: id })).catch(() => {});
    };
    try {
      const out = await client.send(new StartBrowserSessionCommand({ browserIdentifier: browserId, sessionTimeoutSeconds: sessionSeconds, name: `mell-${Date.now().toString(36)}` }));
      id = out.sessionId;
      if (!id) throw new Error("pas de session");
      this.sessions.set(id, stop);
      const host = `bedrock-agentcore.${region}.amazonaws.com`;
      const path = `/browser-streams/${browserId}/sessions/${id}/automation`;
      browser = await chromium.connectOverCDP(`wss://${host}${path}`, { headers: await signAgentCoreWs(host, path, region), timeout: 60_000 });
      const ctx = browser.contexts()[0] ?? (await browser.newContext(DEFAULT_CTX(o)));
      if (o.storageState?.cookies?.length) await ctx.addCookies(o.storageState.cookies).catch(() => {});
      const close = ctx.close.bind(ctx);
      ctx.close = async () => {
        await close().catch(() => {});
        await stop();
      };
      const page = ctx.pages?.()[0] ?? (await ctx.newPage());
      return new PlaywrightDriver("agentcore", ctx, page, true);
    } catch (e) {
      await stop();
      throw new BrowserError(`ouverture impossible (agentcore) : ${e instanceof Error ? e.message.split("\n")[0] : e}`, "session_perdue");
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((stop) => stop()));
  }
}

/** En-têtes SigV4 (service bedrock-agentcore) de l'ouverture WebSocket vers le flux d'automatisation d'une session. */
async function signAgentCoreWs(host: string, path: string, region: string): Promise<Record<string, string>> {
  const { SignatureV4 } = await import("@smithy/signature-v4");
  const { HttpRequest } = await import("@smithy/protocol-http");
  const { defaultProvider } = await import("@aws-sdk/credential-provider-node");
  const { createHash, createHmac } = await import("node:crypto");
  class Sha256 {
    private h: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
    constructor(secret?: Uint8Array | string) {
      this.h = secret ? createHmac("sha256", secret) : createHash("sha256");
    }
    update(d: Uint8Array | string) {
      this.h.update(d);
    }
    async digest() {
      return new Uint8Array(this.h.digest());
    }
  }
  const signer = new SignatureV4({ service: "bedrock-agentcore", region, credentials: defaultProvider(), sha256: Sha256 as any });
  const signed = await signer.sign(new HttpRequest({ method: "GET", protocol: "https:", hostname: host, path, headers: { host } }));
  return Object.fromEntries(Object.entries(signed.headers).filter(([k]) => ["host", "x-amz-date", "authorization", "x-amz-security-token", "x-amz-content-sha256"].includes(k.toLowerCase())));
}

/** Serveurs CDP du banc lancés en local (sur PwnAI, c'est host.mjs qui s'en charge). */
async function startLocalCdpServer(cfg: EngineConfig, chrome: string, headful: boolean): Promise<{ child: ChildProcess; url: string }> {
  const port = String(9500 + Math.floor(Math.random() * 400));
  if (cfg.engine === "lightpanda") {
    const s = await spawnAndWait(join(cfg.home, "lightpanda"), ["serve", "--host", "127.0.0.1", "--port", port], /(Server running|listening|Listening)/i, process.env, 20_000);
    return { child: s.child, url: `ws://127.0.0.1:${port}` };
  }
  if (cfg.engine === "steel") {
    // Mode development : steel range ses fichiers dans le dossier temporaire au lieu de /files.
    // Un dossier de profil par instance : steel en prend un fixe, et deux instances se bloquent.
    // Son Chrome écoute toujours sur 9222 : une instance à la fois par machine.
    const profile = mkdtempSync(join(tmpdir(), "mella-steel-"));
    const child: ChildProcess & { mellaProfile?: string } = spawn("node", ["./build/index.js"], {
      cwd: join(cfg.home, "steel-browser", "api"),
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: port,
        CDP_REDIRECT_PORT: String(Number(port) + 1),
        CHROME_EXECUTABLE_PATH: chrome,
        CHROME_HEADLESS: "true", // réglage par défaut de steel ; sa fenêtre visible ne démarre pas sur macOS
        NODE_ENV: "development",
        CHROME_USER_DATA_DIR: profile,
      },
    });
    child.mellaProfile = profile;
    await waitHttp(`http://127.0.0.1:${port}/v1/sessions`, child, 60_000).catch((e) => {
      throw new BrowserError(`steel-browser ne démarre pas : ${e.message}`, "session_perdue");
    });
    return { child, url: `ws://127.0.0.1:${port}/` };
  }
  // Browserless : route /chrome, plugin stealth de puppeteer-extra activé.
  const child = spawn("node", ["build"], {
    cwd: join(cfg.home, "browserless"),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, HOST: "127.0.0.1", PORT: port, TOKEN: "mella-bench", CHROME_PATH: chrome, CONCURRENT: "6", TIMEOUT: "900000" },
  });
  await waitHttp(`http://127.0.0.1:${port}/docs/`, child, 60_000);
  return { child, url: browserlessUrl(`ws://127.0.0.1:${port}`, headful) };
}

export function browserlessUrl(base: string, headful: boolean): string {
  const launch = encodeURIComponent(JSON.stringify({ headless: !headful, stealth: true, args: [...OFFSCREEN, "--lang=fr-FR", "--window-size=1280,860"] }));
  return `${base}/chrome?token=mella-bench&launch=${launch}`;
}

/** Tue le serveur et tout ce qu'il a lancé (Chrome compris) : certains ignorent SIGTERM. */
export function killTree(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  // Puppeteer (steel) lance Chrome dans son propre groupe : on le retrouve par son profil.
  const profile = (child as ChildProcess & { mellaProfile?: string }).mellaProfile;
  if (profile) spawnSync("pkill", ["-9", "-f", profile]);
}

/** Attend qu'un serveur local réponde en HTTP. */
async function waitHttp(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`le serveur s'est arrêté (code ${child.exitCode})`);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill("SIGKILL");
  throw new Error(`pas de réponse de ${url} après ${timeoutMs} ms`);
}
