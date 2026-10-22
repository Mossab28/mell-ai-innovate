import { randomBytes } from "node:crypto";
import type { Db } from "../db.ts";
import type { GoogleEndpoints } from "../config.ts";
import type { VaultService } from "../vault/service.ts";
import { enqueue } from "../outbox.ts";
import { getUser } from "../users.ts";
import { connectedBubble } from "./copy.ts";
import {
  LINK_MINUTES,
  checkLinkToken,
  consentUrl,
  emailFromIdToken,
  newLinkToken,
  pkceChallenge,
  pkceVerifier,
  readState,
  servicesOf,
  signState,
  signingKey,
  sha256,
  SCOPES,
} from "./oauth.ts";
import { checkLogin, type AppCreds } from "./imap.ts";

type Q = Pick<Db, "query">;

/**
 * Connexion Google d'une personne : lien du fil, retour de Google, jeton d'accès rafraîchi à la
 * demande, appels aux API, déconnexion. Le jeton de rafraîchissement ne quitte le coffre que pour
 * aller chez Google ; le jeton d'accès (une heure) ne vit qu'en mémoire. Le modèle ne voit ni l'un
 * ni l'autre : les outils ne lui rendent que des données.
 */

export type GoogleErrorCode = "not_configured" | "not_connected" | "reconnect" | "missing_scope" | "not_found" | "unavailable" | "refused";

