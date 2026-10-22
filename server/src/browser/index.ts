import { randomBytes } from "node:crypto";
import type { Db } from "../db.ts";
import type { Config } from "../config.ts";
import type { Llm } from "../llm.ts";
import type { User } from "../users.ts";
import { enqueue } from "../outbox.ts";
import { formatSkill, skillsForHost } from "../skills.ts";
import { bankResult, decideStep, describeScope, formatMoney, getTask, markAwaitingBank, recordStep, releasePayment } from "../tasks.ts";
import { vaultRuntime, type BrowserProvider } from "../vault/index.ts";
import { fillFromVault } from "../vault/inject.ts";
import type { VaultRef } from "../vault/types.ts";
import { askCode } from "./codes.ts";
import { progress } from "../progress.ts";
import { getPersonal, personalFor, personalLine } from "../personal.ts";
import { engineConfigFromEnv, makeEngine, type EngineConfig } from "./engines.ts";
import { ProfileStore } from "./profiles.ts";
import { runBrowserTask, type BrowserRunResult } from "./loop.ts";
import { BrowserError, type BrowserEngine, type PageDriver } from "./types.ts";

export { runBrowserTask, type BrowserRunResult, type BrowserHooks, type BrowserLimits } from "./loop.ts";
export { ProfileStore } from "./profiles.ts";
export { makeEngine, engineConfigFromEnv, ENGINES, type EngineName } from "./engines.ts";
export { takeCodeReply, extractCode } from "./codes.ts";
export type { PageDriver, BrowserEngine } from "./types.ts";

type Q = Pick<Db, "query">;

// Le contrôle humain exclut aussi le moteur de secours et le remplisseur du coffre.
const controls = new Map<string, { owner: SessionManager; human: boolean; count: number }>();
const pendingOperations = new Map<string, number>();
// Les deux moteurs partagent un profil : seul un contexte à jour peut le remplacer.
const profileVersions = new Map<string, number>();
const profileWrites = new Map<string, Promise<unknown>>();
const pending = (userId: string, delta: number) => {
  const count = (pendingOperations.get(userId) ?? 0) + delta;
  if (count) pendingOperations.set(userId, count);
  else pendingOperations.delete(userId);
};

async function updateProfile<T>(userId: string, write: () => Promise<T>): Promise<T> {
  const queued = (profileWrites.get(userId) ?? Promise.resolve()).catch(() => {}).then(write);
  profileWrites.set(userId, queued);
  try {
    return await queued;
  } finally {
    if (profileWrites.get(userId) === queued) profileWrites.delete(userId);
  }
}

/**
 * Une session de navigateur par personne, ouverte à la première tâche web, gardée ouverte un
 * moment pour les suites (« et dimanche ? »), puis fermée et son profil chiffré mis de côté.
 * Toute session a une fin : inactivité (10 min) et durée totale (30 min).
 */
export class SessionManager {
  private engine?: Promise<BrowserEngine>;
  private live = new Map<string, { page: PageDriver; opened: number; used: number; busy: boolean; profileVersion: number }>();
  private reaper?: NodeJS.Timeout;

  constructor(
    private readonly db: Q,
    private readonly profiles: ProfileStore,
    private readonly engineCfg: EngineConfig,
    private readonly opts: { idleMs: number; maxMs: number } = { idleMs: 10 * 60_000, maxMs: 30 * 60_000 },
    private readonly factory: (cfg: EngineConfig) => Promise<BrowserEngine> = makeEngine,
  ) {}

  get engineName(): string {
    return this.engineCfg.engine;
  }

  private assertAgentAccess(userId: string): void {
    const control = controls.get(userId);
    if (control?.human) throw new BrowserError("la personne a la main sur le navigateur", "politique");
    if (control && control.owner !== this) throw new BrowserError("une action navigateur est déjà en cours", "politique");
  }

  current(userId: string): PageDriver | undefined {
    this.assertAgentAccess(userId);
    const s = this.live.get(userId);
    return s?.profileVersion === (profileVersions.get(userId) ?? 0) ? s.page : undefined;
  }

  async open(userId: string): Promise<PageDriver> {
    this.assertAgentAccess(userId);
    pending(userId, 1);
    try {
      return await this.openPage(userId);
    } finally {
      pending(userId, -1);
    }
  }

