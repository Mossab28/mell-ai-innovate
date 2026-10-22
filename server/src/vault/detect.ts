import * as OTPAuth from "otpauth";

/**
 * Repère un secret tapé dans le fil, avant qu'il n'atteigne la base ou le modèle :
 *   - un mot de passe annoncé (« mon mdp resy c'est X », « password for resy.com: X », « resy : moi@x.fr / X ») ;
 *   - une clé 2FA (lien otpauth:// ou clé base32 annoncée) ;
 *   - un numéro de carte (Luhn) : jamais stocké, seulement retiré.
 * Heuristique volontairement prudente : un faux négatif laisse le message tel quel, un faux
 * positif retirerait du texte normal. « Le mot de passe est faux » ne déclenche rien.
 */

export type Caught =
  | { kind: "login"; site?: string; username?: string; secret: string }
  | { kind: "totp"; site?: string; secret: string }
  | { kind: "card" };

export interface Screened {
  caught?: Caught;
  /** Texte à garder : le secret y est remplacé par SECRET_MARK. */
  text: string;
  /** Il reste une vraie demande à traiter par l'agent, en plus du secret. */
  hasRequest: boolean;
}

export const SECRET_MARK = "[secret retiré du fil]";

const PW_KW = /\b(mot\s+de\s+passe|mdp|password|passwd|pwd|pass)\b/i;
const NOT_A_SITE = new Set(
  (
    "mon ma mes le la les de du des d c l pour for sur on chez my the of to ton ta un une a est is et and " +
    "compte account site appli app nouveau new mot passe mdp password passwd pwd pass identifiant login " +
    "cle clé key secret code 2fa a2f totp authenticator voici voila voilà merci"
  ).split(" "),
);
const DOMAIN =
  /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|fr|net|org|io|co|app|eu|de|uk|es|it|be|ch|ca|us|me|ai|dev|tv|gg|xyz|shop|store)(?:\.[a-z]{2})?)\b/gi;

function looksLikePassword(v: string): boolean {
  if (v.length < 6 || v.length > 200) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
  return classes >= 3 || (v.length >= 8 && classes >= 2 && /[\d\W_]/.test(v));
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** Le site visé : un domaine cité (hors adresse mail), sinon un mot autour du mot-clé, sinon « resy : ... ». */
function findSite(text: string, near?: { index: number; length: number }): string | undefined {
  for (const m of text.matchAll(DOMAIN)) {
    if (text[(m.index ?? 0) - 1] === "@") continue;
    return m[1].toLowerCase().replace(/^www\./, "");
  }
  const words = (s: string) => (s.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []).filter((w) => !NOT_A_SITE.has(w) && !/^\d+$/.test(w));
  if (near) {
    const after = words(text.slice(near.index + near.length, near.index + near.length + 40));
    const before = words(text.slice(Math.max(0, near.index - 30), near.index));
    const cand = after[0] ?? before[before.length - 1];
    if (cand && cand.length >= 2) return cand;
  }
  const lead = /^\s*([A-Za-z0-9][\w.-]{1,30})\s*:/.exec(text)?.[1]?.toLowerCase();
  return lead && !NOT_A_SITE.has(lead) ? lead : undefined;
}

function wordsLeft(text: string): number {
  return (text.toLowerCase().replace(SECRET_MARK, " ").match(/[a-zà-ÿ]{3,}/g) ?? []).filter((w) => !NOT_A_SITE.has(w)).length;
}

const screened = (caught: Caught, text: string): Screened => ({ caught, text, hasRequest: wordsLeft(text) >= 5 });

export function screenSecret(raw: string | undefined): Screened {
  const text = raw ?? "";
  if (!text.trim()) return { text, hasRequest: false };

  // 1. Numéro de carte : retiré, jamais conservé (PCI-DSS).
  const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
  if ([...text.matchAll(CARD)].some((m) => luhn(m[0].replace(/\D/g, "")))) {
    const t = text.replace(CARD, (s) => (luhn(s.replace(/\D/g, "")) ? SECRET_MARK : s));
    return screened({ kind: "card" }, t);
  }

  // 2. Lien otpauth:// : clé 2FA complète, avec le nom du service.
  const otp = /otpauth:\/\/\S+/i.exec(text);
  if (otp) {
    let issuer: string | undefined;
    try {
      const parsed = OTPAuth.URI.parse(otp[0]);
      issuer = (parsed.issuer || "").toLowerCase().replace(/[^a-z0-9.-]/g, "") || undefined;
    } catch {}
    const t = text.replace(otp[0], SECRET_MARK);
    return screened({ kind: "totp", site: findSite(text.replace(otp[0], " ")) ?? issuer, secret: otp[0] }, t);
  }

  // 3. Clé base32 annoncée (« clé 2FA resy : JBSW Y3DP EHPK 3PXP »).
  const b32 = /(2fa|a2f|totp|authenticator|authentificat\w*|cl[ée]|key|secret)(?![a-z])[^\n]{0,40}?(?<![A-Za-z0-9])((?:[A-Za-z2-7]{4}[ -]?){4,}[A-Za-z2-7]*)/i.exec(text);
  if (b32) {
    const key = b32[2].trim();
    const compact = key.replace(/[ -]/g, "");
    if (compact.length >= 16 && (/^[A-Z2-7]+$/.test(compact) || /^[a-z2-7]+$/.test(compact)) && /[2-7]/.test(compact)) {
      const bare = text.replace(key, " ");
      return screened({ kind: "totp", site: findSite(bare, { index: b32.index, length: b32[1].length }), secret: compact }, text.replace(key, SECRET_MARK));
    }
  }

  // 4. Mot de passe annoncé par un mot-clé, ou paire « mail / mot de passe ».
  const kw = PW_KW.exec(text);
  let value: string | undefined;
  let username: string | undefined;
  if (kw) {
    const rest = text.slice(kw.index + kw[0].length);
    // Le séparateur peut suivre un nom de site : « mot de passe resy c'est X », « password for resy.com: X ».
    const m = /^(.{0,60}?)(?:\s*(?:[:=]|->|=>)\s*|\s+(?:c['’]est|est|is)\s+)("[^"\n]+"|«[^»\n]+»|\S+)/i.exec(rest);
    if (m) {
      const quoted = /^["«]/.test(m[2]);
      const v = quoted ? m[2].replace(/^["«]\s*|\s*["»]$/g, "") : m[2].replace(/[.,;!?]$/, "");
      if (quoted ? v.length > 0 : looksLikePassword(v)) value = m[2];
    }
  }
  const pair = /([^\s@:]+@[^\s@]+\.[a-z]{2,})\s*[/|]\s*(\S+)/i.exec(text);
  if (!value && pair && looksLikePassword(pair[2])) {
    value = pair[2];
    username = pair[1];
  }
  if (!value) return { text, hasRequest: true };
  username ??= /([^\s@:/]+@[^\s@:/]+\.[a-z]{2,})/i.exec(text)?.[1];

  const secret = /^["«]/.test(value) ? value.replace(/^["«]\s*|\s*["»]$/g, "") : value.replace(/[.,;!?]$/, "");
  const bare = text.replace(value, " ");
  const site = findSite(bare, kw ? { index: kw.index, length: kw[0].length } : undefined);
  return screened({ kind: "login", site, username, secret }, text.replace(value, SECRET_MARK));
}
