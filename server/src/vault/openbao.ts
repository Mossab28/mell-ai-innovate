import { makeRef, normalizeField, normalizeSite, parseRef } from "./refs.ts";
import { parseTotpSeed } from "./totp.ts";
import { cardName, normalizeCardName } from "./refs.ts";
import { VaultError, normalizeProvider, type CardSecret, type ConnectionSecret, type LoginSecret, type Vault, type VaultRef } from "./types.ts";

/**
 * Coffre sur OpenBao (fork open source de HashiCorp Vault, MPL-2.0), par son API HTTP.
 *
 *   mella-transit/keys/u-<user>          clé AES-256-GCM propre à la personne
 *   mella-kv/data/users/<user>/login/<site>      { ct }  identifiant + mot de passe, chiffrés par sa clé
 *   mella-kv/data/users/<user>/personal/<champ>  { ct }  info perso, chiffrée par sa clé
 *   mella-kv/data/users/<user>/totp/<site>       index sans secret (pour tout retrouver à l'effacement)
 *   mella-totp/keys/<user>_<site>                graine 2FA : écrite, jamais relue ; OpenBao calcule le code
 *   mella-kv/data/users/<user>/connection/<fournisseur>  { ct }  jeton de rafraîchissement (Google), chiffré par sa clé
 *   mella-kv/data/users/<user>/card/<marque-1234>         { ct }  carte bancaire, chiffrée par sa clé
 *   mella-kv/data/server/<nom>                   réglage du serveur posé par l'admin (client OAuth Google), lecture seule
 *
 * Effacer la personne = détruire sa clé transit d'abord (tout ce qui reste, versions KV et
 * sauvegardes comprises, devient illisible), puis ses entrées KV et ses graines TOTP.
 */
export interface OpenBaoOptions {
  addr: string;
  token: string;
  kvMount?: string;
  transitMount?: string;
  totpMount?: string;
  timeoutMs?: number;
}

export class OpenBaoVault implements Vault {
  private readonly kv: string;
  private readonly transit: string;
  private readonly totp: string;
  private readonly keys = new Set<string>();
  private renewedAt = 0;

  constructor(private readonly o: OpenBaoOptions) {
    this.kv = o.kvMount ?? "mella-kv";
    this.transit = o.transitMount ?? "mella-transit";
    this.totp = o.totpMount ?? "mella-totp";
  }

  // ---- HTTP -------------------------------------------------------------------------------------

  /** Appel brut. 404 -> undefined. Les erreurs ne recopient jamais le corps envoyé. */
  private async call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<any> {
    await this.renewIfDue();
    return this.raw(method, path, body);
  }

