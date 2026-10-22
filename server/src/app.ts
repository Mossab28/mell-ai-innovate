import { setToolsConfig } from "./tools.ts";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { LINE_HEADER, SIGNATURE_HEADER, verify, type AckRequest, type InboundBatch } from "@mella/shared";
import type { Config } from "./config.ts";
import { openDb, migrate, type Db } from "./db.ts";
import { makeLlm, type Llm } from "./llm.ts";
import { getLine, pickLine, seedLines, touchLine, upsertLine } from "./lines.ts";
import { addContactBubble, findOrCreateUser, getUser, mellVCard, welcomeItems } from "./users.ts";
import { enqueue, waitAndClaim, ack, outboxEvents } from "./outbox.ts";
import { claimTurns, handleTurn, releaseTurn, runJobs, createJob } from "./agent.ts";
import { runDue } from "./schedules.ts";
import { runBatch } from "./batch.ts";
import { runWatches } from "./watches.ts";
import { planPulses } from "./pulse.ts";
import { warmTrains } from "./trains/gtfs.ts";
import { admitFromWaitlist, createInvite, stillWaitingBubble, waitlistBubbles } from "./invites.ts";
import { registerInviteRoutes } from "./invite-web.ts";
import { registerConnectRoutes } from "./apps/web.ts";
import { registerAccountRoutes } from "./web/account.ts";
import { registerAccessRoutes } from "./web/access.ts";
import { join } from "node:path";
import { registerBrandRoutes } from "./web/da.ts";
import { installWebBotAuth, makeWebBotAuth, webBotAuth } from "./webbotauth.ts";
import { registerCardRoutes, saveCards, sendCards } from "./cards.ts";
import { registerLiveRoutes } from "./browser/live.ts";
import { bankResult, describeScope } from "./tasks.ts";
import { installVaultRuntime, makeVault, noBrowser, type BrowserProvider, type VaultService } from "./vault/index.ts";
import { registerVaultRoutes } from "./vault/web.ts";
import { screenInbound, stashCaughtSecret } from "./vault/thread.ts";
import { installBrowserRuntime, makeFallbackSessions, makeSessions, type SessionManager } from "./browser/index.ts";
import { installGoogleRuntime, makeGoogle, registerGoogleRoutes } from "./google/index.ts";
import { ensureAddress, installMailRuntime, mailOn, runInbox, startSmtp } from "./mail/index.ts";
import { AppsService, Composio, installAppsRuntime } from "./apps/index.ts";
import { installPreview, registerPreviewRoute } from "./preview.ts";
import type { AppsService as AppsServiceType } from "./apps/index.ts";

