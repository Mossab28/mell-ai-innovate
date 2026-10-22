import { randomBytes } from "node:crypto";
import type { Db } from "../db.ts";
import type { Config } from "../config.ts";
import { Composio, ComposioError } from "./composio.ts";
import { appInfo, isGoogleApp, type AppService } from "./catalog.ts";

type Q = Pick<Db, "query">;

/**
 * Connexions d'applications par Composio, une identité par personne et service.
 * Gmail et Agenda gardent leurs outils riches, les autres passent par l'exécuteur
 * générique. Une connexion en cours (app_connect_pending) est promue par une boucle
 * de fond dès que Composio la dit active, et Mell l'écrit alors dans le fil.
 */

export interface AppStatus {
  service: AppService;
  login: string | null;
  pending: boolean;
}

export class AppsService {
  constructor(
    readonly composio: Composio,
    private readonly log?: (msg: string, err?: unknown) => void,
    /** Adresse publique de Mell : le lien envoyé est askmell.com/connect/<jeton>, jamais l'écran Composio en clair. */
    private readonly publicUrl?: string,
  ) {}

  /** Proxy Composio pour les appels Google REST (posé dans GoogleService). */
  transport(accountId: string, service: "gmail" | "calendar" | "drive" | "sheets"): typeof fetch {
    return this.composio.transport(accountId, service);
  }

  /** Lance une connexion : lien de l'écran Composio (déjà validé Google), compte suivi jusqu'à l'activation. */
  async connect(q: Q, userId: string, service: AppService): Promise<string> {
    const base = this.publicUrl?.replace(/\/+$/, "");
    const token = randomBytes(9).toString("base64url");
    const { url, accountId, authConfigId, expiresAt } = await this.composio.authorize(userId, service, base ? `${base}/connected/${token}` : undefined);
    await q.query(
      `INSERT INTO app_connect_pending (user_id, service, account_id, auth_config_id, google, expires_at, token, url)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), $7, $8)
       ON CONFLICT (user_id, service) DO UPDATE SET account_id = excluded.account_id, auth_config_id = excluded.auth_config_id, google = excluded.google, created_at = now(), expires_at = excluded.expires_at, token = excluded.token, url = excluded.url`,
      [userId, service, accountId, authConfigId, isGoogleApp(service), expiresAt, token, url],
    );
    return base ? `${base}/connect/${token}` : url;
  }

  /** Le lien Composio derrière un jeton d'alias encore valable, et le service visé. */
  async pendingByToken(q: Q, token: string): Promise<{ service: AppService; url: string; expired: boolean; userId: string } | undefined> {
    if (!/^[A-Za-z0-9_-]{8,16}$/.test(token)) return undefined;
    const r = (await q.query<{ service: string; url: string; expired: boolean; user_id: string }>(`SELECT service, url, expires_at <= now() AS expired, user_id FROM app_connect_pending WHERE token = $1`, [token])).rows[0];
    return r ? { service: r.service as AppService, url: r.url, expired: r.expired, userId: r.user_id } : undefined;
  }

  /** Id du compte Composio actif pour un service, ou undefined. */
  async accountId(q: Q, userId: string, service: AppService): Promise<string | undefined> {
    const r = (await q.query<{ account_id: string }>(`SELECT account_id FROM app_connections WHERE user_id = $1 AND service = $2 AND status = 'active'`, [userId, service])).rows[0];
    return r?.account_id;
  }

  /** Les applications connectées, pour le contexte et le modèle. */
  async connected(q: Q, userId: string): Promise<AppStatus[]> {
    const out: AppStatus[] = [];
    const apps = (await q.query<{ service: string; login: string | null }>(`SELECT service, login FROM app_connections WHERE user_id = $1 AND status = 'active'`, [userId])).rows;
    for (const a of apps) out.push({ service: a.service as AppService, login: a.login, pending: false });
    const pend = (await q.query<{ service: string }>(`SELECT service FROM app_connect_pending WHERE user_id = $1 AND expires_at > now()`, [userId])).rows;
    for (const p of pend) if (!out.some((o) => o.service === p.service)) out.push({ service: p.service as AppService, login: null, pending: true });
    return out;
  }

  /** Cherche des outils d'un service connecté (catalogue public), pour que le modèle choisisse. */
  async tools(q: Q, userId: string, service: AppService, query?: string): Promise<{ slug: string; description: string; readOnly: boolean }[]> {
    await this.requireAccount(q, userId, service);
    return (await this.composio.tools(service, query)).map((t) => ({ slug: t.slug, description: `${t.name} - ${t.description}`.slice(0, 300), readOnly: t.readOnly }));
  }

