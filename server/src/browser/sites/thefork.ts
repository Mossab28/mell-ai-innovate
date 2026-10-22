import { BrowserError, type PageDriver } from "../types.ts";
import { clean, inPage, isIsoDate, minutesOf, norm, pwOf, refuseCookies, step, type Pw } from "./common.ts";

/**
 * TheFork : créneaux pour N personnes à une date, dans un restaurant ou un quartier, en lecture seule.
 *
 * On ouvre le site comme une personne (accueil, puis la page du quartier quand il y en a un), et on
 * pose au site les questions que sa propre page pose (GraphQL /api/graphql, avec les en-têtes de sa
 * page) : suggestions de restaurants et de lieux, puis créneaux par restaurant pour la date et le
 * nombre de personnes. Aucun clic sur un créneau, rien n'est réservé.
 */

export interface TheForkQuery {
  /** AAAA-MM-JJ */
  date: string;
  /** HH:MM, l'heure souhaitée ; sans heure, tous les créneaux du jour. */
  time?: string;
  partySize: number;
  /** Nom du restaurant. */
  restaurant?: string;
  /** Quartier, ville ou adresse (« Paris 11 », « Bastille », « Lyon »). */
  area?: string;
  /** Type de cuisine (« italien », « japonais »), avec un quartier. */
  cuisine?: string;
}

export interface TheForkOption {
  restaurant: string;
  address: string;
  /** Créneaux au plus près de l'heure demandée, « 20:30 » ; offre éventuelle (« -20 % »). */
  slots: Array<{ time: string; offer?: string }>;
  url: string;
}

export interface TheForkResult {
  site: "thefork";
  date: string;
  partySize: number;
  where?: string;
  checked: number;
  options: TheForkOption[];
  /** Restaurants trouvés mais complets pour ce créneau. */
  full: string[];
  /** Le restaurant demandé n'est pas sur TheFork : ce qu'il faut faire à la place. */
  notListed?: string;
}

const BASE = "https://www.thefork.fr";

const SLOTS = `query BookingWidgetHourStepData($restaurantId: IntOrUUID!, $date: Date!, $partySize: PositiveInt) {
  restaurant(restaurantId: $restaurantId) { id name address { street zipCode locality } }
  availabilityTimeSlots(restaurantId: $restaurantId, date: $date, partySize: $partySize) { dateTime bestOffer { label } }
}`;

/** Les en-têtes que la page de TheFork met elle-même sur ses requêtes. */
const HEADERS = {
  "content-type": "application/json",
  accept: "application/graphql-response+json,application/json;q=0.9",
  "apollographql-client-name": "core-front-browser",
  timezone: "Europe/Paris",
  "x-thefork-product-id": "37",
  "x-thefork-product-name": "core-front-browser",
};

type Op = { operationName: string; variables: Record<string, unknown>; query: string };

/** Dans la page : les liens de restaurants d'une liste, dans l'ordre où le site les présente. */
const LINKS_FN = `() => {
  const seen = new Set();
  const out = [];
  for (const a of Array.from(document.querySelectorAll("a[href*='/restaurant/']"))) {
    const m = /-r(\\d+)/.exec(a.getAttribute("href") || "");
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: m[1], url: new URL(a.getAttribute("href"), location.origin).href.split("#")[0] });
  }
  return out;
}`;

/** Dans la page : une requête GraphQL avec les en-têtes de la page (fetch de la page, cookies compris). */
const GQL_FN = `async ({ ops, headers }) => {
  const r = await fetch("/api/graphql", { method: "POST", credentials: "include", headers, body: JSON.stringify(ops) });
  return { status: r.status, body: r.ok ? await r.json() : null };
}`;

async function gql(p: Pw, ops: Op[]): Promise<any[]> {
  const res = await inPage<{ status: number; body: unknown }>(p, GQL_FN, { ops, headers: HEADERS });
  if (res.status === 403 || res.status === 429) throw new BrowserError(`TheFork refuse les requêtes (HTTP ${res.status})`, "detection_robot");
  if (!Array.isArray(res.body)) throw new BrowserError(`réponse inattendue de TheFork (HTTP ${res.status})`, "page_changee");
  return res.body;
}

