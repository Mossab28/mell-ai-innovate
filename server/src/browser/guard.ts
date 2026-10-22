import type { PageElement } from "./types.ts";

/**
 * Le garde du clic. Un bouton qui engage (payer, confirmer une réservation, envoyer un message,
 * créer un compte, résilier, supprimer) ne se clique pas avec `click` : il passe par `commit`,
 * qui consulte l'autorisation de la tâche (tasks.ts, decideStep). Décidé dans le code, sur le
 * libellé de l'élément, pas par le modèle : une page piégée ne peut pas le contourner en
 * convainquant le modèle que « Payer » est un bouton de recherche.
 *
 * Les actions hors de la liste de tasks.ts (create_account, delete_data) ne sont jamais
 * autorisables : decideStep les refuse toujours, il faut redemander.
 */

export type CommitAction = "pay" | "buy" | "book" | "message_contact" | "cancel_subscription" | "create_account" | "delete_data";

const RULES: Array<[RegExp, CommitAction]> = [
  [/\b(payer|paiement s[ée]curis[ée]|pay now|place (your |my )?order|passer (la |ma )?commande|valider (la |ma |mon )?(commande|paiement|achat)|confirmer (la |ma |mon )?(commande|paiement|achat)|proc[ée]der au paiement|acheter maintenant|buy now|achat en 1-?clic|complete purchase|r[ée]gler)\b/i, "pay"],
  [/\b((confirmer|finaliser|valider|terminer) (la |ma |cette |votre )?r[ée]servation|confirm (the |your )?(booking|reservation)|complete (the |your )?(booking|reservation)|book now|reserve now|je r[ée]serve)\b/i, "book"],
  [/\b(r[ée]silier|cancel (my |your )?(subscription|membership|plan)|annuler (mon |l'|l’|votre )?abonnement|se d[ée]sabonner|end (my )?membership)\b/i, "cancel_subscription"],
  [/\b(cr[ée]er (un |mon |votre )?compte|s['’]inscrire|je m['’]inscris|sign ?up|create (an |my )?account|register now|join now)\b/i, "create_account"],
  [/\b(supprimer (mon |le |votre )?(compte|profil|historique|donn[ée]es)|delete (my |your )?(account|profile|data)|close (my )?account)\b/i, "delete_data"],
  [/\b(envoyer( le| mon| ce| votre)? (message|mail|e-mail|avis|commentaire|demande|candidature)|send (the |a )?(message|email|request)|publier|post (it|now|review)|tweeter)\b/i, "message_contact"],
];

/** Un « Réserver » nu n'engage qu'en bout de parcours, quand les coordonnées sont remplies. */
const SOFT_BOOK = /^\s*(r[ée]server|book|reserve|confirmer|confirm|valider|continuer vers le paiement)\b/i;
const SOFT_SEND = /^\s*(envoyer|send|submit|soumettre)\s*$/i;

export function commitActionFor(el: Pick<PageElement, "name" | "role" | "type">, ctx: { personalFilled: boolean }): CommitAction | undefined {
  const label = el.name.replace(/^Champ sensible /, "");
  if (/\b(code|otp)\b/i.test(label) && /\b(envoyer|send|recevoir|renvoyer|resend)\b/i.test(label)) return undefined; // « Envoyer le code » : étape de connexion
  for (const [re, action] of RULES) if (re.test(label)) return action;
  if (ctx.personalFilled && SOFT_BOOK.test(label)) return "book";
  if (ctx.personalFilled && SOFT_SEND.test(label)) return "message_contact";
  return undefined;
}