export class GoogleError extends Error {
  constructor(
    readonly code: GoogleErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface GoogleConnection {
  user_id: string;
  email: string | null;
  scopes: string[];
  status: "active" | "revoked";
  /** Par où passent les appels : OAuth Google, mot de passe d'application (IMAP/SMTP), ou le proxy Composio. */
  method: "oauth" | "app_password" | "composio";
  composio_account_id?: string | null;
  composio_auth_config_id?: string | null;
  connected_at: Date;
}

export type GoogleServiceName = "gmail" | "calendar";

/** Résultat d'un code collé sur la page /connect/gmail. */
export type AppConnectResult = { status: "connected"; userId: string; email: string } | { status: "refused" | "unavailable" | "invalid"; userId: string } | { status: "gone" };

export interface GoogleOptions {
  endpoints: GoogleEndpoints;
  publicUrl: string;
  /** Base de l'adresse de retour déclarée chez Google (console). Par défaut publicUrl ; elle reste sur l'ancienne
   *  adresse quand les pages de Mell changent de domaine, sinon Google refuse le retour. */
  redirectBase?: string;
  vault: VaultService;
  clientId?: string;
  clientSecret?: string;
  timeoutMs?: number;
  log?: (msg: string, err?: unknown) => void;
}

export type BeginResult = { status: "ok"; url: string; userId: string } | { status: "gone" } | { status: "unavailable" };
export type FinishResult =
  | { status: "connected"; userId: string; email?: string; scopes: string[] }
  | { status: "nothing" | "denied" | "failed"; userId: string }
  | { status: "gone"; userId: string }
  | { status: "invalid" }
  | { status: "unavailable" };

interface Client {
  id: string;
  secret: string;
  key: Buffer;
}

const PROVIDER = "google";

/** Au coffre, le mot de passe d'application est rangé comme une connexion (champ refreshToken). */
const APP_PROVIDER = "gmail-app";
const MAIL_SCOPES = [SCOPES.gmailRead, SCOPES.gmailCompose];
const MAX_APP_ATTEMPTS = 5;

export class GoogleService {
  private readonly tokens = new Map<string, { token: string; exp: number }>();
  private readonly refreshing = new Map<string, Promise<string>>();
  private client?: Client;
  private missUntil = 0;
  /** Proxy Composio pour les services Google, posé par createApp quand Composio est branché. */
  private composioTransport?: (accountId: string, service: "gmail" | "calendar" | "drive" | "sheets") => typeof fetch;

  useComposio(fn: (accountId: string, service: "gmail" | "calendar" | "drive" | "sheets") => typeof fetch): void {
    this.composioTransport = fn;
  }

  constructor(private readonly o: GoogleOptions) {
    if (o.clientId && o.clientSecret) this.client = { id: o.clientId, secret: o.clientSecret, key: signingKey(o.clientSecret) };
  }

  get endpoints(): GoogleEndpoints {
    return this.o.endpoints;
  }

  get redirectUri(): string {
    return `${(this.o.redirectBase || this.o.publicUrl).replace(/\/+$/, "")}/connect/google/callback`;
  }

  /** Client OAuth : l'environnement d'abord, sinon le coffre, relu au plus une fois par minute tant qu'il manque. */
  async clientOrUndefined(): Promise<Client | undefined> {
    if (this.client) return this.client;
    if (Date.now() < this.missUntil) return undefined;
    this.missUntil = Date.now() + 60_000;
    try {
      const s = await this.o.vault.backend.readServerSecret("google-oauth");
      if (s?.client_id && s?.client_secret) this.client = { id: s.client_id, secret: s.client_secret, key: signingKey(s.client_secret) };
    } catch (e) {
      this.o.log?.("client OAuth Google illisible au coffre", e);
    }
    return this.client;
  }

  async available(): Promise<boolean> {
    return !!(await this.clientOrUndefined());
  }

  private async requireClient(): Promise<Client> {
    const c = await this.clientOrUndefined();
    if (!c) throw new GoogleError("not_configured", "connexion à Google pas encore disponible");
    return c;
  }

  // ---- Le lien du fil et l'aller-retour chez Google -----------------------------------------------

  /** Lien à usage unique, signé, qui expire, lié à la personne. */
  async issueLink(q: Q, userId: string): Promise<{ url: string; expiresAt: Date }> {
    const c = await this.requireClient();
    const { token, hash } = newLinkToken(c.key);
    const { rows } = await q.query<{ expires_at: Date }>(
      `INSERT INTO connect_links (token_hash, user_id, provider, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING expires_at`,
      [hash, userId, PROVIDER, LINK_MINUTES],
    );
    return { url: `${this.o.publicUrl.replace(/\/+$/, "")}/connect/google?t=${token}`, expiresAt: rows[0].expires_at };
  }

  /** Aller vers l'écran de Google. Ne consomme pas le lien : un aperçu de lien fait aussi un GET. */
  async begin(q: Q, token: string): Promise<BeginResult> {
    const c = await this.clientOrUndefined();
    if (!c) return { status: "unavailable" };
    const hash = checkLinkToken(c.key, token);
    if (!hash) return { status: "gone" };
    const link = (
      await q.query<{ user_id: string; email: string | null }>(
        `SELECT l.user_id, g.email FROM connect_links l LEFT JOIN google_connections g ON g.user_id = l.user_id
         WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.expires_at > now()`,
        [hash],
      )
    ).rows[0];
    if (!link) return { status: "gone" };
    const { state, nonce } = signState(c.key, { link: hash, user: link.user_id });
    const url = consentUrl(this.o.endpoints.auth, {
      clientId: c.id,
      redirectUri: this.redirectUri,
      state,
      challenge: pkceChallenge(pkceVerifier(c.key, nonce)),
      loginHint: link.email ?? undefined,
    });
    return { status: "ok", url, userId: link.user_id };
  }

  /**
   * Retour de Google : vérifie l'état, consomme le lien, échange le code, range le jeton de
   * rafraîchissement au coffre, puis Mell écrit de lui-même dans le fil.
   */
  async finish(db: Db, p: { code?: string; state?: string; error?: string }): Promise<FinishResult> {
    const c = await this.clientOrUndefined();
    if (!c) return { status: "unavailable" };
    const s = readState(c.key, p.state ?? "");
    if (!s) return { status: "invalid" };
    // Refus sur l'écran de Google : le lien reste valable, on pourra réessayer.
    if (p.error) return { status: "denied", userId: s.user };
    if (!p.code) return { status: "invalid" };

    const consumed = await db.query(
      `UPDATE connect_links SET used_at = now() WHERE token_hash = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > now() RETURNING token_hash`,
      [s.link, s.user],
    );
    if (!consumed.rows.length) return { status: "gone", userId: s.user };
    const release = () => db.query(`UPDATE connect_links SET used_at = NULL WHERE token_hash = $1`, [s.link]);

    const r = await this.tokenRequest({
      grant_type: "authorization_code",
      code: p.code,
      client_id: c.id,
      client_secret: c.secret,
      redirect_uri: this.redirectUri,
      code_verifier: pkceVerifier(c.key, s.nonce),
    });
    const refreshToken = r.json?.refresh_token as string | undefined;
    if (!r.ok || !refreshToken || !r.json?.access_token) {
      this.o.log?.(`échange du code Google en échec (${r.status} ${r.json?.error ?? ""})`);
      await release();
      return { status: "failed", userId: s.user };
    }
    const scopes = String(r.json.scope ?? "").split(/\s+/).filter(Boolean);
    const services = servicesOf(scopes);
    const lang = (await getUser(db, s.user))?.lang ?? "fr";

    // Rien d'utile coché : on ne garde rien, et on le dit.
    if (!services.mailRead && !services.mailSend && !services.calendar) {
      await this.revoke(refreshToken);
      await enqueue(db, [{ userId: s.user, kind: "text", text: connectedBubble(lang, services), dedupeKey: `google-connected:${s.link}` }]);
      return { status: "nothing", userId: s.user };
    }

    const email = emailFromIdToken(r.json.id_token);
    try {
      await this.o.vault.putConnection(db, s.user, PROVIDER, { refreshToken }, { actor: "user_link", detail: email });
    } catch (e) {
      this.o.log?.("jeton Google non rangé au coffre", e);
      await this.revoke(refreshToken);
      await release();
      return { status: "failed", userId: s.user };
    }
    this.tokens.set(s.user, { token: r.json.access_token, exp: Date.now() + Number(r.json.expires_in ?? 3600) * 1000 });
    await db.tx(async (q) => {
      // Les mails cochés chez Google remplacent le mot de passe d'application ; sinon il reste pour les mails.
      const prev = await this.connection(q, s.user);
      const keepApp = !services.mailRead && prev?.method === "app_password" && prev.status === "active";
      await q.query(
        `INSERT INTO google_connections (user_id, email, scopes, status, method) VALUES ($1, $2, $3, 'active', $4)
         ON CONFLICT (user_id) DO UPDATE SET email = coalesce(excluded.email, google_connections.email), scopes = excluded.scopes, status = 'active',
           method = excluded.method, connected_at = now(), updated_at = now()`,
        [s.user, keepApp ? (prev.email ?? email ?? null) : (email ?? null), keepApp ? [...new Set([...scopes, ...MAIL_SCOPES])] : scopes, keepApp ? "app_password" : "oauth"],
      );
      if (!keepApp && prev?.method === "app_password") await this.o.vault.deleteConnection(q, s.user, APP_PROVIDER, { actor: "system", detail: "remplacé par la connexion Google" });
      await this.journal(q, s.user, "connect", email);
      await enqueue(q, [{ userId: s.user, kind: "text", text: connectedBubble(lang, services, email), dedupeKey: `google-connected:${s.link}` }]);
    });
    return { status: "connected", userId: s.user, email, scopes };
  }

  // ---- Jetons --------------------------------------------------------------------------------------

  async connection(q: Q, userId: string): Promise<GoogleConnection | undefined> {
    return (await q.query<GoogleConnection>(`SELECT * FROM google_connections WHERE user_id = $1`, [userId])).rows[0];
  }

  /** Service-specific managed auth overrides only that service's legacy connection. */
  async connectionFor(q: Q, userId: string, service: GoogleServiceName): Promise<GoogleConnection | undefined> {
    const managed = (await q.query<GoogleConnection>(
      `SELECT user_id, login AS email, scopes, status, 'composio' AS method,
        account_id AS composio_account_id, auth_config_id AS composio_auth_config_id, connected_at
       FROM app_connections WHERE user_id = $1 AND service = $2`, [userId, service],
    )).rows[0];
    if (managed) return managed;
    const legacy = await this.connection(q, userId);
    // Old mixed Composio records cannot prove which toolkit owns their sole ID.
    if (!legacy || legacy.method === "composio") return undefined;
    const relevant = legacy.scopes.some((s) => service === "gmail" ? s.includes("/gmail.") || s === "https://mail.google.com/" : s.includes("/calendar"));
    return relevant ? legacy : undefined;
  }

  /** Jeton d'accès valable au moins une minute, rafraîchi au besoin (un seul rafraîchissement à la fois). */
  async accessToken(q: Q, userId: string, scope?: string): Promise<string> {
    const conn = await this.connection(q, userId);
    if (!conn) throw new GoogleError("not_connected", "Google n'est pas connecté");
    if (conn.status === "revoked") throw new GoogleError("reconnect", "l'accès à Google ne marche plus");
    if (scope && !conn.scopes.includes(scope)) throw new GoogleError("missing_scope", "ce service n'a pas été coché chez Google");
    const cached = this.tokens.get(userId);
    if (cached && cached.exp - 60_000 > Date.now()) return cached.token;
    let p = this.refreshing.get(userId);
    if (!p) {
      p = this.refresh(q, userId).finally(() => this.refreshing.delete(userId));
      this.refreshing.set(userId, p);
    }
    return p;
  }

  private async refresh(q: Q, userId: string): Promise<string> {
    const c = await this.requireClient();
    const secret = await this.o.vault.backend.getConnectionForUse(userId, PROVIDER);
    if (!secret) {
      await this.markRevoked(q, userId, "jeton absent du coffre");
      throw new GoogleError("reconnect", "l'accès à Google ne marche plus");
    }
    const r = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: secret.refreshToken, client_id: c.id, client_secret: c.secret });
    if (!r.ok || !r.json?.access_token) {
      // invalid_grant : accès retiré chez Google, mot de passe changé, ou 7 jours écoulés en mode test.
      if (r.json?.error === "invalid_grant") {
        await this.markRevoked(q, userId, "refusé par Google");
        throw new GoogleError("reconnect", "l'accès à Google ne marche plus");
      }
      this.o.log?.(`rafraîchissement Google en échec (${r.status} ${r.json?.error ?? ""})`);
      throw new GoogleError("unavailable", "Google ne répond pas pour l'instant");
    }
    this.tokens.set(userId, { token: r.json.access_token, exp: Date.now() + Number(r.json.expires_in ?? 3600) * 1000 });
    return r.json.access_token;
  }

