/**
 * Coffre par utilisateur : identifiants de sites, authentificateur 2FA, infos perso.
 *
 * Règle d'or : le modèle ne voit JAMAIS une valeur. Il manipule des références opaques
 * (`vault://login/resy.com`) et c'est le code qui injecte la valeur dans le navigateur.
 * Les méthodes qui rendent une valeur (`getLoginForInjection`, `totpCode`, `getPersonalForInjection`)
 * ne sont appelées que par l'injecteur (inject.ts), jamais depuis un résultat d'outil.
 */

export type VaultKind = "login" | "totp" | "personal" | "card";
export type VaultRef = `vault://${VaultKind}/${string}`;

export interface LoginSecret {
  username: string;
  password: string;
}

/**
 * Carte bancaire, rangée par la personne sur la page du lien (phase de test entre nous, voir cards.ts).
 * Le modèle n'en voit que la référence `vault://card/visa-4242`.
 */
export interface CardSecret {
  number: string;
  /** 1 à 12. */
  expMonth: number;
  /** Quatre chiffres. */
  expYear: number;
  cvc: string;
  holder?: string;
}

export interface ConnectionSecret {
  refreshToken: string;
}

/** Fournisseur de connexion : un nom court (google). */
export function normalizeProvider(p: string): string {
  if (!/^[a-z][a-z0-9_-]{1,30}$/.test(p)) throw new VaultError(`fournisseur invalide : ${p}`);
  return p;
}

/** Champs d'infos perso reconnus. Libres, mais normalisés (minuscules, a-z0-9_). */
export const PERSONAL_FIELDS = ["full_name", "email", "phone", "address", "birthdate"] as const;

/** Le contrat commun à OpenBao (prod) et à la mémoire (tests). */
export interface Vault {
  putLogin(userId: string, site: string, login: LoginSecret): Promise<VaultRef>;
  /** Réservé à l'injecteur. */
  getLoginForInjection(userId: string, site: string): Promise<LoginSecret | undefined>;
  /** `seed` : clé base32 affichée sous le QR code, ou URI `otpauth://totp/...`. Écrite, jamais relue. */
  putTotpSeed(userId: string, site: string, seed: string): Promise<VaultRef>;
  /** Code à 6 chiffres calculé par le coffre. Réservé à l'injecteur. */
  totpCode(userId: string, site: string): Promise<string | undefined>;
  putPersonal(userId: string, field: string, value: string): Promise<VaultRef>;
  /** Réservé à l'injecteur. */
  getPersonalForInjection(userId: string, field: string): Promise<string | undefined>;
  /** Range une carte ; rend sa référence (marque et quatre derniers chiffres). */
  putCard(userId: string, card: CardSecret): Promise<VaultRef>;
  /** Réservé à l'injecteur, au moment de payer. */
  getCardForInjection(userId: string, name: string): Promise<CardSecret | undefined>;
  /** Efface une entrée. */
  deleteEntry(userId: string, ref: VaultRef): Promise<boolean>;
  /**
   * Secret d'une connexion à un compte (jeton de rafraîchissement Google), chiffré comme le reste.
   * Hors des références vault:// : ni listé au modèle, ni injectable dans une page.
   */
  putConnection(userId: string, provider: string, secret: ConnectionSecret): Promise<void>;
  /** Réservé au client du fournisseur (google/). */
  getConnectionForUse(userId: string, provider: string): Promise<ConnectionSecret | undefined>;
  deleteConnection(userId: string, provider: string): Promise<boolean>;
  /** Réglage secret du serveur rangé au coffre par l'admin (client OAuth Google). undefined s'il n'y est pas. */
  readServerSecret(name: string): Promise<Record<string, string> | undefined>;
  /** Efface tout le coffre de la personne, sans retour possible. */
  deleteUser(userId: string): Promise<void>;
}

export class VaultError extends Error {}