  private async openPage(userId: string): Promise<PageDriver> {
    const s = this.live.get(userId);
    if (s?.profileVersion === (profileVersions.get(userId) ?? 0)) {
      s.used = Date.now();
      return s.page;
    }
    if (s) await this.discard(userId, false);
    this.engine ??= this.factory(this.engineCfg).catch((e) => {
      this.engine = undefined;
      throw e;
    });
    const engine = await this.engine;
    await profileWrites.get(userId)?.catch(() => {});
    const profileVersion = profileVersions.get(userId) ?? 0;
    const storageState = await this.profiles.load(this.db, userId);
    const page = await engine.open({ storageState, locale: "fr-FR", timezoneId: "Europe/Paris" });
    this.live.set(userId, { page, opened: Date.now(), used: Date.now(), busy: false, profileVersion });
    if (profileVersion !== (profileVersions.get(userId) ?? 0)) return this.openPage(userId);
    this.reaper ??= setInterval(() => void this.reap(), 30_000);
    this.reaper.unref?.();
    return page;
  }

  /** Garde le profil de la personne (cookies, stockage), chiffré. */
  async save(userId: string): Promise<void> {
    this.assertAgentAccess(userId);
    if (!this.live.has(userId)) return;
    pending(userId, 1);
    try {
      await this.persist(userId);
    } finally {
      pending(userId, -1);
    }
  }

  private async persist(userId: string): Promise<void> {
    const s = this.live.get(userId);
    if (!s) throw new BrowserError("la session navigateur a été fermée", "session_perdue");
    await updateProfile(userId, async () => {
      if (this.live.get(userId) !== s || s.profileVersion !== (profileVersions.get(userId) ?? 0)) return;
      await this.profiles.save(this.db, userId, await s.page.storageState());
      profileVersions.set(userId, ++s.profileVersion);
    });
  }

  setBusy(userId: string, busy: boolean): void {
    if (busy) {
      this.assertAgentAccess(userId);
      controls.set(userId, { owner: this, human: false, count: (controls.get(userId)?.count ?? 0) + 1 });
    } else {
      const control = controls.get(userId);
      if (control?.owner === this && !control.human && --control.count === 0) controls.delete(userId);
    }
    const s = this.live.get(userId);
    if (s) {
      s.busy = controls.get(userId)?.owner === this;
      s.used = Date.now();
    }
  }

  /** Réserve le navigateur avant tout await, sans interrompre une action agent en cours. */
  async takeOver(userId: string): Promise<PageDriver> {
    if (controls.has(userId) || pendingOperations.has(userId)) throw new BrowserError("le navigateur est occupé par une action en cours", "politique");
    controls.set(userId, { owner: this, human: true, count: 1 });
    try {
      return await this.openPage(userId);
    } catch (e) {
      controls.delete(userId);
      throw e;
    }
  }

  /** Une erreur de sauvegarde conserve la prise en main pour permettre une nouvelle tentative. */
  async finishTakeover(userId: string, save: boolean): Promise<void> {
    const control = controls.get(userId);
    if (!control?.human || control.owner !== this) throw new BrowserError("la prise en main a été fermée", "session_perdue");
    if (save) await this.persist(userId);
    else await this.discard(userId);
    controls.delete(userId);
  }

  private async discard(userId: string, releaseControl = true): Promise<void> {
    const s = this.live.get(userId);
    this.live.delete(userId);
    await s?.page.close().catch(() => {});
    if (releaseControl && controls.get(userId)?.owner === this) controls.delete(userId);
  }

  async close(userId: string): Promise<void> {
    if (!this.live.has(userId)) return;
    try {
      // Un arrêt pendant la saisie ne doit jamais enregistrer une connexion non validée.
      if (!controls.get(userId)?.human) await this.save(userId);
    } finally {
      await this.discard(userId);
    }
  }

  /** « Déconnecter = supprimer » : session fermée sans sauvegarde, profil effacé. */
  async forget(userId: string): Promise<boolean> {
    await this.discard(userId);
    return updateProfile(userId, async () => {
      const forgotten = await this.profiles.forget(this.db, userId);
      profileVersions.set(userId, (profileVersions.get(userId) ?? 0) + 1);
      return forgotten;
    });
  }

  async reap(): Promise<void> {
    const t = Date.now();
    for (const [userId, s] of this.live) {
      if (controls.get(userId)?.human) continue;
      if ((!s.busy && t - s.used > this.opts.idleMs) || t - s.opened > this.opts.maxMs) await this.close(userId).catch(() => {});
    }
  }

  async closeAll(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    for (const userId of [...this.live.keys()]) await this.close(userId);
    const e = await this.engine?.catch(() => undefined);
    await e?.close().catch(() => {});
    this.engine = undefined;
  }

