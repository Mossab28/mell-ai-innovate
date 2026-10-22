/**
 * Les mains de Mell : un navigateur par personne, piloté par une boucle d'agent.
 *
 * Tout ce qui ouvre une page passe par ces deux interfaces. Un moteur (Chrome patché, Camoufox,
 * nodriver...) n'est qu'une implémentation : la boucle, la politique, le coffre et le profil
 * chiffré ne savent pas lequel tourne derrière.
 */

/** Cookies + stockage local, au format Playwright. C'est ce qu'on chiffre et garde par personne. */
export interface StorageState {
  cookies: Array<Record<string, unknown>>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

export interface OpenOptions {
  storageState?: StorageState;
  /** fr-FR par défaut. */
  locale?: string;
  /** Europe/Paris par défaut. */
  timezoneId?: string;
}

/** Un élément actionnable de la page, désigné au modèle par sa référence (e12, f1e3). */
export interface PageElement {
  ref: string;
  role: string;
  name: string;
  type?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  href?: string;
  options?: string[];
  /** Champ de mot de passe ou de code : jamais de valeur, jamais en clair sur une capture. */
  sensitive?: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** Texte visible de la page (cadres compris), borné. */
  text: string;
  totalText: number;
  elements: PageElement[];
  /** La page contient des champs perso déjà remplis (mail, téléphone, nom) : on est en fin de parcours. */
  personalFilled: boolean;
  /** Statut HTTP du document principal quand le moteur le connaît. */
  status?: number;
  /** Morceau du HTML (scripts compris) : c'est là que les fournisseurs anti-robot se nomment. */
  html?: string;
}

/** Rôle d'un champ que le coffre peut remplir. Même type que vault/inject.ts. */
export type FillRole = "username" | "password" | "totp" | `personal:${string}` | "card_number" | "card_exp" | "card_exp_month" | "card_exp_year" | "card_cvc" | "card_holder";

/** Domaine fixé par l'entrée du coffre, obligatoire pour les identifiants et codes 2FA. */
export interface FillPolicy { credentialSite?: string }

/** Une page ouverte pour une personne. Toutes les méthodes lèvent BrowserError en cas d'échec. */
export interface PageDriver {
  readonly engine: string;
  url(): Promise<string>;
  goto(url: string, timeoutMs?: number): Promise<{ status?: number }>;
  snapshot(opts?: { textOffset?: number; textLimit?: number }): Promise<PageSnapshot>;
  click(ref: string): Promise<void>;
  type(ref: string, text: string, opts?: { submit?: boolean; secret?: boolean }): Promise<void>;
  select(ref: string, value: string): Promise<void>;
  press(key: string): Promise<void>;
  scroll(direction: "down" | "up"): Promise<void>;
  back(): Promise<void>;
  /** JPEG, champs sensibles masqués. */
  screenshot(): Promise<Buffer>;
  /** Les résultats répétés de la page (photo, lien, prix), repérés par leur structure : listing.ts. */
  listing?(): Promise<Array<{ index: number; title: string; price?: string; text: string; url?: string; image?: string }>>;
  /** Lien et photo d'une option (logement, produit) autour d'un élément : sert à en faire une carte. */
  cardOf?(ref: string): Promise<{ href?: string; image?: string }>;
  /** Repère le champ du bon rôle dans la page et y tape la valeur. Rien ne remonte. */
  fillRole(role: FillRole, value: string, policy?: FillPolicy): Promise<boolean>;
  /** Une date dans un champ natif, un champ texte (au format de son exemple) ou un calendrier ouvert par ce bouton. Rend ce qui a été fait. */
  setDate?(ref: string, date: string, time?: string): Promise<string>;
  /** Taper dans un champ à suggestions puis cliquer celle qui correspond le mieux à `choice` (ou au texte tapé). */
  pickSuggestion?(ref: string, text: string, choice?: string): Promise<{ chosen: string; others: string[] }>;
  storageState(): Promise<StorageState>;
  close(): Promise<void>;
  /**
   * La page Playwright vivante, pour les parcours enregistrés (sites/) qui lisent les réponses
   * JSON du site et cliquent par sélecteurs stables. Absent sur les moteurs non Playwright.
   */
  playwright?(): Promise<unknown>;
}

/** Un moteur : un processus navigateur (local ou distant) qui ouvre des pages isolées. */
export interface BrowserEngine {
  readonly name: string;
  open(opts: OpenOptions): Promise<PageDriver>;
  close(): Promise<void>;
}

export type ErrorCategory =
  | "element_introuvable"
  | "page_changee"
  | "iframe"
  | "cookies"
  | "detection_robot"
  | "capture"
  | "session_perdue"
  | "delai"
  | "navigation"
  | "politique"
  | "autre";

export class BrowserError extends Error {
  constructor(
    message: string,
    readonly category: ErrorCategory = "autre",
  ) {
    super(message);
  }
}
