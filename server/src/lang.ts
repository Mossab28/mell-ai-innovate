/**
 * Langue d'un message, devinée sur des mots courants. Sert à répondre dans la langue du dernier
 * message (le banc de voix a vu des réponses en anglais à « rép à Julie » et l'inverse).
 * Rend undefined quand le message est trop court pour trancher (« ok », « lol », « hey ») :
 * on garde alors la langue préférée de la personne.
 */

const FR = new Set(
  (
    "je j tu il elle on nous vous ils le la les l un une des du de au aux et ou mais donc est es suis sont c ce ça ca cette ces " +
    "mon ma mes ton ta tes son sa ses moi toi pour avec sans dans sur chez pas plus oui non merci salut bonjour bonsoir coucou " +
    "quoi qui quand comment pourquoi combien demain aujourd hier soir matin semaine rappelle rappel trouve réserve commande " +
    "regarde envoie peux veux faut fais fait as ai a qu que quel quelle stp svp bien trop très tout tous rien"
  ).split(" "),
);

const EN = new Set(
  (
    "i im you your yours my me we they he she it its the a an and or but so is are was am be do does did can could would " +
    "should will what who when where why how which to for with without in on at of from this that these those please pls plz " +
    "thanks thank thx hey hi hello yes no yeah tomorrow today tonight morning week remind find book order check send need want " +
    "got get just not dont cant whats anything something"
  ).split(" "),
);

export function detectLang(text: string | undefined | null): "fr" | "en" | undefined {
  if (!text) return undefined;
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^a-zà-ÿœ]+/i)
    .filter(Boolean);
  let fr = 0;
  let en = 0;
  for (const w of words) {
    if (FR.has(w)) fr++;
    if (EN.has(w)) en++;
  }
  // Les accents français ne mentent presque jamais.
  if (/[éèêàçùûôîœ]/i.test(text)) fr += 2;
  if (fr >= 2 && fr > en) return "fr";
  if (en >= 2 && en > fr) return "en";
  return undefined;
}
