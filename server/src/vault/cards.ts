import { VaultError, type CardSecret } from "./types.ts";

/**
 * Cartes bancaires. Décision du 14/10 : la personne range sa carte une fois, Mell la tape sur la
 * page de paiement du marchand, et chaque paiement reste soumis au 3-D Secure de sa banque
 * (validation dans son appli, ou code par SMS). C'est ce dernier verrou qui fait qu'on ose
 * confier sa carte, et il n'est pas à nous.
 *
 * Où vit la carte : au coffre, chiffrée par la clé propre à la personne (OpenBao Transit), comme
 * ses mots de passe. Le modèle n'en voit que `vault://card/visa-4242`. Elle ne passe jamais
 * dans le fil (detect.ts la retire), ni dans un journal, ni sur une capture d'écran.
 *
 * Limite assumée : garder un numéro de carte fait entrer Mell dans le périmètre PCI-DSS. Pour
 * les tests entre nous, ça passe (roadmap, phase 2). Avant le public, la carte brute laisse la
 * place à une carte à usage unique émise par un tiers (Stripe Issuing, ou une carte virtuelle
 * de la banque), du montant exact, pour un seul marchand ; le reste du parcours ne change pas.
 */

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

const MSG = {
  fr: { number: "Ce numéro de carte n'est pas valide.", exp: "Date d'expiration invalide (MM/AA).", expired: "Cette carte est expirée.", cvc: "Le cryptogramme fait 3 ou 4 chiffres." },
  en: { number: "That card number isn't valid.", exp: "Invalid expiry date (MM/YY).", expired: "This card has expired.", cvc: "The security code is 3 or 4 digits." },
};

/** Valide le formulaire de la page du lien. Lève VaultError avec un message pour la personne. */
export function parseCardForm(body: Record<string, string>, lang: "fr" | "en", now = new Date()): CardSecret {
  const t = MSG[lang];
  const number = (body.number ?? "").replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(number) || !luhn(number)) throw new VaultError(t.number);
  // Le clavier numérique de l'iPhone n'a pas de « / » : « 1228 », « 122028 » ou « 828 » valent aussi 12/28 (19/10).
  const raw = (body.exp ?? "").trim();
  const m = /^(\d{1,2})\s*[/.\- ]\s*(\d{2}|\d{4})$/.exec(raw) ?? /^(\d{2})(\d{2}|\d{4})$/.exec(raw) ?? /^(\d)(\d{2})$/.exec(raw);
  if (!m) throw new VaultError(t.exp);
  const expMonth = Number(m[1]);
  const expYear = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  if (expMonth < 1 || expMonth > 12) throw new VaultError(t.exp);
  if (expYear * 12 + expMonth < now.getUTCFullYear() * 12 + now.getUTCMonth() + 1) throw new VaultError(t.expired);
  const cvc = (body.cvc ?? "").trim();
  if (!/^\d{3,4}$/.test(cvc)) throw new VaultError(t.cvc);
  const holder = (body.holder ?? "").trim().slice(0, 80) || undefined;
  return { number, expMonth, expYear, cvc, holder };
}