/** Tape dans un champ du site et attend que la page ait reçu ses suggestions pour ce texte exact. */
async function typeAndWait(p: Pw, selector: string, text: string, operation: string): Promise<void> {
  const field = p.locator(selector).first();
  const got = p.waitForResponse((r: Pw) => /\/api\/graphql/.test(r.url()) && r.status() === 200 && suggestedFor(r.request().postData(), operation) === norm(text), { timeout: 15_000 });
  got.catch(() => {});
  await field.click({ timeout: 10_000 });
  await p.waitForTimeout(250);
  await field.press("ControlOrMeta+a");
  await field.press("Backspace");
  await field.pressSequentially(text, { delay: 95 });
  await got;
  await p.waitForTimeout(450);
}

/** Le texte pour lequel la page a demandé des suggestions (opération GraphQL donnée), normalisé. */
function suggestedFor(body: string | null, operation: string): string | undefined {
  try {
    const op = [].concat(JSON.parse(body ?? "[]")).find((o: any) => o?.operationName === operation) as any;
    const v = op?.variables;
    return op ? norm(String(v?.text ?? v?.query?.text ?? "")) : undefined;
  } catch {
    return undefined;
  }
}

/** Attend que la page ait fini ses propres requêtes, puis un geste de souris, comme quelqu'un qui lit. */
async function settle(p: Pw): Promise<void> {
  await p.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
  await p.mouse.move(380 + Math.round(Math.random() * 240), 260 + Math.round(Math.random() * 180), { steps: 8 }).catch(() => {});
  await p.waitForTimeout(1200);
}

/**
 * Ouvre une page comme un visiteur et attend que le site soit prêt : sa propre première requête
 * GraphQL est passée et son anti-robot (DataDome) a posé son cookie. Poser nos questions avant,
 * c'est se faire refuser (constaté le 15/10 : 403 puis captcha).
 */
async function visit(page: PageDriver, p: Pw, url: string): Promise<void> {
  const own = p.waitForResponse((r: Pw) => /\/api\/graphql/.test(r.url()) && r.status() === 200, { timeout: 20_000 });
  own.catch(() => {});
  await page.goto(url, 30_000);
  await refuseCookies(p);
  await own.catch(() => {});
  for (let i = 0; i < 24; i++) {
    const cookies: Array<{ name: string }> = await p.context().cookies("https://www.thefork.fr").catch(() => []);
    if (cookies.some((c) => c.name === "datadome")) break;
    await p.waitForTimeout(250);
  }
  await p.mouse.move(380 + Math.round(Math.random() * 240), 260 + Math.round(Math.random() * 180), { steps: 8 }).catch(() => {});
  await p.waitForTimeout(700);
}

