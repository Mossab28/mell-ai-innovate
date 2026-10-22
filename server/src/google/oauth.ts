import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * OAuth 2.0 web de Google, en code maison : portées, lien signé, état signé, PKCE.
 * Rien n'est stocké pour l'aller vers Google : l'état et le vérificateur PKCE se recalculent
 * à partir d'une clé dérivée du secret du client.
 */

/** Les portées demandées, au plus juste. Chacune sert un outil précis. */
export const SCOPES = {
  // Identité OpenID : rend l'id_token d'où l'on tire l'adresse du compte.
  openid: "openid",
  // Adresse du compte connecté : dite à la personne et au modèle (« Google connecté : moss@gmail.com »).
  email: "email",
  // gmail_search, gmail_read : chercher et lire, sans pouvoir rien effacer, classer ni envoyer.
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  // gmail_draft, gmail_send : brouillons et envoi ; ne donne ni lecture de la boîte ni suppression.
  gmailCompose: "https://www.googleapis.com/auth/gmail.compose",
  // calendar_list, calendar_create : lire et poser des événements, sans toucher aux réglages ni au partage des agendas.
  calendarEvents: "https://www.googleapis.com/auth/calendar.events",
} as const;

export const ALL_SCOPES = Object.values(SCOPES);

/** Ce que la personne a vraiment coché sur l'écran de Google (elle peut décocher un service). */
export function servicesOf(scopes: string[]): { mailRead: boolean; mailSend: boolean; calendar: boolean } {
  const any = (...values: string[]) => values.some((s) => scopes.includes(s));
  const modify = "https://www.googleapis.com/auth/gmail.modify";
  const full = "https://mail.google.com/";
  return {
    mailRead: any(SCOPES.gmailRead, modify, full),
    mailSend: any(SCOPES.gmailCompose, "https://www.googleapis.com/auth/gmail.send", modify, full),
    calendar: any(SCOPES.calendarEvents, "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events.readonly"),
  };
}

/** Durée de vie d'un lien envoyé dans le fil (comme les liens du coffre). */
export const LINK_MINUTES = 30;

const b64u = (b: Buffer) => b.toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Clé de signature des liens et des états, dérivée du secret du client OAuth. */
export function signingKey(clientSecret: string): Buffer {
  return createHash("sha256").update(`mella/connect/v1\0${clientSecret}`).digest();
}

function mac(key: Buffer, purpose: string, data: string, bytes = 32): string {
  return b64u(createHmac("sha256", key).update(`${purpose}\0${data}`).digest().subarray(0, bytes));
}

function sameMac(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Lien court du fil : `<id>.<signature>`. L'id (128 bits) n'est gardé en base que haché ; la
 * signature écarte un lien fabriqué avant même de toucher la base.
 */
export function newLinkToken(key: Buffer): { token: string; hash: string } {
  const id = b64u(randomBytes(16));
  return { token: `${id}.${mac(key, "link", id, 12)}`, hash: sha256(id) };
}

/** Haché de l'id si la signature est bonne, sinon undefined. */
export function checkLinkToken(key: Buffer, token: string): string | undefined {
  const m = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{16})$/.exec(token);
  if (!m || !sameMac(m[2], mac(key, "link", m[1], 12))) return undefined;
  return sha256(m[1]);
}

export interface OAuthState {
  /** Haché du lien d'où vient l'aller : le retour le consomme. */
  link: string;
  user: string;
  nonce: string;
  /** Expiration (ms epoch). */
  exp: number;
}

/** État signé envoyé à Google et relu au retour : lié à la personne et au lien. */
export function signState(key: Buffer, s: Omit<OAuthState, "nonce" | "exp">, ttlMs = LINK_MINUTES * 60_000): { state: string; nonce: string } {
  const body: OAuthState = { ...s, nonce: b64u(randomBytes(12)), exp: Date.now() + ttlMs };
  const payload = b64u(Buffer.from(JSON.stringify(body)));
  return { state: `${payload}.${mac(key, "state", payload)}`, nonce: body.nonce };
}

export function readState(key: Buffer, state: string): OAuthState | undefined {
  const m = /^([A-Za-z0-9_-]{20,600})\.([A-Za-z0-9_-]{43})$/.exec(state);
  if (!m || !sameMac(m[2], mac(key, "state", m[1]))) return undefined;
  try {
    const s = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")) as OAuthState;
    return typeof s.exp === "number" && s.exp > Date.now() && s.link && s.user && s.nonce ? s : undefined;
  } catch {
    return undefined;
  }
}

/** PKCE (S256) sans stockage : le vérificateur se recalcule à partir du nonce de l'état. */
export function pkceVerifier(key: Buffer, nonce: string): string {
  return mac(key, "pkce", nonce);
}

export function pkceChallenge(verifier: string): string {
  return b64u(createHash("sha256").update(verifier).digest());
}

/** Adresse de l'écran de consentement : hors ligne (jeton de rafraîchissement), consentement redemandé. */
export function consentUrl(
  authEndpoint: string,
  p: { clientId: string; redirectUri: string; state: string; challenge: string; loginHint?: string },
): string {
  const u = new URL(authEndpoint);
  const q = {
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: ALL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    ...(p.loginHint ? { login_hint: p.loginHint } : {}),
  };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Adresse du compte lue dans l'id_token. Reçu directement de Google par TLS, en échange du code :
 * OpenID Connect permet alors de se passer de la vérification de signature.
 */
export function emailFromIdToken(idToken: string | undefined): string | undefined {
  const part = idToken?.split(".")[1];
  if (!part) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof claims.email === "string" ? claims.email.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
