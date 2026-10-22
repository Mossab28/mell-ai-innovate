import type { PageDriver, PageSnapshot } from "./types.ts";

/**
 * Après « Payer » : la banque de la personne demande sa validation (3-D Secure), dans son appli
 * ou par un code reçu par SMS. Mell la prévient tout de suite, puis surveille la page jusqu'à
 * la confirmation du marchand, un refus, ou un champ de code à remplir. C'est le dernier verrou
 * (règle 7) : il n'est pas à nous, et rien ne part sans lui.
 */

export type BankOutcome = "approved" | "declined" | "code" | "timeout";

export const BANK_WAIT_MS = 6 * 60_000;

/** Confirmation du marchand : commande, réservation ou paiement passé. */
const APPROVED =
  /(?<![\p{L}\d])(merci pour (votre|ta) (commande|achat|réservation)|commande (confirmée|validée|enregistrée|n°|no\.?|numéro)|paiement (accepté|confirmé|validé|réussi|effectué)|réservation (confirmée|validée)|votre commande a (bien )?été|thank(s| you) for (your )?(order|purchase|booking)|order (confirmed|placed|number|#)|payment (successful|succeeded|complete|confirmed|received)|booking confirmed|your order has been)(?![\p{L}\d])/iu;

/** Refus de la banque ou du marchand. */
const DECLINED =
  /(?<![\p{L}\d])(paiement (refusé|rejeté|échoué|a échoué|non autorisé|annulé)|transaction (refusée|déclinée|annulée|échouée)|carte (refusée|déclinée)|échec (du paiement|de l'authentification|de l’authentification)|authentification (échouée|refusée)|payment (declined|failed|was declined|unsuccessful|could not be (processed|completed))|card (was )?declined|authentication (failed|unsuccessful)|transaction (declined|failed))(?![\p{L}\d])/iu;

/** La banque demande un code dans la page (SMS) plutôt qu'une validation dans l'appli. */
const CODE_FIELD = /(?<![\p{L}\d])(code (de (sécurité|vérification|confirmation|validation)|reçu par sms|à usage unique|sms)|saisissez le code|entrez le code|one[- ]time (pass)?code|verification code|enter (the )?code|sms code|otp)(?![\p{L}\d])/iu;

/** Écran d'attente du 3-D Secure : « validez dans votre application ». Sert seulement à journaliser. */
const PENDING = /(?<![\p{L}\d])(valide[zr]? (le paiement |l'opération |l’opération |cette opération )?(dans|sur|depuis) (votre|ton|l'|l’)?\s*app|application (bancaire|mobile)|confirm (in|on) your (banking )?app|approve (it |the payment )?in your (banking )?app|3-?d ?secure|authentification forte)(?![\p{L}\d])/iu;

export interface BankWaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  /** Rappel envoyé une fois si la banque n'a toujours rien dit (« Toujours en attente de ta banque »). */
  remindAfterMs?: number;
  onRemind?(): Promise<void>;
  onState?(state: "pending" | "unknown", url: string): void;
}

/** Ce que dit la page, d'après son texte (cadres compris) et ses champs. */
export function readBankState(s: Pick<PageSnapshot, "text" | "elements" | "title">): Exclude<BankOutcome, "timeout"> | "pending" | "unknown" {
  const text = `${s.title}\n${s.text}`;
  if (DECLINED.test(text)) return "declined";
  if (APPROVED.test(text)) return "approved";
  const codeField = s.elements.some((e) => e.role === "textbox" && (CODE_FIELD.test(e.name) || /one-time-code/.test(e.name)));
  if (codeField || (CODE_FIELD.test(text) && s.elements.some((e) => e.role === "textbox" && !e.value))) return "code";
  return PENDING.test(text) ? "pending" : "unknown";
}

export async function waitForBank(page: PageDriver, o: BankWaitOptions = {}): Promise<BankOutcome> {
  const until = Date.now() + (o.timeoutMs ?? BANK_WAIT_MS);
  const started = Date.now();
  let reminded = false;
  // La page du marchand met quelques secondes à passer au 3-D Secure : on lui laisse le temps.
  await sleep(4000, o.signal);
  while (Date.now() < until && !o.signal?.aborted) {
    try {
      const s = await page.snapshot({ textLimit: 20_000 });
      const state = readBankState(s);
      if (state === "approved" || state === "declined" || state === "code") return state;
      o.onState?.(state, s.url);
    } catch {
      // Redirection en cours (retour de la banque vers le marchand) : on relit au tour suivant.
    }
    if (!reminded && o.onRemind && Date.now() - started > (o.remindAfterMs ?? 120_000)) {
      reminded = true;
      await o.onRemind().catch(() => {});
    }
    await sleep(o.pollMs ?? 4000, o.signal);
  }
  return "timeout";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });
}
