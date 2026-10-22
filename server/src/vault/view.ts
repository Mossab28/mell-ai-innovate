import type { VaultLink } from "./links.ts";
import { PERSONAL_FIELDS } from "./types.ts";
import { INK, lockSvg, logoSvg, page as daPage } from "../web/da.ts";

export type VaultLanguage = "fr" | "en";
export const VAULT_PREVIEW_PATH = "/assets/mell-vault-lock.png";

export const COPY = {
  fr: {
    title: "Mell", preview: "Sécurisé par Mell.",
    login: "Ton compte", totp: "Double authentification", personal: "Tes informations", card: "Ta carte",
    site: "Site", domainNote: (site: string) => `Utilisé uniquement sur ${site}.`,
    genericDomainNote: "Le domaine exact, par exemple booking.com.",
    username: "Identifiant ou e-mail", password: "Mot de passe", save: "Enregistrer",
    optionalTotp: "Authentification à deux facteurs", optional: "Facultatif",
    seed: "Clé de configuration", seedHint: "La clé sous le QR code, pas le code à 6 chiffres.",
    apple: "Remplir avec Mots de passe", appleHelp: "Touche Identifiant, puis Mots de passe au-dessus du clavier. Choisis Autres mots de passe et cherche le site.",
    note: "Chiffré dans ton coffre, jamais montré à l'IA.",
    safe: "Tes données vont être sécurisées : chiffrées dans ton coffre, utilisables par Mell, jamais lisibles par lui.",
    cardNumber: "Numéro de carte", cardExp: "Expiration", cardCvc: "Cryptogramme", cardHolder: "Nom sur la carte",
    cardNote: "Aucun paiement maintenant. Mell ne s'en sert que pour un achat que tu as validé.",
    fields: { full_name: "Nom complet", email: "E-mail", phone: "Téléphone", address: "Adresse postale", birthdate: "Date de naissance" },
    goneTitle: "Lien expiré", gone: "Demande un nouveau lien à Mell dans la conversation.",
    invalid: "Vérifie les champs du formulaire.",
    siteInvalid: "Indique un domaine valide, par exemple booking.com.", siteChanged: "Ce lien est réservé au site affiché. Demande un autre lien à Mell pour un autre compte.",
    needPassword: "Ajoute le mot de passe du compte.", needSeed: "Ajoute la clé de configuration, pas un code à 6 chiffres.",
    tooLong: "Un champ est trop long. Vérifie ta saisie.",
    empty: "Remplis au moins un champ.", forbiddenTitle: "Envoi refusé", forbidden: "Rouvre le lien envoyé par Mell.",
    doneTitle: "C'est dans ton coffre", done: "Tu peux revenir à la conversation.",
    downTitle: "Pas de confirmation", down: "Le coffre n'a pas confirmé l'enregistrement. Réessaie avec ce lien.",
    retry: "Réessayer", partialTitle: "Identifiants enregistrés", partial: "La clé de double authentification n'est pas confirmée. Ajoute-la avec ce nouveau lien.",
    retryTotp: "Ajouter la clé", partialNoLink: "La clé de double authentification n'est pas confirmée. Demande un nouveau lien à Mell pour l'ajouter.",
    partialOtherTitle: "Enregistrement incomplet", partialOther: "Une partie n'est pas confirmée. Reprends le formulaire, ce qui est déjà enregistré sera mis à jour.",
    notificationFailed: "C'est enregistré. Dis-le à Mell dans la conversation.",
    confirm: (what: string) => `C'est dans ton coffre 🔒 ${what}`,
    resumed: (what: string) => `Bien reçu 🔒 ${what}, je reprends.`,
    personalWhat: "tes informations", cardWhat: "ta carte"
  },
  en: {
    title: "Mell", preview: "Secured by Mell.",
    login: "Your account", totp: "Two-factor authentication", personal: "Your information", card: "Your card",
    site: "Website", domainNote: (site: string) => `Used only on ${site}.`,
    genericDomainNote: "The exact domain, for example booking.com.",
    username: "Username or email", password: "Password", save: "Save",
    optionalTotp: "Two-factor authentication", optional: "Optional",
    seed: "Setup key", seedHint: "The key below the QR code, not the six-digit code.",
    apple: "Fill with Passwords", appleHelp: "Tap Username, then Passwords above the keyboard. Choose Other Passwords and find the website.",
    note: "Encrypted in your vault, never shown to the AI.",
    safe: "Your data will be secured: encrypted in your vault, usable by Mell, never readable by it.",
    cardNumber: "Card number", cardExp: "Expiry", cardCvc: "Security code", cardHolder: "Name on card",
    cardNote: "No payment now. Mell only uses it for a purchase you approved.",
    fields: { full_name: "Full name", email: "Email", phone: "Phone", address: "Postal address", birthdate: "Date of birth" },
    goneTitle: "Link expired", gone: "Ask Mell for a new link in the conversation.",
    invalid: "Check the form fields.",
    siteInvalid: "Enter a valid domain, for example booking.com.", siteChanged: "This link is only for the website shown. Ask Mell for a different link to add another account.",
    needPassword: "Add the account password.", needSeed: "Add the setup key, not a six-digit code.",
    tooLong: "A field is too long. Check your input.",
    empty: "Fill in at least one field.", forbiddenTitle: "Submission refused", forbidden: "Open the link Mell sent you again.",
    doneTitle: "Saved to your vault", done: "You can return to the conversation.",
    downTitle: "Not confirmed", down: "The vault did not confirm the save. Try again with this link.",
    retry: "Try again", partialTitle: "Credentials saved", partial: "The two-factor key is not confirmed. Add it with this new link.",
    retryTotp: "Add the key", partialNoLink: "The two-factor key is not confirmed. Ask Mell for a new link to add it.",
    partialOtherTitle: "Partly saved", partialOther: "Part of it is not confirmed. Fill the form again; what is already saved will be updated.",
    notificationFailed: "It's saved. Tell Mell in the conversation.",
    confirm: (what: string) => `Saved to your vault 🔒 ${what}`,
    resumed: (what: string) => `Got it 🔒 ${what}, picking it back up.`,
    personalWhat: "your information", cardWhat: "your card"
  },
};

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Les pages du coffre sur la DA : crème, encre, le logo minuscule en haut à gauche, le cadenas, la promesse en tête. */
function page(lang: VaultLanguage, publicUrl: string, body: string): string {
  const t = COPY[lang];
  const imageUrl = `${new URL(publicUrl).origin}${VAULT_PREVIEW_PATH}`;
  return daPage({ lang, title: t.title, preview: t.preview, image: imageUrl, lock: true, body: `<a class="corner l" href="/" aria-label="Mell">${logoSvg(INK, 30).replace("<svg ", '<svg class="m" ')}</a><div class="doc form">${body}</div>` });
}
const lock = lockSvg(30, INK);

