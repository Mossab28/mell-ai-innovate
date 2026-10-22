import { VaultError, type VaultKind, type VaultRef } from "./types.ts";
import { parse } from "tldts";

/**
 * Site normalisé : nom d'hôte en minuscules, sans « www. » ni chemin. « https://www.Resy.com/login » -> « resy.com ».
 * Un domaine concret est obligatoire. Les suffixes publics et privés ne désignent pas un compte.
 */
export function normalizeSite(input: string): string {
  const source = input.trim();
  if (!source) throw new VaultError("site manquant");
  // Slot interne pour un secret reçu sans destination. Il n'autorise jamais une injection.
  if (source === "_pending") return source;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(source) ? source : `https://${source}`);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error();
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    const parsed = parse(host, { allowPrivateDomains: true });
    if (!parsed.domain || parsed.isIp || !(parsed.isIcann || parsed.isPrivate) || host.length > 253 ||
      !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error();
    return host;
  } catch {
    throw new VaultError("indique le domaine complet du site, par exemple booking.com");
  }
}

export function normalizeField(input: string): string {
  const f = input.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(f)) throw new VaultError(`champ invalide : ${input}`);
  return f;
}

export function makeRef(kind: VaultKind, name: string): VaultRef {
  return `vault://${kind}/${kind === "personal" ? normalizeField(name) : kind === "card" ? normalizeCardName(name) : normalizeSite(name)}`;
}

/** Nom d'une carte : sa marque et ses quatre derniers chiffres (« visa-4242 »). Rien de plus n'est montré. */
export function normalizeCardName(input: string): string {
  const n = input.trim().toLowerCase();
  if (!/^[a-z]{2,12}-\d{4}$/.test(n)) throw new VaultError(`carte invalide : ${input}`);
  return n;
}

/** « visa-4242 » à partir du numéro complet. */
export function cardName(number: string): string {
  const d = number.replace(/\D/g, "");
  const brand = /^4/.test(d)
    ? "visa"
    : /^(5[1-5]|2[2-7])/.test(d)
      ? "mastercard"
      : /^3[47]/.test(d)
        ? "amex"
        : /^(6011|65|64[4-9])/.test(d)
          ? "discover"
          : "carte";
  return `${brand}-${d.slice(-4)}`;
}

export function parseRef(ref: string): { kind: VaultKind; name: string } {
  const m = /^vault:\/\/(login|totp|personal|card)\/([a-z0-9_.-]+)$/.exec(ref.trim());
  if (!m) throw new VaultError(`référence de coffre invalide : ${ref}`);
  return { kind: m[1] as VaultKind, name: m[2] };
}

/**
 * Le site enregistré correspond-il à la page où l'on veut injecter ? Garde-fou anti-hameçonnage :
 * un identifiant de resy.com ne se tape jamais sur resy-login.xyz, quoi qu'en dise la page.
 *   resy.com    : resy.com et ses sous-domaines (auth.resy.com)
 * Les anciens noms sans extension, suffixes publics et slots internes sont refusés.
 */
export function siteMatchesHost(site: string, pageUrl: string): boolean {
  try {
    if (site === "_pending" || normalizeSite(site) !== site) return false;
    const u = new URL(pageUrl);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    return host === site || host.endsWith(`.${site}`);
  } catch {
    return false;
  }
}