  /** Pour l'outil vault_fill de l'agent principal : la page ouverte de la personne. */
  readonly provider: BrowserProvider = async (userId) => {
    const page = this.current(userId);
    if (!page) return undefined;
    return {
      url: async () => {
        this.assertAgentAccess(userId);
        return page.url();
      },
      fill: async (role, value, policy) => {
        this.assertAgentAccess(userId);
        pending(userId, 1);
        try {
          if (!(await page.fillRole(role, value, policy))) throw new BrowserError(`aucun champ « ${role} » sur une page autorisée`, "element_introuvable");
        } finally {
          pending(userId, -1);
        }
      },
    };
  };
}

export interface BrowserRuntime {
  db: Q;
  llm: Llm;
  cfg: Config;
  sessions: SessionManager;
  /** Second moteur (Camoufox par défaut) quand le premier se fait refuser par un anti-robot. */
  fallback?: SessionManager;
}

let runtime: BrowserRuntime | undefined;

export function installBrowserRuntime(r: BrowserRuntime | undefined): void {
  runtime = r;
}

export function browserRuntime(): BrowserRuntime | undefined {
  return runtime;
}

export function makeSessions(db: Q, cfg: Config, env: NodeJS.ProcessEnv = process.env): SessionManager {
  return new SessionManager(db, new ProfileStore(cfg.browser.profileKey), engineConfigFromEnv(env), { idleMs: cfg.browser.idleMs, maxMs: 30 * 60_000 });
}

/**
 * Le moteur de secours : un autre navigateur, une autre empreinte (Firefox au lieu de Chrome),
 * pour les sites dont l'anti-robot refuse le premier. MELLA_BROWSER_FALLBACK=none pour s'en passer.
 */
export function makeFallbackSessions(db: Q, cfg: Config, env: NodeJS.ProcessEnv = process.env): SessionManager | undefined {
  const engine = env.MELLA_BROWSER_FALLBACK ?? "camoufox";
  if (engine === "none" || engine === (env.MELLA_BROWSER_ENGINE ?? "patchright")) return undefined;
  return new SessionManager(
    db,
    new ProfileStore(cfg.browser.profileKey),
    engineConfigFromEnv({ ...env, MELLA_BROWSER_ENGINE: engine, MELLA_BROWSER_WS: env.MELLA_BROWSER_FALLBACK_WS ?? "" }),
    { idleMs: cfg.browser.idleMs, maxMs: 30 * 60_000 },
  );
}

/**
 * Banc des vrais parcours (MELLA_BENCH_DRY_RUN=1) : le navigateur fait tout pour de vrai, sur les vrais sites, et
 * s'arrête au bouton qui engage (réserver, payer). Les tentatives arrivent ici, le banc les lit.
 */
// Lu à chaque appel : le banc pose la variable après ses imports, une constante la voyait vide (réservations réelles, 20/10).
const dryRun = () => process.env.MELLA_BENCH_DRY_RUN === "1";
export const dryRunCommits: Array<{ userId: string; action: string; amountCents: number; detail?: string; url: string; at: Date }> = [];

/**
 * L'outil `browse` de l'agent principal : ouvre (ou reprend) la session de la personne, lance la
 * boucle, garde le profil, journalise. Sans tâche validée, lecture seule. Si un anti-robot a
 * bloqué la tâche, elle repart une fois avec le moteur de secours, dans ce qui reste du budget.
 */
export async function browseForUser(
  user: User,
  p: { objective: string; startUrl?: string; taskId?: string; maxSteps?: number; prelude?: (page: import("./types.ts").PageDriver) => Promise<unknown> },
): Promise<BrowserRunResult & { engine: string }> {
  const rt = browserRuntime();
  if (!rt) throw new BrowserError("navigateur non branché sur ce serveur", "politique");
  const { db, cfg } = rt;
  const task = p.taskId ? await getTask(db, user.id, p.taskId) : undefined;
  if (p.taskId && !task) throw new BrowserError("tâche introuvable", "politique");
  if (task && task.status !== "authorized") throw new BrowserError(`la tâche n'est pas validée (${task.status})`, "politique");

  const limits = { maxSteps: Math.min(cfg.browser.maxSteps, p.maxSteps ?? Infinity), maxMs: cfg.browser.maxMs, maxCostUsd: cfg.browser.maxCostUsd };
  const first = await browseWith(rt, rt.sessions, user, task, p, limits);
  const blocked = first.status !== "done" && first.blocks.length > 0;
  if (!blocked || !rt.fallback) return first;

  const hosts = [...new Set(first.blocks.map((b) => hostOf(b.url)))].join(", ");
  const left = {
    maxSteps: Math.max(10, limits.maxSteps - first.steps),
    maxMs: Math.max(90_000, limits.maxMs - first.ms),
    maxCostUsd: Math.max(0.15, limits.maxCostUsd - first.costUsd),
  };
  try {
    const second = await browseWith(rt, rt.fallback, user, task, { ...p, objective: `${p.objective}\n(Un premier navigateur a été refusé par l'anti-robot de ${hosts}.)` }, left);
    return {
      ...second,
      ms: first.ms + second.ms,
      costUsd: first.costUsd + second.costUsd,
      steps: first.steps + second.steps,
      errors: [...first.errors, ...second.errors],
      blocks: [...first.blocks, ...second.blocks],
      pages: [...first.pages, ...second.pages],
      engine: `${rt.sessions.engineName} puis ${rt.fallback.engineName}`,
    };
  } catch {
    return first; // le secours ne démarre pas : on rend le premier compte rendu, honnête
  }
}