export function vaultForm(lang: VaultLanguage, publicUrl: string, link: VaultLink, error?: string, showTotp = false, prefill: { username?: string } = {}): string {
  const t = COPY[lang];
  const input = (name: string, label: string, type = "text", extra = "", value = "") => `<label for="${name}">${escapeHtml(label)}</label><input id="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" ${extra}>`;
  let fields = "";
  if (link.kind === "card") {
    fields = input("number", t.cardNumber, "text", 'inputmode="numeric" autocomplete="cc-number" required') + `<div class="two-fields"><div>${input("exp", t.cardExp, "text", 'inputmode="numeric" autocomplete="cc-exp" placeholder="MM/YY" required')}</div><div>${input("cvc", t.cardCvc, "password", 'inputmode="numeric" autocomplete="cc-csc" required')}</div></div>` + input("holder", t.cardHolder, "text", 'autocomplete="cc-name"');
  } else if (link.kind === "personal") {
    const autocomplete = { full_name: "name", email: "email", phone: "tel", address: "street-address", birthdate: "bday" };
    for (const f of PERSONAL_FIELDS) fields += input(f, t.fields[f], f === "email" ? "email" : f === "phone" ? "tel" : "text", `autocomplete="${autocomplete[f]}"`);
  } else {
    // Site fixé par le lien : il est dans le titre, le serveur le reprend du lien.
    fields = link.site
      ? `<p class="hint">${escapeHtml(t.domainNote(link.site))}</p>`
      : `<div class="domain">${input("site", t.site, "text", 'required autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" aria-describedby="domain-note" placeholder="booking.com"')}<p id="domain-note" class="hint">${escapeHtml(t.genericDomainNote)}</p></div>`;
    if (link.kind === "login") {
      // Son adresse connue est déjà là : un champ de moins, et Mots de passe propose plus volontiers l'entrée du site.
      fields += input("username", t.username, "text", 'autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="username" inputmode="email"', prefill.username ?? "");
      fields += input("password", t.password, "password", 'required autocomplete="current-password"');
      fields += `<details class="apple" open><summary>${t.apple}</summary><p>${t.appleHelp}</p></details>`;
    }
    const seed = input("seed", t.seed, "password", `autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" aria-describedby="seed-hint" ${link.kind === "totp" ? "required" : ""}`) + `<p id="seed-hint" class="hint">${escapeHtml(t.seedHint)}</p>`;
    if (link.kind !== "login") fields += seed;
  }
  const title = link.site && (link.kind === "login" || link.kind === "totp") ? `${t[link.kind]} ${link.site}` : t[link.kind];
  const note = link.kind === "card" ? t.cardNote : t.note;
  return page(lang, publicUrl, `<section class="surface"><div class="lock">${lock}</div><h1>${escapeHtml(title)}</h1>${error ? `<p role="alert" class="error">${escapeHtml(error)}</p>` : ""}<form method="post">${fields}<button class="submit" type="submit">${t.save}</button></form><p class="assurance">${escapeHtml(note)}</p></section>`);
}

export function vaultStatus(lang: VaultLanguage, publicUrl: string, title: string, message: string, action?: { href: string; label: string }, footnote?: string): string {
  return page(lang, publicUrl, `<section class="surface status"><div class="lock">${lock}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${action ? `<a class="action" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>` : ""}${footnote ? `<p class="footnote">${escapeHtml(footnote)}</p>` : ""}</section>`);
}