  /** Exécute un outil sur un service connecté. Une écriture exige `writeApproved` (tâche validée). */
  async run(q: Q, userId: string, service: AppService, slug: string, args: Record<string, unknown>, writeApproved: boolean): Promise<string> {
    const accountId = await this.requireAccount(q, userId, service);
    return this.composio.executeTool(accountId, service, slug, args, { writeApproved });
  }

  private async requireAccount(q: Q, userId: string, service: AppService): Promise<string> {
    const id = await this.accountId(q, userId, service);
    if (!id) throw new ComposioError(`${appInfo(service).name} n'est pas connecté`, undefined, true);
    return id;
  }

  async disconnect(q: Q, userId: string, service: AppService): Promise<boolean> {
    const pending = (await q.query<{ account_id: string }>(`DELETE FROM app_connect_pending WHERE user_id = $1 AND service = $2 RETURNING account_id`, [userId, service])).rows;
    const current = (await q.query<{ account_id: string }>(`UPDATE app_connections SET status = 'revoked', updated_at = now() WHERE user_id = $1 AND service = $2 RETURNING account_id`, [userId, service])).rows;
    for (const accountId of new Set([...pending, ...current].map((r) => r.account_id))) {
      try { await this.composio.disconnect(accountId); }
      catch { throw new ComposioError("L'accès de Mell est retiré, mais la suppression chez le connecteur n'est pas encore confirmée. Réessaie la déconnexion."); }
    }
    await q.query(`DELETE FROM app_connections WHERE user_id = $1 AND service = $2`, [userId, service]);
    return pending.length + current.length > 0;
  }

  /** Un passage : promeut les connexions en cours devenues actives, abandonne celles qui échouent ou expirent. */
  async promote(db: Db, limit = 20): Promise<number> {
    await db.query(`DELETE FROM app_connect_pending WHERE expires_at <= now()`);
    const rows = (await db.query<{ user_id: string; service: string; account_id: string; auth_config_id: string; google: boolean }>(
      `SELECT user_id, service, account_id, auth_config_id, google FROM app_connect_pending ORDER BY created_at LIMIT $1`,
      [limit],
    )).rows;
    let done = 0;
    for (const p of rows) {
      const service = p.service as AppService;
      let acc;
      try {
        acc = await this.composio.account(p.user_id, service, p.account_id, p.auth_config_id);
      } catch (e) {
        if (e instanceof ComposioError && e.terminal) await db.query(`DELETE FROM app_connect_pending WHERE user_id = $1 AND service = $2`, [p.user_id, service]);
        continue;
      }
      if (acc.status === "pending") continue;
      if (acc.status === "dead") {
        await db.query(`DELETE FROM app_connect_pending WHERE user_id = $1 AND service = $2`, [p.user_id, service]);
        continue;
      }
      const login = await this.composio.login(p.account_id, service).catch(() => null);
      const promoted = await db.tx(async (q) => {
        // An expired, replaced or disconnected link must not restore a connection.
        const claimed = await q.query(`DELETE FROM app_connect_pending WHERE user_id = $1 AND service = $2 AND account_id = $3 AND expires_at > now() RETURNING user_id`, [p.user_id, service, p.account_id]);
        if (!claimed.rows.length) return false;
        const previous = (await q.query<{ account_id: string }>(`SELECT account_id FROM app_connections WHERE user_id = $1 AND service = $2`, [p.user_id, service])).rows[0]?.account_id;
          await q.query(
            `INSERT INTO app_connections (user_id, service, account_id, auth_config_id, login, scopes, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'active')
             ON CONFLICT (user_id, service) DO UPDATE SET account_id = excluded.account_id, auth_config_id = excluded.auth_config_id, login = excluded.login, scopes = excluded.scopes, status = 'active', updated_at = now()`,
            [p.user_id, service, p.account_id, p.auth_config_id, login, acc.scopes],
          );
        // Le fait arrive à l'agent, qui reprend ce qu'elle attendait (« je regarde ce que tu as demain ») : la bulle écrite
        // d'avance ne relançait rien, et le tour suivant croyait encore l'agenda non connecté (20/10).
        const info = appInfo(service);
        await q.query(
          `INSERT INTO messages (user_id, direction, guid, text) VALUES ($1, 'in', $2, $3) ON CONFLICT (guid) DO NOTHING`,
          [p.user_id, `connected:${p.account_id}`, `[système] ${info.name} vient d'être connecté${login ? ` (${login})` : ""}, sécurisé par Composio.`],
        );
        return { replaced: previous && previous !== p.account_id ? previous : undefined };
      });
      if (!promoted) continue;
      done++;
      // Une reconnexion remplace l'ancien compte : on ne le laisse pas ouvert chez Composio.
      if (promoted.replaced) await this.composio.disconnect(promoted.replaced).catch(() => {});
    }
    return done;
  }
}