  /** Jeton refusé : il ne sert plus à rien, on l'efface du coffre et on attend un nouveau lien. */
  private async markRevoked(q: Q, userId: string, why: string): Promise<void> {
    this.tokens.delete(userId);
    const conn = await this.connection(q, userId);
    if (conn?.method === "composio") {
      await q.query(`UPDATE google_connections SET status = 'revoked', composio_account_id = NULL, updated_at = now() WHERE user_id = $1`, [userId]);
      await this.journal(q, userId, "revoked", why);
      return;
    }
    if (conn?.method === "app_password") {
      // Les mails passent par le mot de passe d'application : seul l'agenda (connexion Google) tombe.
      await q.query(`UPDATE google_connections SET scopes = array_remove(scopes, $2), updated_at = now() WHERE user_id = $1`, [userId, SCOPES.calendarEvents]);
      await this.o.vault.deleteConnection(q, userId, PROVIDER, { actor: "system", detail: why }).catch((e) => this.o.log?.("effacement du jeton Google", e));
      await this.journal(q, userId, "revoked", `agenda : ${why}`);
      return;
    }
    await q.query(`UPDATE google_connections SET status = 'revoked', updated_at = now() WHERE user_id = $1`, [userId]);
    await this.o.vault.deleteConnection(q, userId, PROVIDER, { actor: "system", detail: why }).catch((e) => this.o.log?.("effacement du jeton Google", e));
    await this.journal(q, userId, "revoked", why);
  }

