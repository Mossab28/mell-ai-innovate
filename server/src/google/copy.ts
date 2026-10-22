/**
 * Ce que la personne lit : pages de connexion et bulle d'après connexion. Rien de technique
 * (règle 10) : on « connecte Google », on ne parle ni d'accès, ni de jeton, ni d'autorisation.
 */

export const COPY = {
  fr: {
    title: "Connecte Google à Mell",
    preview: "Un toucher, et Mell voit tes mails et ton agenda.",
    going: "On t'emmène chez Google…",
    go: "Continuer avec Google",
    done: "C'est fait. Tu peux retourner dans Messages.",
    nothing: "Rien n'a été connecté : il faut cocher tes mails et ton agenda chez Google. Tu peux retourner dans Messages.",
    denied: "Rien n'a été connecté. Si tu changes d'avis, le lien marche encore un moment.",
    failed: "Ça n'a pas marché. Réessaie dans un instant avec le même lien.",
    gone: "Ce lien a déjà servi ou a expiré. Demande-en un autre à Mell.",
    notYet: "Ce n'est pas encore disponible. Mell te prévient dès que ça l'est.",
  },
  en: {
    title: "Connect Google to Mell",
    preview: "One tap and Mell can see your email and calendar.",
    going: "Taking you to Google…",
    go: "Continue with Google",
    done: "All set. You can go back to Messages.",
    nothing: "Nothing was connected: your email and calendar need to be ticked on Google's page. You can go back to Messages.",
    denied: "Nothing was connected. If you change your mind, the link still works for a little while.",
    failed: "That didn't work. Try again in a moment with the same link.",
    gone: "This link was already used or has expired. Ask Mell for a new one.",
    notYet: "This isn't available yet. Mell will tell you when it is.",
  },
};
export type Copy = (typeof COPY)["fr"];

/** La page où elle colle son mot de passe d'application (/connect/gmail). Les gestes, rien d'autre. */
export const APP_COPY = {
  fr: {
    title: "Branche ta boîte Gmail à Mell",
    preview: "Deux gestes chez Google, et Mell voit ta boîte.",
    step1: "Sur la page Google, tape « Mell » puis touche Créer.",
    open: "Ouvrir la page Google",
    twosv: "Google dit que l'option n'existe pas ? Active d'abord la validation en deux étapes, puis reviens ici.",
    twosvLink: "Activer la validation en deux étapes",
    step2: "Copie le code de 16 lettres et colle-le ici.",
    email: "Ton adresse Gmail",
    code: "Le code",
    submit: "Connecter",
    trust: "Ce code sert seulement à Mell. Ce n'est pas ton mot de passe, et tu peux le retirer quand tu veux sur la même page Google.",
    refused: "Google refuse ce code. Vérifie l'adresse et recopie le code.",
    invalid: "Il faut ton adresse Gmail et le code de 16 lettres.",
    unavailable: "Google ne répond pas. Réessaie dans une minute.",
  },
  en: {
    title: "Connect your Gmail to Mell",
    preview: "Two taps on Google's side, and Mell can see your inbox.",
    step1: "On Google's page, type \u201cMell\u201d and tap Create.",
    open: "Open Google's page",
    twosv: "Google says the option isn't available? Turn on 2-Step Verification first, then come back here.",
    twosvLink: "Turn on 2-Step Verification",
    step2: "Copy the 16-letter code and paste it here.",
    email: "Your Gmail address",
    code: "The code",
    submit: "Connect",
    trust: "This code is only for Mell. It isn't your password, and you can remove it anytime on the same Google page.",
    refused: "Google refused this code. Check the address and copy the code again.",
    invalid: "I need your Gmail address and the 16-letter code.",
    unavailable: "Google isn't answering. Try again in a minute.",
  },
};
export type AppCopy = (typeof APP_COPY)["fr"];

export const copyFor = (lang: string | undefined): Copy => (lang === "en" ? COPY.en : COPY.fr);

/** La bulle que Mell écrit de lui-même une fois Google connecté : ce qu'il voit, puis une suite. */
export function connectedBubble(lang: string, s: { mailRead: boolean; calendar: boolean }, email?: string): string {
  const who = email ? ` (${email})` : "";
  if (lang === "en") {
    if (s.mailRead && s.calendar) return `Done, I can see your email and calendar${who}. Want me to look through them for the one or two things that might be slipping this week?`;
    if (s.mailRead) return `Done, I can see your email${who}. Want me to check what's waiting on a reply from you?`;
    if (s.calendar) return `Done, I can see your calendar${who}. Want a quick rundown of your week?`;
    return "I can't see your email or calendar: the boxes need to be ticked on Google's page. Want a new link?";
  }
  if (s.mailRead && s.calendar) return `C'est bon, je vois tes mails et ton agenda${who}. Je regarde s'il y a une ou deux choses qui risquent de t'échapper cette semaine ?`;
  if (s.mailRead) return `C'est bon, je vois tes mails${who}. Je regarde ce qui attend une réponse de ta part ?`;
  if (s.calendar) return `C'est bon, je vois ton agenda${who}. Je te fais le point sur ta semaine ?`;
  return "Je ne vois ni tes mails ni ton agenda : il faut cocher les cases chez Google. Je te renvoie un lien ?";
}