export async function theforkSearch(page: PageDriver, q: TheForkQuery, o: { max?: number; limit?: number } = {}): Promise<TheForkResult> {
  if (!isIsoDate(q.date)) throw new BrowserError("date attendue au format AAAA-MM-JJ", "politique");
  const party = Math.round(Number(q.partySize));
  if (!(party >= 1 && party <= 20)) throw new BrowserError("nombre de personnes entre 1 et 20", "politique");
  if (!q.restaurant?.trim() && !q.area?.trim()) throw new BrowserError("il faut un restaurant ou un quartier", "politique");

  const p = await pwOf(page);
  await step("page d'accueil", () => visit(page, p, `${BASE}/`));

  // Comme une personne : le lieu, puis la cuisine ou le nom, tapés dans les champs du site ; c'est la
  // page elle-même qui demande ses suggestions et qui ouvre la liste. Poser ces questions nous-mêmes
  // a déclenché l'anti-robot (15/10 : 403, captcha, puis adresse IP refusée un moment).
  if (q.area?.trim()) await step("champ lieu", () => typeAndWait(p, "#search-form-where", q.area!.trim(), "WhereAutocompleteSuggestions"));
  const what = q.restaurant?.trim() || q.cuisine?.trim();
  if (what) await step("champ cuisine ou restaurant", () => typeAndWait(p, "#search-form-what", what, "WhatAutocompleteSuggestions"));
  await step("bouton Rechercher", async () => {
    const before = p.url();
    await p.getByRole("button", { name: /^recherche$/i }).first().click({ timeout: 8000 });
    await p.waitForURL((u: URL) => u.href !== before && /\/restaurants?\//.test(u.pathname), { timeout: 25_000 });
  });
  await step("liste du site", () => settle(p));

  const here = p.url();
  const own = /\/restaurant\/[^/]*-r(\d+)/.exec(here);
  // Le site a ouvert directement la fiche du restaurant cherché, ou une liste : on lit l'une ou l'autre.
  let candidates: Array<{ id: string; url: string }> = own ? [{ id: own[1], url: here.split("#")[0] }] : await inPage(p, LINKS_FN, null);
  if (q.restaurant?.trim() && !own) candidates = candidates.slice(0, 3);
  const where = q.area?.trim() || undefined;
  candidates = candidates.slice(0, o.limit ?? 12);
  if (!candidates.length) throw new BrowserError("aucun restaurant lisible sur la page du quartier", "page_changee");

  // Créneaux de chaque restaurant, quatre par requête, comme le widget de réservation de la page.
  const rows: Array<{ id: string; url: string; data: any }> = [];
  for (let i = 0; i < candidates.length; i += 4) {
    const batch = candidates.slice(i, i + 4);
    const res = await gql(
      p,
      batch.map((c) => ({ operationName: "BookingWidgetHourStepData", variables: { restaurantId: c.id, date: q.date, partySize: party }, query: SLOTS })),
    );
    batch.forEach((c, k) => rows.push({ ...c, data: res[k]?.data }));
  }

  const want = minutesOf(q.time);
  const full: string[] = [];
  const options = rows
    .map((r) => {
      const name = clean(r.data?.restaurant?.name, 80);
      const a = r.data?.restaurant?.address;
      const slots = (r.data?.availabilityTimeSlots ?? [])
        .map((s: any) => ({ time: String(s.dateTime ?? "").slice(11, 16), offer: clean(s.bestOffer?.label, 20) || undefined }))
        .filter((s: { time: string }) => /^\d{2}:\d{2}$/.test(s.time));
      if (name && !slots.length) full.push(name);
      const dist = (t: string) => (want === undefined ? 0 : Math.abs((minutesOf(t) ?? 0) - want));
      // Au plus près de l'heure voulue : une heure avant, une heure et demie après.
      const near = want === undefined ? slots : slots.filter((s: { time: string }) => (minutesOf(s.time) ?? 0) >= want - 60 && (minutesOf(s.time) ?? 0) <= want + 90);
      const chosen = (near.length ? near : slots).sort((x: { time: string }, y: { time: string }) => dist(x.time) - dist(y.time)).slice(0, 4).sort((x: { time: string }, y: { time: string }) => x.time.localeCompare(y.time));
      return {
        restaurant: name,
        address: clean([a?.street, [a?.zipCode, a?.locality].filter(Boolean).join(" ")].filter(Boolean).join(", ")),
        slots: chosen,
        url: r.url,
        score: chosen.length ? Math.min(...chosen.map((s: { time: string }) => dist(s.time))) + (near.length ? 0 : 1000) : Infinity,
      };
    })
    .filter((x) => x.restaurant && x.slots.length)
    .sort((a, b) => a.score - b.score)
    .slice(0, o.max ?? 6)
    .map(({ score: _s, ...rest }) => rest);

  // Un restaurant précis absent de TheFork (Big Mamma, beaucoup de tables prisées) : ses voisins ne sont pas lui.
  if (q.restaurant?.trim()) {
    const words = norm(q.restaurant).split(" ").filter((w) => w.length >= 3 && !["restaurant", "chez", "les", "the"].includes(w));
    const same = (n: string) => words.length > 0 && words.every((w) => norm(n).includes(w));
    if (!rows.some((r) => same(String(r.data?.restaurant?.name ?? "")))) {
      return { site: "thefork", date: q.date, partySize: party, where, checked: rows.length, options: [], full: [], notListed: `${clean(q.restaurant, 60)} n'est pas réservable sur TheFork : cherche sa propre page de réservation (son site, Zenchef, SevenRooms) ou sa fiche Google Maps` };
    }
  }
  return { site: "thefork", date: q.date, partySize: party, where, checked: rows.length, options, full: full.slice(0, 8) };
}