  private async tokenRequest(form: Record<string, string>): Promise<{ ok: boolean; status: number; json: any }> {
    try {
      const res = await fetch(this.o.endpoints.token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
      const text = await res.text();
      let json: any = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {}
      return { ok: res.ok, status: res.status, json };
    } catch (e) {
      return { ok: false, status: 0, json: { error: (e as Error).name } };
    }
  }

  // ---- Appels aux API -----------------------------------------------------------------------------

  /** Appel authentifié. Un 401 force un rafraîchissement puis un seul nouvel essai. */
  async api<T = any>(q: Q, userId: string, scope: string, method: "GET" | "POST", url: string, body?: unknown, retry = true): Promise<T> {
    const service: GoogleServiceName = scope.includes("/gmail.") || scope === "https://mail.google.com/" ? "gmail" : "calendar";
    const conn = await this.connectionFor(q, userId, service);
    if (!conn) throw new GoogleError("not_connected", `${service === "gmail" ? "Gmail" : "Google Agenda"} n'est pas connecté`);
    let res: Response;
    if (conn?.method === "composio") {
      // Les mails et l'agenda passent par le proxy Composio (appli déjà validée, aucun avertissement).
      if (conn.status === "revoked") throw new GoogleError("reconnect", "l'accès ne marche plus");
      if (!conn.composio_account_id || !this.composioTransport) throw new GoogleError("unavailable", "le connecteur Google n'est pas disponible");
      try {
        res = await this.composioTransport(conn.composio_account_id, service)(url, {
          method,
          headers: body === undefined ? {} : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw new GoogleError("unavailable", "Google ne répond pas pour l'instant");
      }
      if (res.status === 401) {
        await q.query(`UPDATE app_connections SET status = 'revoked', updated_at = now() WHERE user_id = $1 AND service = $2 AND account_id = $3`, [userId, service, conn.composio_account_id]);
        await this.journal(q, userId, "revoked", `${service} : compte Composio refusé`);
        throw new GoogleError("reconnect", "l'accès à Google ne marche plus");
      }
      const t = await res.text();
      let j: any = {};
      try {
        j = t ? JSON.parse(t) : {};
      } catch {}
      if (res.ok) return j as T;
      if (res.status === 403) throw new GoogleError("missing_scope", "ce service n'a pas les permissions nécessaires chez Google");
      if (res.status === 404) throw new GoogleError("not_found", "introuvable chez Google");
      if (res.status === 429 || res.status >= 500) throw new GoogleError("unavailable", "Google ne répond pas pour l'instant");
      throw new GoogleError("refused", `Google a refusé la demande : ${String(j?.error?.message ?? res.status).slice(0, 200)}`);
    }
    const token = await this.accessToken(q, userId, scope);
    try {
      res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
    } catch {
      throw new GoogleError("unavailable", "Google ne répond pas pour l'instant");
    }
    if (res.status === 401 && retry) {
      this.tokens.delete(userId);
      return this.api<T>(q, userId, scope, method, url, body, false);
    }
    const text = await res.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {}
    if (res.ok) return json as T;
    const why = `${json?.error?.errors?.[0]?.reason ?? ""} ${json?.error?.status ?? ""} ${json?.error?.message ?? ""}`;
    if (res.status === 401) {
      await this.markRevoked(q, userId, "jeton d'accès refusé");
      throw new GoogleError("reconnect", "l'accès à Google ne marche plus");
    }
    if (res.status === 403 && /insufficient|scope/i.test(why)) throw new GoogleError("missing_scope", "ce service n'a pas été coché chez Google");
    if (res.status === 404) throw new GoogleError("not_found", "introuvable chez Google");
    if (res.status === 429 || res.status >= 500 || /ratelimit/i.test(why)) throw new GoogleError("unavailable", "Google ne répond pas pour l'instant");
    if (res.status === 403) {
      // API non activée dans le projet Google Cloud, quota du projet : c'est à nous de régler.
      this.o.log?.(`Google refuse (403) : ${why.trim().slice(0, 300)}`);
      throw new GoogleError("unavailable", "Google refuse pour l'instant");
    }
    throw new GoogleError("refused", `Google a refusé la demande : ${String(json?.error?.message ?? res.status).slice(0, 200)}`);
  }

  // ---- Déconnexion --------------------------------------------------------------------------------

  /** Révoque chez Google. Un jeton déjà mort compte comme révoqué. */
  private async revoke(token: string): Promise<boolean> {
    try {
      const res = await fetch(this.o.endpoints.revoke, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
      if (res.ok) return true;
      const json = await res.json().catch(() => ({}));
      return res.status === 400 && json?.error === "invalid_token";
    } catch {
      return false;
    }
  }

  /**
   * « Déconnecter = supprimer » (règle 8) : révocation chez Google, puis effacement du jeton au
   * coffre, de la connexion, des liens et du journal. Seule reste la ligne qui dit que c'est fait.
   */
  async disconnect(q: Q, userId: string): Promise<{ existed: boolean; revokedAtGoogle: boolean }> {
    const conn = await this.connection(q, userId);
    const secret = await this.o.vault.backend.getConnectionForUse(userId, PROVIDER).catch(() => undefined);
    const access = this.tokens.get(userId)?.token;
    let revokedAtGoogle = false;
    if (secret) revokedAtGoogle = await this.revoke(secret.refreshToken);
    else if (access) revokedAtGoogle = await this.revoke(access);
    this.tokens.delete(userId);
    await this.o.vault.deleteConnection(q, userId, PROVIDER, { actor: "agent", detail: "déconnexion demandée" });
    if (conn?.method === "app_password") await this.o.vault.deleteConnection(q, userId, APP_PROVIDER, { actor: "agent", detail: "déconnexion demandée" });
    await q.query(`DELETE FROM google_connections WHERE user_id = $1`, [userId]);
    await q.query(`DELETE FROM connect_links WHERE user_id = $1`, [userId]);
    await q.query(`DELETE FROM google_actions WHERE user_id = $1`, [userId]);
    await this.journal(q, userId, "disconnect", revokedAtGoogle ? "révoqué chez Google" : "révocation non confirmée");
    return { existed: !!conn || !!secret, revokedAtGoogle };
  }

  /** Remove one legacy service locally, preserving the other service's grant. */
  async disconnectService(q: Q, userId: string, service: GoogleServiceName): Promise<{ existed: boolean; revokedAtGoogle: boolean }> {
    const conn = await this.connection(q, userId);
    if (!conn || conn.method === "composio") return { existed: false, revokedAtGoogle: false };
    const belongs = (scope: string) => service === "gmail" ? scope.includes("/gmail.") || scope === "https://mail.google.com/" : scope.includes("/calendar");
    if (!conn.scopes.some(belongs)) return { existed: false, revokedAtGoogle: false };
    const keep = conn.scopes.filter((scope) => !belongs(scope));
    if (!keep.some((scope) => scope.includes("/gmail.") || scope.includes("/calendar") || scope === "https://mail.google.com/")) return this.disconnect(q, userId);
    if (service === "gmail" && conn.method === "app_password") {
      await this.o.vault.deleteConnection(q, userId, APP_PROVIDER, { actor: "agent", detail: "déconnexion Gmail demandée" });
    }
    await q.query(`UPDATE google_connections SET scopes = $2, method = $3, updated_at = now() WHERE user_id = $1`, [userId, keep, service === "gmail" && conn.method === "app_password" ? "oauth" : conn.method]);
    this.tokens.delete(userId);
    await this.journal(q, userId, "disconnect", service);
    return { existed: true, revokedAtGoogle: false };
  }

  // ---- Mot de passe d'application (Gmail par IMAP/SMTP) --------------------------------------------

  /** Lien du fil vers la page où elle colle son code. Ne dépend pas du client OAuth : marche sans lui. */
  async issueAppLink(q: Q, userId: string): Promise<{ url: string }> {
    const id = randomBytes(16).toString("base64url");
    await q.query(`INSERT INTO connect_links (token_hash, user_id, provider, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`, [
      sha256(id),
      userId,
      APP_PROVIDER,
      LINK_MINUTES,
    ]);
    return { url: `${this.o.publicUrl.replace(/\/+$/, "")}/connect/gmail?t=${id}` };
  }

  /** La personne derrière un lien encore valable, et l'adresse à proposer d'avance. */
  async appLink(q: Q, token: string): Promise<{ userId: string; email?: string } | undefined> {
    if (!/^[A-Za-z0-9_-]{16,40}$/.test(token)) return undefined;
    const row = (
      await q.query<{ user_id: string; email: string | null; known: string | null }>(
        `SELECT l.user_id, g.email, (SELECT address FROM mail_addresses a WHERE a.user_id = l.user_id ORDER BY created_at LIMIT 1) AS known
         FROM connect_links l LEFT JOIN google_connections g ON g.user_id = l.user_id
         WHERE l.token_hash = $1 AND l.provider = $2 AND l.used_at IS NULL AND l.expires_at > now()`,
        [sha256(token), APP_PROVIDER],
      )
    ).rows[0];
    return row ? { userId: row.user_id, email: row.email ?? row.known ?? undefined } : undefined;
  }

  /**
   * Le code collé sur la page : essayé chez Google tout de suite. Bon : rangé au coffre, mails branchés, Mell
   * l'écrit dans le fil. Refusé : le lien reste valable, au plus cinq essais.
   */
  async connectApp(db: Db, token: string, rawEmail: string, rawCode: string, check = checkLogin): Promise<AppConnectResult> {
    const link = await this.appLink(db, token);
    if (!link) return { status: "gone" };
    const email = rawEmail.trim().toLowerCase();
    const password = rawCode.replace(/[\s-]+/g, "").toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email) || !/^[a-z]{16}$/.test(password)) return { status: "invalid", userId: link.userId };
    const r = await check({ email, password });
    if (r !== "ok") {
      if (r === "refused") {
        await db.query(
          `UPDATE connect_links SET attempts = attempts + 1, used_at = CASE WHEN attempts + 1 >= $2 THEN now() END WHERE token_hash = $1`,
          [sha256(token), MAX_APP_ATTEMPTS],
        );
      }
      return { status: r, userId: link.userId };
    }
    const consumed = await db.query(`UPDATE connect_links SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL RETURNING token_hash`, [sha256(token)]);
    if (!consumed.rows.length) return { status: "gone" };
    await this.o.vault.putConnection(db, link.userId, APP_PROVIDER, { refreshToken: password }, { actor: "user_link", detail: email });
    const lang = (await getUser(db, link.userId))?.lang ?? "fr";
    await db.tx(async (q) => {
      const prev = await this.connection(q, link.userId);
      // L'agenda déjà connecté par Google reste ; les mails passent désormais par le code.
      const scopes = [...new Set([...(prev?.status === "active" ? prev.scopes : []), ...MAIL_SCOPES])];
      await q.query(
        `INSERT INTO google_connections (user_id, email, scopes, status, method) VALUES ($1, $2, $3, 'active', 'app_password')
         ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, scopes = excluded.scopes, status = 'active', method = 'app_password', connected_at = now(), updated_at = now()`,
        [link.userId, email, scopes],
      );
      await q.query(`INSERT INTO mail_addresses (user_id, address, source) VALUES ($1, $2, 'google') ON CONFLICT DO NOTHING`, [link.userId, email]);
      await this.journal(q, link.userId, "connect", `${email} (mot de passe d'application)`);
      await enqueue(q, [{ userId: link.userId, kind: "text", text: connectedBubble(lang, servicesOf(scopes), email), dedupeKey: `gmail-app-connected:${sha256(token)}` }]);
    });
    return { status: "connected", userId: link.userId, email };
  }

  /** Adresse et code pour IMAP/SMTP. Code absent du coffre : la connexion est à refaire. */
  async appCreds(q: Q, userId: string): Promise<AppCreds> {
    const conn = await this.connection(q, userId);
    if (!conn) throw new GoogleError("not_connected", "Gmail n'est pas connecté");
    if (conn.status === "revoked") throw new GoogleError("reconnect", "l'accès à Gmail ne marche plus");
    const secret = await this.o.vault.backend.getConnectionForUse(userId, APP_PROVIDER);
    if (!secret?.refreshToken || !conn.email) {
      await this.markAppRevoked(q, userId, "code absent du coffre");
      throw new GoogleError("reconnect", "l'accès à Gmail ne marche plus");
    }
    return { email: conn.email, password: secret.refreshToken };
  }

  /** Google refuse le code (retiré, ou mot de passe du compte changé) : on l'efface et on attend un nouveau lien. */
  async markAppRevoked(q: Q, userId: string, why: string): Promise<void> {
    await q.query(`UPDATE google_connections SET status = 'revoked', updated_at = now() WHERE user_id = $1`, [userId]);
    await this.o.vault.deleteConnection(q, userId, APP_PROVIDER, { actor: "system", detail: why }).catch((e) => this.o.log?.("effacement du code Gmail", e));
    await this.journal(q, userId, "revoked", why);
  }

  /** Journal des écritures (règle 9) : des identifiants, jamais de contenu. */
  async journal(q: Q, userId: string, action: string, target?: string | null, taskId?: string): Promise<void> {
    await q.query(`INSERT INTO google_actions (user_id, action, target, task_id) VALUES ($1, $2, $3, $4)`, [userId, action, target?.slice(0, 200) ?? null, taskId ?? null]);
  }
}