  private async raw(method: string, path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.o.addr.replace(/\/+$/, "")}/v1/${path}`, {
        method,
        headers: { "X-Vault-Token": this.o.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 5000),
      });
    } catch (e) {
      throw new VaultError(`coffre injoignable (${(e as Error).name})`);
    }
    if (res.status === 404) return undefined;
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new VaultError(`coffre : ${res.status} ${(json.errors ?? []).join("; ").slice(0, 200)}`);
    return json;
  }

  /** Le jeton du serveur est périodique (32 jours) : on le renouvelle au plus une fois par jour. */
  private async renewIfDue(): Promise<void> {
    if (Date.now() - this.renewedAt < 24 * 3600_000) return;
    this.renewedAt = Date.now();
    await this.raw("POST", "auth/token/renew-self", {}).catch(() => {
      this.renewedAt = 0;
    });
  }

  private async list(path: string): Promise<string[]> {
    const r = await this.call("GET", `${path}?list=true`);
    return (r?.data?.keys ?? []) as string[];
  }

  // ---- Chiffrement par personne -----------------------------------------------------------------

  private keyName(userId: string): string {
    if (!/^[0-9a-f-]{8,64}$/i.test(userId)) throw new VaultError("identifiant utilisateur invalide");
    return `u-${userId}`;
  }

  private async ensureKey(userId: string): Promise<string> {
    const k = this.keyName(userId);
    if (!this.keys.has(k)) {
      await this.call("POST", `${this.transit}/keys/${k}`, { type: "aes256-gcm96" });
      this.keys.add(k);
    }
    return k;
  }

  private async seal(userId: string, value: object): Promise<string> {
    const k = await this.ensureKey(userId);
    const r = await this.call("POST", `${this.transit}/encrypt/${k}`, { plaintext: Buffer.from(JSON.stringify(value)).toString("base64") });
    return r.data.ciphertext as string;
  }

  private async open<T>(userId: string, ciphertext: string): Promise<T> {
    const r = await this.call("POST", `${this.transit}/decrypt/${this.keyName(userId)}`, { ciphertext });
    return JSON.parse(Buffer.from(r.data.plaintext, "base64").toString("utf8")) as T;
  }

  private kvPath(userId: string, kind: "login" | "personal" | "totp" | "connection" | "card", name: string): string {
    this.keyName(userId);
    return `users/${userId}/${kind}/${name}`;
  }

  private async putSealed(userId: string, kind: "login" | "personal" | "connection" | "card", name: string, value: object): Promise<void> {
    const ct = await this.seal(userId, { ...value, kind, name });
    await this.call("POST", `${this.kv}/data/${this.kvPath(userId, kind, name)}`, { data: { ct } });
  }

  private async getSealed<T extends object>(userId: string, kind: "login" | "personal" | "connection" | "card", name: string): Promise<T | undefined> {
    const r = await this.call("GET", `${this.kv}/data/${this.kvPath(userId, kind, name)}`);
    const ct = r?.data?.data?.ct;
    if (!ct) return undefined;
    const v = await this.open<T & { kind: string; name: string }>(userId, ct);
    // Le chiffré porte son emplacement : une entrée recopiée ailleurs ne s'ouvre pas.
    if (v.kind !== kind || v.name !== name) throw new VaultError("entrée de coffre incohérente");
    return v;
  }

  // ---- Contrat ----------------------------------------------------------------------------------

  async putLogin(userId: string, site: string, login: LoginSecret): Promise<VaultRef> {
    const s = normalizeSite(site);
    await this.putSealed(userId, "login", s, { username: login.username, password: login.password });
    return makeRef("login", s);
  }

  async getLoginForInjection(userId: string, site: string): Promise<LoginSecret | undefined> {
    const v = await this.getSealed<LoginSecret>(userId, "login", normalizeSite(site));
    return v && { username: v.username, password: v.password };
  }

  async putTotpSeed(userId: string, site: string, seed: string): Promise<VaultRef> {
    const s = normalizeSite(site);
    const p = parseTotpSeed(seed);
    await this.call("POST", `${this.totp}/keys/${this.totpName(userId, s)}`, {
      generate: false,
      key: p.secret,
      issuer: "Mell",
      account_name: s,
      algorithm: p.algorithm,
      digits: p.digits,
      period: `${p.period}s`,
    });
    await this.call("POST", `${this.kv}/data/${this.kvPath(userId, "totp", s)}`, { data: { digits: p.digits, period: p.period } });
    return makeRef("totp", s);
  }

  async totpCode(userId: string, site: string): Promise<string | undefined> {
    try {
      const r = await this.call("GET", `${this.totp}/code/${this.totpName(userId, normalizeSite(site))}`);
      return r?.data?.code;
    } catch (e) {
      if (/unknown key|400/.test((e as Error).message)) return undefined;
      throw e;
    }
  }

  async putPersonal(userId: string, field: string, value: string): Promise<VaultRef> {
    const f = normalizeField(field);
    await this.putSealed(userId, "personal", f, { value });
    return makeRef("personal", f);
  }

  async getPersonalForInjection(userId: string, field: string): Promise<string | undefined> {
    return (await this.getSealed<{ value: string }>(userId, "personal", normalizeField(field)))?.value;
  }

  async putCard(userId: string, card: CardSecret): Promise<VaultRef> {
    const name = cardName(card.number);
    await this.putSealed(userId, "card", name, { ...card });
    return makeRef("card", name);
  }

  async getCardForInjection(userId: string, name: string): Promise<CardSecret | undefined> {
    const v = await this.getSealed<CardSecret>(userId, "card", normalizeCardName(name));
    return v && { number: v.number, expMonth: v.expMonth, expYear: v.expYear, cvc: v.cvc, holder: v.holder };
  }

  async deleteEntry(userId: string, ref: VaultRef): Promise<boolean> {
    const { kind, name } = parseRef(ref);
    const existed = (await this.call("GET", `${this.kv}/metadata/${this.kvPath(userId, kind, name)}`)) !== undefined;
    if (kind === "totp") await this.call("DELETE", `${this.totp}/keys/${this.totpName(userId, name)}`);
    await this.call("DELETE", `${this.kv}/metadata/${this.kvPath(userId, kind, name)}`);
    return existed;
  }

  async putConnection(userId: string, provider: string, secret: ConnectionSecret): Promise<void> {
    await this.putSealed(userId, "connection", normalizeProvider(provider), { refreshToken: secret.refreshToken });
  }

  async getConnectionForUse(userId: string, provider: string): Promise<ConnectionSecret | undefined> {
    const v = await this.getSealed<ConnectionSecret>(userId, "connection", normalizeProvider(provider));
    return v && { refreshToken: v.refreshToken };
  }

  async deleteConnection(userId: string, provider: string): Promise<boolean> {
    const path = `${this.kv}/metadata/${this.kvPath(userId, "connection", normalizeProvider(provider))}`;
    const existed = (await this.call("GET", path)) !== undefined;
    await this.call("DELETE", path);
    return existed;
  }

  /** mella-kv/data/server/<nom> : posé à la main par l'admin, lu par le serveur (politique mella-server). */
  async readServerSecret(name: string): Promise<Record<string, string> | undefined> {
    if (!/^[a-z0-9-]{1,60}$/.test(name)) throw new VaultError(`réglage invalide : ${name}`);
    const r = await this.call("GET", `${this.kv}/data/server/${name}`);
    return r?.data?.data;
  }

  async deleteUser(userId: string): Promise<void> {
    const k = this.keyName(userId);
    const totps = await this.list(`${this.kv}/metadata/users/${userId}/totp`);
    // 1. Destruction de la clé : à partir d'ici, rien de chiffré pour cette personne ne se relit.
    if (await this.call("GET", `${this.transit}/keys/${k}`)) {
      await this.call("POST", `${this.transit}/keys/${k}/config`, { deletion_allowed: true });
      await this.call("DELETE", `${this.transit}/keys/${k}`);
    }
    this.keys.delete(k);
    // 2. Graines 2FA, puis toutes les entrées KV (métadonnées = toutes les versions).
    for (const site of totps) await this.call("DELETE", `${this.totp}/keys/${this.totpName(userId, site)}`);
    for (const kind of ["login", "personal", "totp", "connection", "card"] as const) {
      for (const name of await this.list(`${this.kv}/metadata/users/${userId}/${kind}`)) {
        await this.call("DELETE", `${this.kv}/metadata/${this.kvPath(userId, kind, name)}`);
      }
    }
  }

  private totpName(userId: string, site: string): string {
    this.keyName(userId);
    return `${userId}_${site}`;
  }
}