export interface App {
  http: FastifyInstance;
  db: Db;
  llm: Llm;
  vault: VaultService;
  /** Un passage de chaque boucle de fond. Les tests l'appellent à la main. */
  tick(): Promise<void>;
  start(): Promise<string>;
  stop(): Promise<void>;
}

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export async function createApp(
  cfg: Config,
  deps: { db?: Db; llm?: Llm; vault?: VaultService; browser?: BrowserProvider; sessions?: SessionManager; apps?: AppsServiceType } = {},
): Promise<App> {
  const db = deps.db ?? (await openDb(cfg.databaseUrl));
  await migrate(db);
  setToolsConfig(cfg);
  await seedLines(db, cfg.seedLines);
  const llm = deps.llm ?? makeLlm(cfg);
  const vault = deps.vault ?? makeVault(cfg);
  // Le navigateur ne démarre qu'à la première tâche web : un serveur sans tâche n'en lance aucun.
  const sessions = cfg.browser.enabled ? (deps.sessions ?? makeSessions(db, cfg)) : undefined;
  // Moteur de secours (Camoufox) pour les sites qui refusent Chrome ; pas de secours si on injecte les sessions (tests).
  const fallback = sessions && !deps.sessions ? makeFallbackSessions(db, cfg) : undefined;
  installBrowserRuntime(sessions ? { db, llm, cfg, sessions, fallback } : undefined);
  installVaultRuntime({ vault, publicUrl: cfg.publicUrl, browser: deps.browser ?? sessions?.provider ?? noBrowser });

  // forceCloseConnections : à l'arrêt, on coupe aussi les long-polls des relais, qui se reconnectent.
  const http = Fastify({
    // L'aperçu de lien passe ses données signées dans le chemin (/pv/<base64>.png) : le défaut de 100 est trop court.
    maxParamLength: 4000,
    logger: {
      level: cfg.logLevel,
      serializers: {
        req: (req) => ({
          method: req.method,
          // Les liens du coffre et les callbacks sont des capacités. Aucun jeton dans les logs.
          url: String(req.url ?? "").split(/[?#]/, 1)[0].replace(/^\/(v|l|c|i)\/[^/]+/, "/$1/[redacted]"),
        }),
      },
    },
    forceCloseConnections: true,
  });
  // Gmail + Agenda. Sans client OAuth (ni environnement, ni coffre), le serveur démarre et l'outil le dit.
  const google = makeGoogle(cfg, vault, (msg, err) => http.log.warn({ err: err instanceof Error ? err.message : err }, msg));
  installGoogleRuntime(google);
  // Adresse mail de Mell pour chaque personne. Sans domaine configuré, rien n'est proposé.
  installMailRuntime(mailOn(cfg) ? { db, cfg } : undefined);
  // Connecteurs d'applications via Composio (Gmail/Agenda sans écran rouge, + Notion, Slack, Trello...).
  const composio = Composio.fromKey(cfg.composioApiKey);
  const apps = deps.apps ?? (composio ? new AppsService(composio, (msg, err) => http.log.warn({ err: err instanceof Error ? err.message : err }, msg), cfg.publicUrl) : undefined);
  installAppsRuntime(apps);
  if (apps) google.useComposio((accountId, service) => apps.transport(accountId, service));
  // On garde le corps brut : la signature HMAC porte dessus.
  http.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  /** Vérifie que l'appel vient bien du relais de la ligne annoncée. */
  async function lineFrom(req: FastifyRequest): Promise<string | undefined> {
    const id = req.headers[LINE_HEADER] as string | undefined;
    const line = id ? await getLine(db, id) : undefined;
    if (!line || !line.active) return undefined;
    const payload = req.method === "GET" ? req.url : (req.rawBody ?? "");
    if (!verify(line.secret, payload, req.headers[SIGNATURE_HEADER] as string | undefined)) return undefined;
    await touchLine(db, line.id);
    return line.id;
  }

  function isAdmin(req: FastifyRequest): boolean {
    return !!cfg.adminToken && req.headers.authorization === `Bearer ${cfg.adminToken}`;
  }

  installPreview(cfg);
  registerPreviewRoute(http);
  http.get("/health", async () => ({ ok: true }));
  // Saisie au coffre par lien à usage unique (/v/:token).
  await registerVaultRoutes(http, { db, cfg, vault });
  // Connexion Google par lien à usage unique (/connect/google), retour de Google (/connect/google/callback).
  await registerGoogleRoutes(http, { db, google });

  // Les photos et vocaux arrivent avec le message : jusqu'à 4 pièces de 12 Mo, en base64.
  http.post("/relay/inbound", { bodyLimit: 80 * 1024 * 1024 }, async (req, reply) => {
    const lineId = await lineFrom(req);
    if (!lineId) return reply.code(401).send({ error: "signature invalide" });
    const body = req.body as InboundBatch;
    let accepted = 0;
    for (const m of body.messages ?? []) {
      if (!m.guid || !m.from) continue;
      const files = (m.attachments ?? []).filter((a) => a.kind === "image" || a.kind === "audio" || a.kind === "file").slice(0, 4);
      await db.tx(async (q) => {
        const { user, created } = await findOrCreateUser(q, m.from, lineId, m.text, { inviteOnly: cfg.invites.only });
        const waiting = user.status === "waitlist";
        // Un mot de passe, une clé 2FA ou une carte tapés dans le fil n'atteignent ni la base ni le modèle.
        const screen = screenInbound(m.text);
        const { rows } = await q.query<{ id: number }>(
          `INSERT INTO messages (user_id, direction, guid, text, tapback, target_guid, processed_at)
           VALUES ($1, 'in', $2, $3, $4, $5, CASE WHEN $6 THEN now() END)
           ON CONFLICT (guid) DO NOTHING RETURNING id`,
          [user.id, m.guid, screen.text ?? null, m.tapback && !m.tapback.removed ? m.tapback.kind : null, m.tapback?.targetGuid ?? null, waiting || (created && !files.length) || !!m.tapback?.removed || screen.handled],
        );
        if (!rows.length) return; // déjà reçu : le relais rejoue après une coupure
        accepted++;
        for (const f of waiting ? [] : files) {
          await q.query(`INSERT INTO attachments (user_id, message_id, kind, mime, name, data, transcript) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
            user.id,
            Number(rows[0].id),
            f.kind,
            String(f.mime ?? "").slice(0, 100),
            f.name ? String(f.name).slice(0, 200) : null,
            f.data ? Buffer.from(f.data, "base64") : null,
            f.transcript ? String(f.transcript).slice(0, 8000) : null,
          ]);
        }
        if (screen.caught) await stashCaughtSecret(q, vault, cfg, user, { messageId: Number(rows[0].id), guid: m.guid, caught: screen.caught });
        // La personne répond toujours par la ligne sur laquelle elle a écrit en dernier.
        await q.query(`UPDATE users SET line_id = $2 WHERE id = $1 AND line_id <> $2`, [user.id, lineId]);
        if (waiting) {
          // Sur la liste : une réponse à l'arrivée, puis au plus une par jour, sans modèle.
          if (created) {
            await enqueue(q, waitlistBubbles(user.lang).map((b, i) => ({ userId: user.id, kind: "text" as const, text: b.text, effect: b.effect, dedupeKey: `waitlist:${user.id}:${i}` })));
          } else if (!m.tapback) {
            const { rows: nudge } = await q.query(
              `UPDATE users SET waitlist_nudged_at = now() WHERE id = $1 AND (waitlist_nudged_at IS NULL OR waitlist_nudged_at < now() - interval '24 hours') RETURNING id`,
              [user.id],
            );
            if (nudge.length) await enqueue(q, [{ userId: user.id, kind: "text", text: stillWaitingBubble(user.lang) }]);
          }
        } else if (created) {
          // Le handle de la ligne, lu sur la connexion de la transaction (jamais le pool : PGlite se bloquerait).
          const line = (await q.query<{ handle: string }>(`SELECT handle FROM lines WHERE id = $1`, [lineId])).rows[0];
          await enqueue(q, welcomeItems(user.id, user.lang, line?.handle));
        }
      });
    }
    // Les envois ajoutés dans la transaction (accueil) partent tout de suite, et le tour est
    // pris dès la fin de l'anti-rebond plutôt qu'au prochain passage de la boucle.
    if (accepted) {
      outboxEvents.emit(lineId);
      setTimeout(() => wakers.get("turns")?.(), cfg.debounceMs + 25);
    }
    return { accepted };
  });

  http.get("/relay/outbox", async (req, reply) => {
    const lineId = await lineFrom(req);
    if (!lineId) return reply.code(401).send({ error: "signature invalide" });
    const wait = Number((req.query as any).wait ?? 25_000);
    return { messages: await waitAndClaim(db, lineId, wait) };
  });

  http.post("/relay/ack", async (req, reply) => {
    const lineId = await lineFrom(req);
    if (!lineId) return reply.code(401).send({ error: "signature invalide" });
    await ack(db, lineId, (req.body as AckRequest).results ?? []);
    return { ok: true };
  });

  /** Pour la page murmell.com/mella : à quel numéro écrire, avec quel texte pré-rempli. */
  http.get("/api/start", async (req, reply) => {
    const q = req.query as { code?: string; lang?: string; ua?: string };
    const line = await pickLine(db);
    if (!line) return reply.code(503).send({ error: "complet pour l'instant" });
    const code = /^[a-z0-9]{4,8}$/i.test(q.code ?? "") ? ` (${q.code!.toLowerCase()})` : "";
    const body = `${q.lang === "en" ? "Hi Mell!" : "Salut Mell !"}${code}`;
    const isAndroid = /android/i.test(q.ua ?? (req.headers["user-agent"] as string) ?? "");
    const sms = `sms:${line.handle}${isAndroid ? "?" : "&"}body=${encodeURIComponent(body)}`;
    return { phone: line.handle, body, sms };
  });

  /** Stock d'invitations pour un créateur ou une campagne : { uses, label?, code? } -> le lien à partager. */
  http.post("/admin/invites", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const b = req.body as { uses?: number; label?: string; code?: string };
    const code = await createInvite(db, { uses: Number(b.uses ?? 50), label: b.label, code: b.code });
    return { code, link: `${cfg.publicUrl.replace(/\/+$/, "")}/i/${code}` };
  });

  /** Fait entrer les N premières personnes de la liste d'attente ; Mell leur écrit tout de suite. */
  http.post("/admin/admit", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const ids = await admitFromWaitlist(db, Number((req.body as { count?: number }).count ?? 10));
    for (const id of ids) {
      const u = await getUser(db, id);
      const line = await getLine(db, u.line_id);
      await enqueue(db, welcomeItems(id, u.lang, line?.handle));
    }
    const lines = new Set((await Promise.all(ids.map((id) => getUser(db, id)))).map((u) => u.line_id));
    for (const l of lines) outboxEvents.emit(l);
    const left = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE status = 'waitlist'`)).rows[0].n;
    return { admitted: ids.length, waiting: left };
  });

  // Lien d'invitation partageable (/i/:code) : ouvre Messages avec le texte et le code pré-remplis.
  await registerBrandRoutes(http);
  // Adresse inconnue : une vraie page aux couleurs de Mell pour un navigateur, du JSON pour le reste.
  http.setNotFoundHandler(async (req, reply) => {
    if (!String(req.headers.accept ?? "").includes("text/html")) return reply.code(404).send({ error: "introuvable" });
    const { page, logoSvg, INK, siteLang } = await import("./web/da.ts");
    const en = siteLang(req) === "en";
    return reply
      .code(404)
      .headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      .send(
        page({
          lang: en ? "en" : "fr",
          title: "Mell",
          body: `<a class="corner l" href="/" aria-label="Mell">${logoSvg(INK, 30).replace("<svg ", '<svg class="m" ')}</a><div class="doc"><h1>${en ? "Nothing here" : "Rien ici"}</h1><p>${en ? "This page doesn't exist, or the link has expired. If Mell sent it, ask for a new one in the thread." : "Cette page n'existe pas, ou le lien a expiré. Si Mell te l'a envoyé, redemande-le dans le fil."}</p><p><a href="/">askmell.com</a></p></div>`,
        }),
      );
  });
  // Web Bot Auth : Mell se présente aux sites (clé publiée ici, requêtes signées par le navigateur).
  installWebBotAuth(makeWebBotAuth(process.env.MELLA_WBA_KEY || undefined, cfg.publicUrl));
  http.get("/.well-known/http-message-signatures-directory", async (req, reply) => {
    const w = webBotAuth();
    if (!w) return reply.code(404).send();
    const d = w.directory(String(req.headers.host ?? new URL(cfg.publicUrl).host));
    return reply.code(200).headers(d.headers).send(Buffer.from(d.body)); // Buffer : Fastify n'ajoute pas « ; charset », le type doit être exact
  });
  await registerInviteRoutes(http, { db, publicUrl: cfg.publicUrl });
  await registerConnectRoutes(http, { db, apps });
  await registerAccountRoutes(http, { db, cfg, apps, vault, wake: (lineId) => outboxEvents.emit(lineId) });
  // Demande d'accès (numéro + mail gardés), /admin pour accorder, /login pour le code d'un compte existant.
  await registerAccessRoutes(http, { db, cfg });
  // Captures envoyées dans le fil (confirmation de réservation) : un lien imprévisible, 30 jours.
  http.get("/s/:token", async (req, reply) => {
    const token = String((req.params as { token: string }).token ?? "");
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return reply.code(404).send();
    const r = (await db.query<{ mime: string; data: Buffer }>(`SELECT mime, data FROM shots WHERE token = $1 AND created_at > now() - interval '30 days'`, [token])).rows[0];
    if (!r) return reply.code(404).send();
    return reply.headers({ "content-type": r.mime, "cache-control": "private, max-age=3600", "referrer-policy": "no-referrer" }).send(Buffer.from(r.data));
  });

  /** Efface une personne (coffre, apps, puis tout par cascade) : pour repartir de zéro sur un compte de test. { handle } */
  http.post("/admin/users/delete", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const handle = String((req.body as { handle?: string }).handle ?? "");
    const u = (await db.query<{ id: string }>(`SELECT id FROM users WHERE handle = $1`, [handle])).rows[0];
    if (!u) return reply.code(404).send({ error: "inconnu" });
    if (vault) for (const e of await vault.list(db, u.id)) await vault.deleteEntry(db, u.id, e.ref, { actor: "user_link", detail: "admin-delete" }).catch(() => false);
    if (apps) for (const a of await apps.connected(db, u.id)) await apps.disconnect(db, u.id, a.service).catch(() => false);
    await db.query(`DELETE FROM users WHERE id = $1`, [u.id]);
    await db.query(`UPDATE access_requests SET user_id = NULL WHERE user_id = $1`, [u.id]).catch(() => {});
    return { deleted: handle };
  });
  /**
   * Remet la conversation d'une personne à zéro sans toucher à son compte : le fil, les travaux, tâches, rappels,
   * surveillances et ce que Mell a retenu s'effacent ; son coffre, ses apps connectées et ses infos perso restent.
   * `scope: "fil"` n'efface que la conversation (fil, travaux, tâches, résultats d'outils, fiche de reprise) : ses
   * souvenirs, rappels et surveillances restent (21/10 : repartir d'un fil neuf sans perdre ce que Mell sait d'elle).
   */
  http.post("/admin/users/reset", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const body = req.body as { handle?: string; scope?: string };
    const handle = String(body.handle ?? "");
    const kept = body.scope === "fil" ? new Set(["schedules", "watches", "memories"]) : new Set<string>();
    const u = (await db.query<{ id: string }>(`SELECT id FROM users WHERE handle = $1`, [handle])).rows[0];
    if (!u) return reply.code(404).send({ error: "inconnu" });
    const cleared: string[] = [];
    await db.tx(async (q) => {
      await q.query(`DELETE FROM task_steps WHERE task_id IN (SELECT id FROM tasks WHERE user_id = $1)`, [u.id]);
      await q.query(`DELETE FROM outbound_mail WHERE task_id IN (SELECT id FROM tasks WHERE user_id = $1)`, [u.id]);
      for (const t of ["attachments", "messages", "outbox", "jobs", "batch_jobs", "tasks", "schedules", "watches", "memories", "router_decisions", "tool_calls", "cards", "shots", "browser_waits"]) {
        if (kept.has(t)) continue;
        await q.query(`DELETE FROM ${t} WHERE user_id = $1`, [u.id]);
        cleared.push(t);
      }
      await q.query(`UPDATE users SET turn_lock_until = NULL, thread_summary = NULL, thread_summary_upto = 0, thread_summary_at = NULL WHERE id = $1`, [u.id]);
    });
    return { reset: handle, cleared };
  });
  /**
   * La veille de toutes les personnes depuis `minutes` (60 par défaut) : ce qui n'est pas parti ou reste coincé, les
   * messages restés sans réponse, les travaux ratés, le navigateur arrêté avant la fin. Lue toutes les 30 min (22/10).
   */
  http.get("/admin/watch", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const minutes = Math.min(1440, Math.max(5, Number((req.query as { minutes?: string }).minutes ?? 60)));
    const since = `now() - make_interval(mins => ${minutes})`;
    const rows = async (sql: string) => (await db.query(sql)).rows;
    return {
      minutes,
      users: (await rows(`SELECT count(*)::int AS n FROM users WHERE status = 'active'`))[0].n,
      inbound: (await rows(`SELECT count(*)::int AS n FROM messages WHERE direction = 'in' AND sent_at > ${since}`))[0].n,
      failed_sends: await rows(`SELECT u.handle, o.kind, left(o.error, 160) AS error, o.created_at FROM outbox o JOIN users u ON u.id = o.user_id WHERE o.status = 'failed' AND o.created_at > ${since} ORDER BY o.id`),
      stuck_sends: await rows(`SELECT u.handle, o.kind, o.status, o.attempts, o.created_at FROM outbox o JOIN users u ON u.id = o.user_id WHERE o.status IN ('queued', 'claimed') AND o.created_at < now() - interval '5 minutes' AND (o.not_before IS NULL OR o.not_before < now()) ORDER BY o.id`),
      unanswered: await rows(`SELECT u.handle, left(m.text, 120) AS text, m.sent_at FROM messages m JOIN users u ON u.id = m.user_id WHERE m.direction = 'in' AND m.sent_at > ${since} AND m.sent_at < now() - interval '3 minutes' AND m.processed_at IS NULL ORDER BY m.id`),
      failed_jobs: await rows(`SELECT u.handle, left(j.request, 160) AS request, left(j.error, 200) AS error, j.created_at FROM jobs j JOIN users u ON u.id = j.user_id WHERE j.status = 'failed' AND j.created_at > ${since} ORDER BY j.created_at`),
      overdue_jobs: await rows(`SELECT u.handle, left(j.request, 160) AS request, j.created_at FROM jobs j JOIN users u ON u.id = j.user_id WHERE j.status IN ('queued', 'running') AND j.deadline_at < now() ORDER BY j.created_at`),
      browser_stopped: await rows(`SELECT u.handle, b.status, left(b.reason, 120) AS reason, b.steps, b.cost_usd, left(b.objective, 140) AS objective, b.created_at FROM browser_runs b JOIN users u ON u.id = b.user_id WHERE b.status <> 'done' AND b.created_at > ${since} ORDER BY b.created_at`),
    };
  });
  /** Remet en file ce qui n'est pas parti pour une personne (envois abandonnés, ligne en panne) : la ligne les reprend. */
  http.post("/admin/outbox/retry", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const handle = String((req.body as { handle?: string }).handle ?? "");
    const u = (await db.query<{ id: string }>(`SELECT id FROM users WHERE handle = $1`, [handle])).rows[0];
    if (!u) return reply.code(404).send({ error: "inconnu" });
    const { rows } = await db.query(`UPDATE outbox SET status = 'queued', attempts = 0, error = NULL, claimed_until = NULL WHERE user_id = $1 AND status = 'failed' RETURNING id`, [u.id]);
    return { requeued: rows.length };
  });
  // Cartes (/c/:id) : une option avec sa photo ; « Je prends celui-là » revient à Mell comme un message.
  await registerCardRoutes(http, { db, cfg, wake: () => wakers.get("turns")?.() });
  // Connexion en direct (/l/:token) : la vraie page du site sur son téléphone, elle se connecte elle-même.
  await registerLiveRoutes(http, { db, cfg });

  /** Qui utilise Mell : numéro, prénom, statut, et son adresse mail Mell. */
  http.get("/admin/users", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const { rows } = await db.query(`SELECT id, handle, name, status, created_at FROM users ORDER BY created_at LIMIT 500`);
    return { users: await Promise.all(rows.map(async (u: any) => ({ handle: u.handle, name: u.name, status: u.status, created_at: u.created_at, mail_address: await ensureAddress(db, cfg, await getUser(db, u.id)) }))) };
  });

  /** Envoie (ou renvoie) la fiche contact Mell dans le fil d'une personne, pour tester l'aperçu des cartes. */
  http.post("/admin/contact-card", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const b = req.body as { handle?: string };
    const u = (await db.query<{ id: string; line_id: string; lang: string }>(`SELECT id, line_id, lang FROM users WHERE handle = $1`, [String(b.handle ?? "")])).rows[0];
    if (!u) return reply.code(404).send({ error: "personne inconnue" });
    const line = await getLine(db, u.line_id);
    if (!line) return reply.code(404).send({ error: "ligne inconnue" });
    await enqueue(db, [
      { userId: u.id, kind: "text", text: addContactBubble(u.lang), dedupeKey: `contact-intro:${Date.now()}` },
      { userId: u.id, kind: "contact", text: mellVCard(line.handle, u.lang), dedupeKey: `contact-card:${Date.now()}` },
    ]);
    outboxEvents.emit(u.line_id);
    return { ok: true };
  });

  /** Envoie un texte (ou un lien seul, rendu en vrai aperçu natif) dans le fil d'une personne, pour tester. */
  http.post("/admin/say", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const b = req.body as { handle?: string; text?: string };
    const u = (await db.query<{ id: string; line_id: string }>(`SELECT id, line_id FROM users WHERE handle = $1`, [String(b.handle ?? "")])).rows[0];
    if (!u || !b.text) return reply.code(404).send({ error: "personne inconnue ou texte vide" });
    const image = (b as { image?: string }).image;
    await enqueue(db, [image ? { userId: u.id, kind: "card", image: String(image), text: String(b.text).slice(0, 2000) } : { userId: u.id, kind: "text", text: String(b.text).slice(0, 2000) }]);
    outboxEvents.emit(u.line_id);
    return { ok: true };
  });

  /** Dépannage : envoie un lien du coffre (login, totp, personal, card) à une personne, avec sa carte, comme le ferait Mell. */
  http.post("/admin/vault-link", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const b = req.body as { handle?: string; kind?: string; site?: string; text?: string; silent?: boolean };
    const u = await db.query<{ id: string; line_id: string; lang: string }>(`SELECT id, line_id, lang FROM users WHERE handle = $1`, [String(b.handle ?? "")]);
    const user = u.rows[0];
    if (!user) return reply.code(404).send({ error: "personne inconnue" });
    const kind = String(b.kind ?? "login");
    if (!["login", "totp", "personal", "card"].includes(kind)) return reply.code(400).send({ error: "type invalide" });
    const { issueLink } = await import("./vault/links.ts");
    const { normalizeSite } = await import("./vault/refs.ts");
    const { vaultRuntime } = await import("./vault/index.ts");
    const { previewUrl, publicHost } = await import("./preview.ts");
    const site = b.site ? normalizeSite(String(b.site)) : undefined;
    const link = await issueLink(db, vaultRuntime().publicUrl, { userId: user.id, kind: kind as "login" | "totp" | "personal" | "card", site });
    const pv = previewUrl({ title: site ?? (kind === "card" ? (user.lang === "en" ? "Your card" : "Ta carte") : kind === "personal" ? (user.lang === "en" ? "Your details" : "Tes informations") : user.lang === "en" ? "Your account" : "Ton compte"), host: publicHost(), lock: true });
    if (b.silent) return { url: link.url }; // pour regarder la page sans rien envoyer dans le fil
    await enqueue(db, [
      ...(b.text ? [{ userId: user.id, kind: "text" as const, text: String(b.text) }] : []),
      pv ? { userId: user.id, kind: "card" as const, image: pv, text: link.url } : { userId: user.id, kind: "text" as const, text: link.url },
    ]);
    outboxEvents.emit(user.line_id);
    return { url: link.url };
  });

  /** Sauvegarde (base + coffre) : POST pour la faire, GET pour voir celles qui existent. Le minuteur systemd appelle le POST chaque nuit. */
  http.post("/admin/backup", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const { runBackup } = await import("./backup.ts");
    return runBackup(db, { dir: join(process.cwd(), "backups"), bucket: process.env.MELLA_BACKUP_BUCKET || undefined, region: process.env.MELLA_BACKUP_REGION || "eu-west-3", vaultSsh: process.env.MELLA_VAULT_BACKUP_SSH || undefined });
  });
  http.get("/admin/backup", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const { listBackups } = await import("./backup.ts");
    return { backups: await listBackups(join(process.cwd(), "backups")) };
  });

  /** Dépannage : envoie de vraies cartes d'options (photo + lien) à une personne, comme le ferait l'agent. */
  http.post("/admin/cards", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const b = req.body as { handle?: string; intro?: string; cards?: Array<{ title: string; subtitle?: string; url?: string; image?: string; priceCents?: number }> };
    const u = (await db.query<{ id: string; line_id: string }>(`SELECT id, line_id FROM users WHERE handle = $1`, [String(b.handle ?? "")])).rows[0];
    if (!u || !b.cards?.length) return reply.code(404).send({ error: "personne inconnue ou cartes vides" });
    const saved = await saveCards(db, u.id, b.cards);
    const n = await sendCards(db, u.id, cfg.publicUrl, saved.map((c) => c.id), b.intro);
    outboxEvents.emit(u.line_id);
    return { ok: true, sent: n, ids: saved.map((c) => c.id) };
  });

  /** Lecture seule pour le dépannage : ce que la personne a écrit, ce que Mell a fait, ce qui a échoué. */
  http.get("/admin/debug", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const q = req.query as { handle?: string; limit?: string };
    const u = (await db.query<{ id: string }>(`SELECT id FROM users WHERE handle = $1`, [String(q.handle ?? "")])).rows[0];
    if (!u) return reply.code(404).send({ error: "personne inconnue" });
    const n = Math.min(200, Number(q.limit ?? 40));
    const pick = (sql: string) => db.query(sql, [u.id, n]).then((r) => r.rows.reverse());
    return {
      mail_address: await ensureAddress(db, cfg, await getUser(db, u.id)),
      messages: await pick(`SELECT id, direction, text, tapback, sent_at FROM messages WHERE user_id = $1 ORDER BY id DESC LIMIT $2`),
      outbox: await pick(`SELECT id, kind, status, error, tapback, left(text, 80) AS text, created_at FROM outbox WHERE user_id = $1 ORDER BY id DESC LIMIT $2`),
      routes: await pick(`SELECT left(text, 80) AS text, class, raw_class, confidence, source, model, latency_ms, created_at FROM router_decisions WHERE user_id = $1 ORDER BY id DESC LIMIT $2`),
      tools: await pick(`SELECT mode, name, args, result, ms, created_at FROM tool_calls WHERE user_id = $1 ORDER BY id DESC LIMIT $2`),
      jobs: await pick(`SELECT left(request, 120) AS request, status, error, created_at, finished_at FROM jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`),
      schedules: await pick(`SELECT kind, action, left(message, 80) AS message, next_run_at, status, call_mode FROM schedules WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`),
      inbox: await pick(`SELECT id, kind, from_addr, left(subject, 80) AS subject, authenticated, forwarded_by, status, note, received_at FROM inbox WHERE user_id = $1 ORDER BY id DESC LIMIT $2`),
      apps: await pick(`SELECT service, login, status, updated_at FROM app_connections WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`),
    };
  });

  /** Les modes d'emploi appris : les voir, valider une leçon de comportement en attente, archiver (jamais supprimer). */
  http.get("/admin/skills", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    return { skills: (await db.query(`SELECT id, scope, user_id, name, description, body, domains, status, version, uses, last_used_at, updated_at FROM skills ORDER BY status, lower(name)`)).rows };
  });
  /** Le curateur tout de suite (cycle de vie et fusion), sans attendre la semaine : rend ce qu'il a fait. */
  http.post("/admin/curator", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const { runCurator } = await import("./curator.ts");
    return runCurator(db, cfg, llm, true);
  });
  http.post("/admin/skills/:id/:action", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const { id, action } = req.params as { id: string; action: string };
    const status = action === "approve" ? "active" : action === "archive" ? "archived" : undefined;
    if (!status) return reply.code(400).send({ error: "approve ou archive" });
    const r = await db.query(`UPDATE skills SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, name, status`, [Number(id), status]);
    return r.rows[0] ?? reply.code(404).send({ error: "inconnu" });
  });

  /** Dépannage : rejoue une recherche Gmail sur le compte de la personne (expéditeur, objet, date, rien du corps). */
  http.get("/admin/gmail", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const q = req.query as { handle?: string; q?: string; max?: string };
    const u = (await db.query(`SELECT * FROM users WHERE handle = $1`, [String(q.handle ?? "")])).rows[0];
    if (!u) return reply.code(404).send({ error: "personne inconnue" });
    const { searchMail } = await import("./google/gmail.ts");
    const g = (await import("./google/runtime.ts")).googleRuntime();
    if (!g) return reply.code(503).send({ error: "Google indisponible" });
    const mails = await searchMail(g, db, u, String(q.q ?? "newer_than:1d"), Number(q.max ?? 15));
    return { count: mails.length, mails: mails.map((m) => ({ date: m.date, from: m.from, subject: m.subject, unread: m.unread })) };
  });

  /** Envoie dans son fil le lien de connexion d'une application (Composio), comme Mell le ferait. */
  http.post("/admin/connect-app", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    if (!apps) return reply.code(503).send({ error: "Composio non branché" });
    const b = req.body as { handle?: string; service?: string };
    const u = (await db.query<{ id: string; line_id: string }>(`SELECT id, line_id FROM users WHERE handle = $1`, [String(b.handle ?? "")])).rows[0];
    if (!u) return reply.code(404).send({ error: "personne inconnue" });
    const { isAppService } = await import("./apps/index.ts");
    if (!isAppService(b.service)) return reply.code(400).send({ error: "service inconnu" });
    const url = await apps.connect(db, u.id, b.service);
    const { connectCard } = await import("./apps/tools.ts");
    await enqueue(db, [connectCard(u.id, (await getUser(db, u.id)).lang, b.service, url)]);
    outboxEvents.emit(u.line_id);
    return { url };
  });

  /** Envoie dans son fil le lien de connexion de sa boîte (code Gmail) ou de son agenda, comme Mell le ferait. */
  http.post("/admin/connect-link", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const b = req.body as { handle?: string; service?: string };
    const u = (await db.query<{ id: string; line_id: string }>(`SELECT id, line_id FROM users WHERE handle = $1`, [String(b.handle ?? "")])).rows[0];
    if (!u) return reply.code(404).send({ error: "personne inconnue" });
    const { url } = b.service === "calendar" ? await google.issueLink(db, u.id) : await google.issueAppLink(db, u.id);
    await enqueue(db, [{ userId: u.id, kind: "text", text: url }]);
    outboxEvents.emit(u.line_id);
    return { url };
  });

  /** Test de la connexion en direct : ouvre la page de connexion d'un site dans le navigateur de la personne. */
  http.post("/admin/live", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const b = req.body as { handle?: string; site?: string; start_url?: string };
    const u = (await db.query<{ id: string }>(`SELECT id FROM users WHERE handle = $1`, [String(b.handle ?? "")])).rows[0];
    if (!u) return reply.code(404).send({ error: "personne inconnue" });
    const { startLive } = await import("./browser/live.ts");
    return { url: await startLive(db, cfg, u.id, { site: String(b.site ?? "site"), startUrl: String(b.start_url ?? "") }) };
  });

  /** Appel de test ou de dépannage : Mell appelle la personne (FaceTime audio depuis sa ligne) et dit le texte. */
  http.post("/admin/call", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const b = req.body as { handle?: string; text?: string };
    const u = (await db.query<{ id: string; line_id: string }>(`SELECT id, line_id FROM users WHERE handle = $1`, [String(b.handle ?? "")])).rows[0];
    if (!u) return reply.code(404).send({ error: "personne inconnue" });
    await enqueue(db, [{ userId: u.id, kind: "call", text: String(b.text ?? "Salut, c'est Mell. Ceci est un appel de test.").slice(0, 500) }]);
    outboxEvents.emit(u.line_id);
    return { ok: true };
  });

  http.post("/admin/lines", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const b = req.body as { id: string; handle: string; secret: string; maxUsers?: number };
    await upsertLine(db, b);
    return { ok: true };
  });

  /** Retour du 3-D Secure. En prod, c'est le prestataire de paiement qui appellera ici. */
  http.post("/admin/tasks/:id/bank", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "non autorisé" });
    const approved = !!(req.body as { approved?: boolean }).approved;
    const task = await bankResult(db, (req.params as { id: string }).id, approved);
    if (!task) return reply.code(404).send({ error: "aucun paiement en attente" });
    await createJob(
      db,
      cfg,
      task.user_id,
      approved
        ? `[système] La banque a validé le paiement de la tâche ${task.id} (${describeScope(task)}). Termine la tâche et confirme à l'utilisateur.`
        : `[système] La banque a refusé le paiement de la tâche ${task.id} (${describeScope(task)}). Préviens l'utilisateur simplement et propose une suite.`,
    );
    return { ok: true, status: task.status };
  });

  // Boucles de fond. Chacune est un passage borné ; un passage en cours n'est jamais doublé.
  const inFlight = new Set<string>();
  /** Tours ratés d'affilée par personne : au deuxième, on s'excuse au lieu de la laisser sans réponse. */
  const turnFailures = new Map<string, number>();
  async function tickTurns(): Promise<void> {
    const ids = await claimTurns(db, cfg, 8);
    await Promise.all(
      ids.map(async (id) => {
        if (inFlight.has(id)) return;
        inFlight.add(id);
        try {
          await handleTurn(db, cfg, llm, id);
          turnFailures.delete(id);
        } catch (e) {
          http.log.error({ err: e, user: id }, "tour en échec");
          const n = (turnFailures.get(id) ?? 0) + 1;
          turnFailures.set(id, n);
          if (n >= 2) {
            // Jamais de silence : ses messages sont clos et on le lui dit, plutôt que de réessayer en boucle.
            turnFailures.delete(id);
            await db.query(`UPDATE messages SET processed_at = now() WHERE user_id = $1 AND direction = 'in' AND processed_at IS NULL`, [id]).catch(() => {});
            const u = await getUser(db, id).catch(() => undefined);
            await enqueue(db, [{ userId: id, kind: "text", text: u?.lang === "en" ? "Sorry, I hit a snag on that one. Can you send it again?" : "Désolé, j'ai buté sur ton message. Tu peux me le renvoyer ?" }]).catch(() => {});
          }
        } finally {
          inFlight.delete(id);
          await releaseTurn(db, id);
        }
      }),
    );
  }

  async function tick(): Promise<void> {
    await runDue(db, cfg);
    await tickTurns();
    await runJobs(db, cfg, llm);
    await runBatch(db, cfg, llm);
    await runWatches(db, cfg, llm);
    await runInbox(db, cfg, llm);
    if (apps) await apps.promote(db);
  }

  const loops: Array<{ stop: () => void; done: Promise<void> }> = [];
  const jobsInFlight = new Set<Promise<unknown>>();
  const wakers = new Map<string, () => void>();
  let smtp: ReturnType<typeof startSmtp> | undefined;
  function loop(name: string, everyMs: number, fn: () => Promise<unknown>) {
    let stopped = false;
    let wake: (() => void) | undefined;
    const done = (async () => {
      while (!stopped) {
        try {
          await fn();
        } catch (e) {
          http.log.error({ err: e }, `boucle ${name}`);
        }
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, everyMs);
        });
      }
    })();
    loops.push({ stop: () => ((stopped = true), wake?.()), done });
    wakers.set(name, () => wake?.());
  }

  return {
    http,
    db,
    llm,
    vault,
    tick,
    async start() {
      // Un redémarrage (déploiement) a pu tuer un tour en plein travail : son verrou bloquerait le fil 3 min.
      await db.query(`UPDATE users SET turn_lock_until = NULL WHERE turn_lock_until IS NOT NULL`).catch(() => {});
      loop("schedules", 1000, () => runDue(db, cfg));
      loop("turns", 300, tickTurns);
      // Une tâche web dure des minutes : chaque travail tourne à part, quatre au plus en même temps.
      loop("jobs", 1000, async () => {
        if (jobsInFlight.size >= 4) return;
        const p: Promise<unknown> = runJobs(db, cfg, llm, 1)
          .catch((e) => http.log.error({ err: e }, "travail en échec"))
          .finally(() => jobsInFlight.delete(p));
        jobsInFlight.add(p);
      });
      loop("batch", 5000, () => runBatch(db, cfg, llm));
      // Surveillances : un passage par minute, quelques-unes à la fois (une lecture de site prend des secondes).
      loop("watches", 60_000, () => runWatches(db, cfg, llm));
      // Apprendre de ses corrections : une conversation calmée depuis 10 minutes est relue par le même modèle.
      if (cfg.llm !== "fake") loop("reviews", 60_000, async () => void (await import("./review.ts").then(({ reviewQuietConversations }) => reviewQuietConversations(db, cfg, llm))));
      // Le curateur : cycle de vie des modes d'emploi chaque heure, fusion par le même modèle une fois par semaine.
      loop("curator", 3_600_000, async () => void (await import("./curator.ts").then(({ runCurator }) => runCurator(db, cfg, llm))));
      // La veille : toutes les cinq minutes, on regarde à qui il est l'heure d'un passage (pulse.ts).
      if (cfg.pulse) loop("pulse", 5 * 60_000, () => planPulses(db, cfg));
      // Horaires de trains chargés d'avance : la première question n'attend pas le téléchargement.
      warmTrains();
      // Mails reçus sur les adresses Mell : traités dès l'arrivée (le serveur de réception réveille la boucle).
      if (mailOn(cfg)) loop("inbox", 15_000, () => runInbox(db, cfg, llm));
      if (apps) loop("apps", 5_000, () => apps.promote(db));
      if (mailOn(cfg) && cfg.mail.port) {
        smtp = startSmtp(db, cfg, {
          onStored: () => setTimeout(() => wakers.get("inbox")?.(), 2000),
          log: (msg, err) => http.log.warn({ err: err instanceof Error ? err.message : err }, msg),
        });
      }
      return http.listen({ port: cfg.port, host: "0.0.0.0" });
    },
    async stop() {
      loops.forEach((l) => l.stop());
      await Promise.all(loops.map((l) => l.done));
      await Promise.race([Promise.all(jobsInFlight), new Promise((r) => setTimeout(r, 5000))]);
      await sessions?.closeAll().catch(() => {});
      await fallback?.closeAll().catch(() => {});
      await smtp?.close().catch(() => {});
      await http.close();
      await db.close();
    },
  };
}
