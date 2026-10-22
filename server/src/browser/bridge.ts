import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { EngineConfig } from "./engines.ts";
import { chromePath } from "./engines.ts";
import { SNAPSHOT_FN, type RawFrameSnapshot } from "./snapshot.ts";
import { BrowserError, type BrowserEngine, type ErrorCategory, type FillPolicy, type FillRole, type OpenOptions, type PageDriver, type PageSnapshot, type StorageState } from "./types.ts";
import { siteMatchesHost } from "../vault/refs.ts";

/**
 * Moteurs pilotés depuis Python (nodriver) : un processus pont par page ouverte, qui lance son
 * propre Chrome et parle en lignes JSON sur stdin/stdout. En distant, le pont tourne sur l'hôte
 * et le canal est la session SSH elle-même : aucun port ouvert.
 */

const FILL_SELECTORS: Record<string, string[]> = {
  username: ['input[autocomplete="username"]', "input[type=email]", 'input[name*="email" i]', 'input[name*="user" i]', 'input[name*="login" i]'],
  password: ['input[autocomplete="current-password"]', "input[type=password]"],
  totp: ['input[autocomplete="one-time-code"]', 'input[name*="otp" i]', 'input[name*="code" i]', 'input[inputmode="numeric"]'],
};

class Bridge {
  private seq = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private dead?: Error;

  constructor(private readonly child: ChildProcess) {
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // bruit de Chrome ou de Python sur stdout
      }
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.ok) w.resolve(msg.result);
      else w.reject(new BrowserError(String(msg.error ?? "erreur du pont").slice(0, 300), (msg.category as ErrorCategory) ?? "autre"));
    });
    child.stderr?.on("data", () => {});
    child.once("exit", (code) => {
      this.dead = new BrowserError(`pont arrêté (code ${code})`, "session_perdue");
      for (const w of this.waiting.values()) w.reject(this.dead);
      this.waiting.clear();
    });
  }

  call<T = any>(op: string, args: Record<string, unknown> = {}, timeoutMs = 45_000): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new BrowserError(`${op} : pas de réponse en ${timeoutMs} ms`, "delai"));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.child.stdin!.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  kill(): void {
    this.child.stdin?.end();
    setTimeout(() => this.child.kill("SIGKILL"), 3000).unref();
  }
}

class BridgeDriver implements PageDriver {
  private readonly registry = `__m${randomBytes(6).toString("hex")}`;
  private known = new Set<string>();

  constructor(
    readonly engine: string,
    private readonly bridge: Bridge,
  ) {}

  url(): Promise<string> {
    return this.bridge.call("url");
  }
  goto(url: string, timeoutMs = 30_000): Promise<{ status?: number }> {
    return this.bridge.call("goto", { url, timeout: timeoutMs / 1000 }, timeoutMs + 10_000);
  }
  async snapshot(opts: { textOffset?: number; textLimit?: number } = {}): Promise<PageSnapshot> {
    const raw = await this.bridge.call<RawFrameSnapshot>("snapshot", {
      js: `(${SNAPSHOT_FN})(${JSON.stringify({ registry: this.registry, textOffset: opts.textOffset ?? 0, textLimit: opts.textLimit ?? 6000, maxElements: 150 })})`,
    });
    this.known = new Set(raw.info.map((_, i) => `e${i + 1}`));
    return {
      url: raw.url,
      title: raw.title,
      text: raw.text,
      totalText: raw.totalText,
      personalFilled: raw.personalFilled,
      html: raw.markers,
      status: raw.status,
      elements: raw.info.map((e, i) => ({ ...e, ref: `e${i + 1}` })),
    };
  }
  private index(ref: string): number {
    if (!this.known.has(ref)) throw new BrowserError(`référence ${ref} inconnue : relis la page`, "element_introuvable");
    return Number(ref.slice(1)) - 1;
  }
  click(ref: string): Promise<void> {
    return this.bridge.call("click", { registry: this.registry, index: this.index(ref) });
  }
  type(ref: string, text: string, opts: { submit?: boolean; secret?: boolean } = {}): Promise<void> {
    return this.bridge.call("type", { registry: this.registry, index: this.index(ref), text, submit: !!opts.submit, secret: !!opts.secret });
  }
  select(ref: string, value: string): Promise<void> {
    return this.bridge.call("select", { registry: this.registry, index: this.index(ref), value });
  }
  press(key: string): Promise<void> {
    return this.bridge.call("press", { key });
  }
  scroll(direction: "down" | "up"): Promise<void> {
    return this.bridge.call("scroll", { direction });
  }
  back(): Promise<void> {
    return this.bridge.call("back");
  }
  async screenshot(): Promise<Buffer> {
    const b64 = await this.bridge.call<string>("screenshot");
    return Buffer.from(b64, "base64");
  }
  async fillRole(role: FillRole, value: string, policy: FillPolicy = {}): Promise<boolean> {
    const credential = role === "username" || role === "password" || role === "totp";
    if (credential && (!policy.credentialSite || !siteMatchesHost(policy.credentialSite, await this.url()))) throw new BrowserError("la page n'est pas sur le site autorisé pour cet identifiant", "politique");
    const sels = FILL_SELECTORS[role] ?? [`input[autocomplete="${role.replace(/^personal:/, "")}"]`];
    return this.bridge.call("fill_role", { selectors: sels, value, role, credentialSite: policy.credentialSite });
  }
  storageState(): Promise<StorageState> {
    return this.bridge.call("storage_state");
  }
  async close(): Promise<void> {
    await this.bridge.call("close", {}, 8000).catch(() => {});
    this.bridge.kill();
  }
}

export class BridgeEngine implements BrowserEngine {
  readonly name = "nodriver";
  constructor(private readonly cfg: EngineConfig) {}

  async open(o: OpenOptions): Promise<PageDriver> {
    const script = new URL("../../../infra/browser/nodriver_bridge.py", import.meta.url).pathname;
    let child: ChildProcess;
    if (this.cfg.ssh) {
      // Hôte distant : le pont et son Chrome tournent là-bas, dans un écran virtuel.
      const remote = "cd ~/mella-browser && exec xvfb-run -a py/bin/python -u scripts/nodriver_bridge.py --chrome \"$(cat chrome/path)\"";
      child = spawn("sh", ["-c", `${this.cfg.ssh} '${remote}'`], { stdio: ["pipe", "pipe", "pipe"] });
    } else {
      const py = join(this.cfg.home, "py", "bin", "python");
      const args = ["-u", script, "--chrome", chromePath(this.cfg.home)];
      if (this.cfg.headless) args.push("--headless");
      child = spawn(py, args, { stdio: ["pipe", "pipe", "pipe"] });
    }
    const bridge = new Bridge(child);
    try {
      await bridge.call("start", { storageState: o.storageState ?? null, locale: o.locale ?? "fr-FR" }, 60_000);
    } catch (e) {
      bridge.kill();
      throw e instanceof BrowserError ? e : new BrowserError(String(e), "session_perdue");
    }
    return new BridgeDriver(this.name, bridge);
  }

  async close(): Promise<void> {}
}
