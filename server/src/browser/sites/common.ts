import { blockOf } from "../loop.ts";
import { BrowserError, type PageDriver } from "../types.ts";

/**
 * Outils communs aux parcours enregistrés : un parcours fait ce qu'une personne ferait (page
 * d'accueil, champs de recherche, bouton), mais lit la réponse JSON que le site se renvoie à
 * lui-même au lieu de deviner l'écran. Aucun modèle à chaque étape, aucune action qui engage.
 */

/** La page Playwright (types laissés ouverts : Patchright et Camoufox n'ont pas la même version). */
export type Pw = any;

export async function pwOf(page: PageDriver): Promise<Pw> {
  if (!page.playwright) throw new BrowserError(`le moteur ${page.engine} ne rejoue pas de parcours`, "politique");
  return page.playwright();
}

const REFUSE = ["#didomi-notice-disagree-button", "#_evidon-decline-button", "#onetrust-reject-all-handler", "#axeptio_btn_dismiss"];

/**
 * Bandeau de cookies : on refuse, comme une personne pressée. Il arrive souvent quelques secondes
 * après la page (SNCF Connect) : on le guette jusqu'à 6 s, et on arrête de guetter 2 s après la fin
 * du chargement s'il n'est pas venu (visite suivante, choix déjà gardé dans le profil).
 */
export async function refuseCookies(p: Pw, maxMs = 6000): Promise<boolean> {
  const t0 = Date.now();
  let loadedAt: number | undefined;
  while (Date.now() - t0 < maxMs) {
    for (const sel of REFUSE) {
      const l = p.locator(sel).first();
      if (await l.isVisible().catch(() => false)) {
        await l.click({ timeout: 3000 }).catch(() => {});
        await p.waitForTimeout(400);
        return true;
      }
    }
    const t = p.getByText(/^Continuer sans accepter/).first();
    if (await t.isVisible().catch(() => false)) {
      await t.click({ timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(400);
      return true;
    }
    if (loadedAt === undefined && (await p.evaluate("document.readyState").catch(() => "")) === "complete") loadedAt = Date.now();
    if (loadedAt !== undefined && Date.now() - loadedAt > 2000) return false;
    await p.waitForTimeout(250);
  }
  return false;
}

/** Lance `action` et rend le JSON de la première réponse qui correspond. */
export async function jsonAfter<T = any>(p: Pw, match: (res: Pw) => boolean, action: () => Promise<unknown>, timeoutMs = 25_000): Promise<T> {
  const wait = p.waitForResponse((r: Pw) => r.status() < 400 && match(r), { timeout: timeoutMs });
  wait.catch(() => {});
  await action();
  try {
    return (await (await wait).json()) as T;
  } catch (e) {
    throw new BrowserError(`le site n'a pas répondu à temps (${String(e instanceof Error ? e.message : e).split("\n")[0].slice(0, 120)})`, "delai");
  }
}

/**
 * Exécute une fonction dans la page. Passée en texte : l'outil de compilation renomme les fonctions
 * imbriquées (helper __name) et la page ne connaît pas ce helper.
 */
export async function inPage<T>(p: Pw, fn: string, arg: unknown): Promise<T> {
  return p.evaluate(`(${fn})(${JSON.stringify(arg)})`);
}

/** Une étape nommée : en cas d'échec, l'erreur dit laquelle. */
export async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BrowserError) throw new BrowserError(`${name} : ${e.message}`, e.category);
    const m = String(e instanceof Error ? e.message : e).split("\n")[0].slice(0, 160);
    throw new BrowserError(`${name} : ${m}`, /Timeout/i.test(m) ? "element_introuvable" : "autre");
  }
}

/** Tape comme une personne, après avoir vidé le champ. */
export async function typeSlowly(field: Pw, text: string): Promise<void> {
  await field.click({ timeout: 10_000 });
  await field.fill("");
  await field.pressSequentially(text, { delay: 55 });
}

/** Après un échec : la page est-elle un mur anti-robot ? Rend le fournisseur, ou rien. */
export async function whyBlocked(page: PageDriver): Promise<string | undefined> {
  try {
    const b = blockOf(await page.snapshot({ textLimit: 1500 }));
    return b ? `${b.vendor} (${b.kind})` : undefined;
  } catch {
    return undefined;
  }
}

/** Sans accents, sans majuscules, espaces simples : pour comparer des libellés. */
export function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Texte venu d'un site : borné, sans balises ni caractères de contrôle. */
export function clean(s: unknown, max = 160): string {
  return String(s ?? "")
    .replace(/[\u0000-\u001f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** « jeu. 15 oct., 14:15 » dans le fuseau de la personne. */
export function slotLabel(iso: string, tz = "Europe/Paris"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("fr-FR", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
}

/** « 20:30 » ou « 20h30 » en minutes depuis minuit ; undefined si illisible. */
export function minutesOf(hhmm: string | undefined): number | undefined {
  const m = /(\d{1,2})\s*[h:]\s*(\d{2})?/.exec(hhmm ?? "");
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  return h < 24 && min < 60 ? h * 60 + min : undefined;
}

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T12:00:00Z`).getTime());
}
