import { cardName, makeRef, normalizeCardName, normalizeField, normalizeSite, parseRef } from "./refs.ts";
import { generateTotp, parseTotpSeed, type TotpParams } from "./totp.ts";
import { normalizeProvider, type CardSecret, type ConnectionSecret, type LoginSecret, type Vault, type VaultRef } from "./types.ts";

/** Coffre en mémoire, pour les tests et le simulateur. Même contrat qu'OpenBao, aucun chiffrement. */
export class MemoryVault implements Vault {
  private logins = new Map<string, LoginSecret>();
  private totps = new Map<string, TotpParams>();
  private personal = new Map<string, string>();
  private connections = new Map<string, ConnectionSecret>();
  private cards = new Map<string, CardSecret>();
  private server = new Map<string, Record<string, string>>();

  private k(userId: string, name: string) {
    return `${userId}\u0000${name}`;
  }

  async putLogin(userId: string, site: string, login: LoginSecret): Promise<VaultRef> {
    this.logins.set(this.k(userId, normalizeSite(site)), { username: login.username, password: login.password });
    return makeRef("login", site);
  }

  async getLoginForInjection(userId: string, site: string): Promise<LoginSecret | undefined> {
    const l = this.logins.get(this.k(userId, normalizeSite(site)));
    return l && { ...l };
  }

  async putTotpSeed(userId: string, site: string, seed: string): Promise<VaultRef> {
    this.totps.set(this.k(userId, normalizeSite(site)), parseTotpSeed(seed));
    return makeRef("totp", site);
  }

  async totpCode(userId: string, site: string): Promise<string | undefined> {
    const p = this.totps.get(this.k(userId, normalizeSite(site)));
    return p && generateTotp(p);
  }

  async putPersonal(userId: string, field: string, value: string): Promise<VaultRef> {
    this.personal.set(this.k(userId, normalizeField(field)), value);
    return makeRef("personal", field);
  }

  async getPersonalForInjection(userId: string, field: string): Promise<string | undefined> {
    return this.personal.get(this.k(userId, normalizeField(field)));
  }

  async putCard(userId: string, card: CardSecret): Promise<VaultRef> {
    const name = cardName(card.number);
    this.cards.set(this.k(userId, name), { ...card });
    return makeRef("card", name);
  }

  async getCardForInjection(userId: string, name: string): Promise<CardSecret | undefined> {
    const c = this.cards.get(this.k(userId, normalizeCardName(name)));
    return c && { ...c };
  }

  async deleteEntry(userId: string, ref: VaultRef): Promise<boolean> {
    const { kind, name } = parseRef(ref);
    const store: Map<string, unknown> = kind === "login" ? this.logins : kind === "totp" ? this.totps : kind === "card" ? this.cards : this.personal;
    return store.delete(this.k(userId, name));
  }

  async putConnection(userId: string, provider: string, secret: ConnectionSecret): Promise<void> {
    this.connections.set(this.k(userId, normalizeProvider(provider)), { refreshToken: secret.refreshToken });
  }

  async getConnectionForUse(userId: string, provider: string): Promise<ConnectionSecret | undefined> {
    const c = this.connections.get(this.k(userId, normalizeProvider(provider)));
    return c && { ...c };
  }

  async deleteConnection(userId: string, provider: string): Promise<boolean> {
    return this.connections.delete(this.k(userId, normalizeProvider(provider)));
  }

  async readServerSecret(name: string): Promise<Record<string, string> | undefined> {
    return this.server.get(name);
  }

  /** Tests et simulateur : pose un réglage serveur, comme l'admin le ferait dans OpenBao. */
  putServerSecret(name: string, value: Record<string, string>): void {
    this.server.set(name, value);
  }

  async deleteUser(userId: string): Promise<void> {
    for (const store of [this.logins, this.totps, this.personal, this.connections, this.cards] as Array<Map<string, unknown>>) {
      for (const key of [...store.keys()]) if (key.startsWith(`${userId}\u0000`)) store.delete(key);
    }
  }
}
