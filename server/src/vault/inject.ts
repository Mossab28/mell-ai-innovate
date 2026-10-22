import type { Db } from "../db.ts";
import { parseRef, siteMatchesHost } from "./refs.ts";
import type { VaultService } from "./service.ts";
import { VaultError, type CardSecret, type VaultRef } from "./types.ts";
import type { FillPolicy } from "../browser/types.ts";

type Q = Pick<Db, "query">;

export type FieldRole = "username" | "password" | "totp" | `personal:${string}` | CardRole;

/** Champs d'un formulaire de carte. L'échéance est en un champ (MM/AA) ou en deux (mois, année). */
export type CardRole = "card_number" | "card_exp" | "card_exp_month" | "card_exp_year" | "card_cvc" | "card_holder";

/**
 * Ce que le navigateur de la tâche doit savoir faire pour recevoir un secret. L'implémentation
 * (Playwright/CDP sur le Chrome de l'atelier, ou les `sensitive_data` de browser-use) repère le
 * champ du bon rôle et y tape la valeur. La valeur ne remonte jamais vers le modèle : pas de
 * capture du champ, pas de retour texte.
 */
export interface FillTarget {
  /** URL de la page courante : sert au garde-fou de domaine. */
  url(): Promise<string>;
  fill(role: FieldRole, value: string, policy?: FillPolicy): Promise<void>;
}

/** Fournit le navigateur de la tâche en cours d'une personne. Pas encore branché : undefined. */
export type BrowserProvider = (userId: string, taskId: string) => Promise<FillTarget | undefined>;

export type FillResult =
  | { status: "filled"; ref: VaultRef; fields: FieldRole[] }
  | { status: "no_browser"; ref: VaultRef }
  | { status: "missing"; ref: VaultRef };

/**
 * Remplit la page avec une entrée du coffre. Le résultat ne dit que quels champs ont été remplis.
 * Refuse si la page n'est pas sur le site de l'identifiant (hameçonnage, page piégée).
 */
export async function fillFromVault(
  q: Q,
  vault: VaultService,
  browser: BrowserProvider,
  p: { userId: string; taskId: string; ref: VaultRef },
): Promise<FillResult> {
  const { kind, name } = parseRef(p.ref);
  if (!(await vault.has(q, p.userId, p.ref))) return { status: "missing", ref: p.ref };
  const target = await browser(p.userId, p.taskId);
  if (!target) return { status: "no_browser", ref: p.ref };

  const url = await target.url();
  // Une carte n'a pas de site : elle se tape sur la page de paiement du marchand, et seulement dans
  // une tâche qui couvre le paiement (vérifié par l'appelant). La banque montre le marchand et le montant au 3-D Secure.
  if (kind === "card" && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new VaultError("une carte ne se tape que sur une page sécurisée (https)");
  if (kind !== "personal" && kind !== "card" && !siteMatchesHost(name, url)) {
    await vault.log(q, p.userId, p.ref, "refused", { actor: "agent", taskId: p.taskId, detail: `page hors du site : ${safeHost(url)}` });
    throw new VaultError(`la page ouverte (${safeHost(url)}) n'est pas sur ${name} : rien n'a été tapé`);
  }
  const secret = await vault.reveal(q, p.userId, p.ref, { actor: "agent", taskId: p.taskId, detail: safeHost(url) });
  if (!secret) return { status: "missing", ref: p.ref };

  const fields: FieldRole[] = [];
  const fillCredential = async (role: FieldRole, value: string) => {
    // La saisie du premier champ peut naviguer : on contrôle aussi chaque champ suivant.
    const current = await target.url();
    if (!siteMatchesHost(name, current)) {
      await vault.log(q, p.userId, p.ref, "refused", { actor: "agent", taskId: p.taskId, detail: `page hors du site : ${safeHost(current)}` });
      throw new VaultError("la page a quitté le site autorisé : saisie interrompue");
    }
    await target.fill(role, value, { credentialSite: name });
    fields.push(role);
  };
  if (secret.login) {
    if (secret.login.username) {
      await fillCredential("username", secret.login.username);
    }
    await fillCredential("password", secret.login.password);
  } else if (secret.card) {
    fields.push(...(await fillCard(target, secret.card)));
  } else if (secret.code) {
    await fillCredential("totp", secret.code);
  } else if (secret.value) {
    await target.fill(`personal:${name}`, secret.value);
    fields.push(`personal:${name}`);
  }
  return { status: "filled", ref: p.ref, fields };
}

/** Tape la carte champ par champ. Le numéro est obligatoire ; le reste, selon ce que la page demande. */
async function fillCard(target: FillTarget, c: CardSecret): Promise<FieldRole[]> {
  const done: FieldRole[] = [];
  const tryFill = async (role: FieldRole, value: string) => {
    try {
      await target.fill(role, value);
      done.push(role);
      return true;
    } catch {
      return false;
    }
  };
  if (!(await tryFill("card_number", c.number.replace(/\D/g, "")))) throw new VaultError("aucun champ de numéro de carte sur cette page");
  const mm = String(c.expMonth).padStart(2, "0");
  const yy = String(c.expYear).slice(-2);
  if (!(await tryFill("card_exp", `${mm}/${yy}`))) {
    await tryFill("card_exp_month", mm);
    await tryFill("card_exp_year", String(c.expYear));
  }
  await tryFill("card_cvc", c.cvc);
  if (c.holder) await tryFill("card_holder", c.holder);
  return done;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "adresse illisible";
  }
}