function hostOf(u: string): string {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return u;
  }
}

async function browseWith(
  rt: BrowserRuntime,
  sessions: SessionManager,
  user: User,
  task: Awaited<ReturnType<typeof getTask>>,
  p: { objective: string; startUrl?: string; prelude?: (page: import("./types.ts").PageDriver) => Promise<unknown> },
  limits: { maxSteps: number; maxMs: number; maxCostUsd: number },
): Promise<BrowserRunResult & { engine: string }> {
  const { db, llm, cfg } = rt;
  const page = await sessions.open(user.id);
  sessions.setBusy(user.id, true);
  const runStart = new Date();
  try {
    // Partir de la page de résultats d'une recherche de site (parcours enregistré, fiable), puis laisser le
    // navigateur libre faire la suite : choisir, réserver, payer. Si la recherche casse, il part de zéro.
    let prepared = false;
    if (p.prelude) {
      try {
        await p.prelude(page);
        prepared = true;
      } catch {}
    }
    // Même tâche, page restée ouverte (panier, formulaire en cours) : le plan peut choisir d'en repartir au lieu de tout refaire.
    const openUrl = task && !prepared && !p.startUrl ? await page.url().then((u) => (/^https?:/.test(u) ? u : undefined)).catch(() => undefined) : undefined;
    const result = await runBrowserTask(
      {
        llm,
        cfg,
        page,
        hooks: {
          notify: (text) => progress(db, user.id, text),
          playbook: async (host) => {
            const found = await skillsForHost(db, user.id, host);
            return found.length ? found.map(formatSkill).join("\n\n") : undefined;
          },
          confirmation: async (jpeg) => {
            const token = randomBytes(24).toString("base64url");
            await db.query(`INSERT INTO shots (token, user_id, mime, data) VALUES ($1, $2, 'image/jpeg', $3)`, [token, user.id, jpeg]);
            await enqueue(db, [{ userId: user.id, kind: "image", text: `${cfg.publicUrl.replace(/\/+$/, "")}/s/${token}` }]);
          },
          askCode: (question) => askCode(db, { userId: user.id, taskId: task?.id, question }),
          vaultFill: async (ref) => {
            if (!task) return { ok: false, message: "refusé : se connecter demande une tâche validée qui inclut log_in" };
            // Banc des vrais parcours : tout est fait pour de vrai jusqu'au moment de mettre la carte, et on s'arrête là.
            if (dryRun() && ref.startsWith("vault://card/")) {
              dryRunCommits.push({ userId: user.id, action: "carte", amountCents: 0, detail: ref, url: await page.url().catch(() => ""), at: new Date() });
              return { ok: false, message: "essai : arrêt juste avant de mettre la carte. Rends compte avec done : ce qui allait être payé, le total exact affiché, et l'échéance s'il y en a une" };
            }
            const { vault } = vaultRuntime();
            if (ref.startsWith("vault://card/")) {
              // La carte suit la règle du paiement (tâche validée, pay couvert, pas de paiement déjà en attente),
              // sans rien dépenser : la dépense se compte au clic sur « Payer », contre le plafond.
              const fresh = (await getTask(db, user.id, task.id)) ?? task;
              const d = decideStep(fresh, "pay", 0);
              if (d.decision === "needs_approval") return { ok: false, message: `refusé : ${d.reason}` };
            } else {
              const kind = ref.startsWith("vault://personal/") ? "fill_personal" : "log_in";
              const d = await recordStep(db, task, { action: kind, amountCents: 0, detail: ref });
              if (d.decision !== "allowed") return { ok: false, message: `refusé : ${d.decision === "needs_approval" ? d.reason : d.decision}` };
            }
            try {
              const r = await fillFromVault(db, vault, sessions.provider, { userId: user.id, taskId: task.id, ref: ref as VaultRef });
              if (r.status === "filled") return { ok: true, message: `rempli : ${r.fields.join(", ")}` };
              return { ok: false, message: r.status === "missing" ? `rien au coffre pour ${ref} : arrête-toi, Mell enverra un lien pour l'ajouter` : "navigateur indisponible" };
            } catch (e) {
              return { ok: false, message: `refusé : ${e instanceof Error ? e.message : String(e)}` };
            }
          },
          commit: async (action, amountCents, detail) => {
            if (!task) return { decision: "needs_approval", reason: "lecture seule" };
            // Banc des vrais parcours : on va jusqu'au bouton qui engage, jamais au-delà.
            if (dryRun()) {
              dryRunCommits.push({ userId: user.id, action, amountCents, detail, url: await page.url().catch(() => ""), at: new Date() });
              return { decision: "needs_approval", reason: "essai : arrêt juste avant le bouton qui engage. Rends compte avec done : ce qui allait être réservé ou payé, le total exact, et l'échéance affichée s'il y en a une" };
            }
            const fresh = (await getTask(db, user.id, task.id)) ?? task;
            const d = await recordStep(db, fresh, { action, amountCents, detail }, { bank: false });
            return d.decision === "needs_approval" ? { decision: d.decision, reason: d.reason } : { decision: d.decision };
          },
          bank: task
            ? {
                started: async (amountCents, host) => {
                  await markAwaitingBank(db, task.id);
                  const fr = user.lang !== "en";
                  const amount = amountCents > 0 ? formatMoney(amountCents, task.currency) : "";
                  const where = host ? (fr ? ` sur ${host}` : ` on ${host}`) : "";
                  const text = fr
                    ? `Valide le paiement${amount ? ` de ${amount}` : ""}${where} dans l'appli de ta banque, je finis dès que c'est passé.`
                    : `Approve the${amount ? ` ${amount}` : ""} payment${where} in your bank's app, I'll finish as soon as it's through.`;
                  await enqueue(db, [{ userId: user.id, kind: "text", text }]);
                },
                remind: async () => {
                  const text = user.lang === "en" ? "Still waiting on your bank for that payment." : "J'attends toujours ta banque pour ce paiement.";
                  await enqueue(db, [{ userId: user.id, kind: "text", text }]);
                },
                result: async (outcome) => {
                  await bankResult(db, task.id, outcome === "approved");
                },
              }
            : undefined,
        },
      },
      {
        objective: prepared ? `${p.objective}\n(La page ouverte est déjà la page de résultats de cette recherche : pars d'elle, ne refais pas la recherche.)` : p.objective,
        startUrl: p.startUrl,
        stayOnPage: prepared,
        openUrl,
        personal: task ? personalLine(await personalFor(db, user)) || undefined : undefined,
        lang: user.lang,
        timezone: user.timezone,
        task: task ? { id: task.id, scope: describeScope(task), actions: task.actions } : undefined,
        cards: task?.actions.includes("pay")
          ? (await db.query<{ ref: string }>(`SELECT ref FROM vault_entries WHERE user_id = $1 AND kind = 'card' ORDER BY updated_at DESC`, [user.id])).rows.map((r) => r.ref)
          : undefined,
      },
      limits,
    );
    await db.query(
      `INSERT INTO browser_runs (user_id, task_id, engine, objective, status, answer, reason, steps, duration_ms, cost_usd, errors, pages)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [user.id, task?.id ?? null, sessions.engineName, p.objective.slice(0, 1000), result.status, result.answer ?? null, result.reason ?? null, result.steps, result.ms, result.costUsd.toFixed(5), JSON.stringify(result.errors.slice(0, 50)), JSON.stringify(result.pages.slice(0, 30))],
    );
    // Un paiement lancé qui n'a pas abouti (code jamais reçu, page fermée) ne doit pas laisser la tâche « en attente de
    // la banque » : sinon toute nouvelle tentative, même avec une autre carte, était refusée (19/10).
    if (task && result.status !== "done") await releasePayment(db, task.id, runStart);
    return { ...result, engine: sessions.engineName };
  } finally {
    sessions.setBusy(user.id, false);
    await sessions.save(user.id);
  }
}
