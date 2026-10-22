import { BrowserError, type PageDriver } from "../types.ts";
import { pwOf, refuseCookies } from "./common.ts";

/**
 * Booking.com : logements à une adresse, pour des dates et un nombre de personnes, en lecture seule.
 *
 * On ouvre directement la page de résultats (ses paramètres sont publics : ss, checkin, checkout,
 * group_adults, no_rooms, et l'ordre « prix »), puis on lit les fiches telles que la page les montre :
 * nom, prix total affiché, note, quartier ou distance, photo, lien. Aucun clic sur une offre.
 * Le choix des options à montrer et ce qu'on en dit restent au modèle.
 */

export interface BookingQuery {
  /** Où : une adresse, un quartier, une ville (« rue d'Aboukir, Paris »). */
  place: string;
  /** AAAA-MM-JJ */
  checkin: string;
  /** AAAA-MM-JJ, le lendemain par défaut. */
  checkout?: string;
  adults?: number;
  rooms?: number;
  /** « price » (du moins cher) ou « popularity ». */
  order?: "price" | "popularity";
}

export interface BookingStay {
  title: string;
  price?: string;
  priceCents?: number;
  rating?: string;
  where?: string;
  distance?: string;
  details?: string;
  url?: string;
  image?: string;
}

export interface BookingResult {
  site: "booking";
  place: string;
  checkin: string;
  checkout: string;
  adults: number;
  stays: BookingStay[];
}

const nextDay = (d: string) => new Date(new Date(`${d}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

/** « 123 € », « € 1 234 », « 98,50 € » : le montant en centimes. */
export function priceToCents(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.replace(/ | /g, " ").match(/(\d[\d\s.,]*)/);
  if (!m) return undefined;
  let n = m[1].replace(/\s/g, "");
  if (/,\d{2}$/.test(n)) n = n.replace(/\./g, "").replace(",", ".");
  else n = n.replace(/[.,]/g, "");
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : undefined;
}

export function searchUrl(q: BookingQuery): string {
  const checkout = q.checkout && q.checkout > q.checkin ? q.checkout : nextDay(q.checkin);
  const p = new URLSearchParams({
    ss: q.place,
    checkin: q.checkin,
    checkout,
    group_adults: String(Math.max(1, Math.min(16, q.adults ?? 1))),
    no_rooms: String(Math.max(1, Math.min(8, q.rooms ?? 1))),
    group_children: "0",
    lang: "fr",
    selected_currency: "EUR",
  });
  if ((q.order ?? "price") === "price") p.set("order", "price");
  return `https://www.booking.com/searchresults.fr.html?${p}`;
}

/** Ferme les fenêtres par-dessus la page (invitation à se connecter, Genius) : elles bloquent les clics. */
async function dismissOverlays(p: any): Promise<void> {
  await p.keyboard.press("Escape").catch(() => {});
  for (const sel of ['button[aria-label*="Ignorer"]', 'button[aria-label*="Dismiss"]', 'button[aria-label*="Fermer"]', 'button[aria-label*="Close"]']) {
    const b = p.locator(sel).first();
    if (await b.isVisible().catch(() => false)) await b.click({ timeout: 2000 }).catch(() => {});
  }
}

/** Les dates et le nombre de personnes, posés sur l'adresse d'une page de résultats déjà trouvée. */
function withParams(current: string, q: BookingQuery, checkout: string): string {
  const u = new URL(current);
  u.searchParams.set("checkin", q.checkin);
  u.searchParams.set("checkout", checkout);
  u.searchParams.set("group_adults", String(Math.max(1, Math.min(16, q.adults ?? 1))));
  u.searchParams.set("no_rooms", String(Math.max(1, Math.min(8, q.rooms ?? 1))));
  u.searchParams.set("group_children", "0");
  u.searchParams.set("selected_currency", "EUR");
  if ((q.order ?? "price") === "price") u.searchParams.set("order", "price");
  return u.href;
}

const READ_CARDS = `(() => Array.from(document.querySelectorAll('[data-testid="property-card"]')).slice(0, 12).map((c) => {
  const t = (sel) => ((c.querySelector(sel) || {}).textContent || "").replace(/\\s+/g, " ").trim() || undefined;
  const link = c.querySelector('a[data-testid="title-link"]') || c.querySelector("a[href*='/hotel/']");
  const img = c.querySelector('img[data-testid="image"]') || c.querySelector("img");
  let href;
  try { const u = new URL((link && link.getAttribute("href")) || "", location.href); u.hash = ""; href = u.href; } catch (e) {}
  const d = t('[data-testid="recommended-units"]');
  return {
    title: t('[data-testid="title"]') || "",
    price: t('[data-testid="price-and-discounted-price"]') || t('[data-testid="price"]'),
    rating: t('[data-testid="review-score"]'),
    where: t('[data-testid="address"]'),
    distance: t('[data-testid="distance"]'),
    details: d ? d.slice(0, 160) : undefined,
    url: href,
    image: (img && (img.currentSrc || img.getAttribute("src"))) || undefined,
  };
}))()`;

export async function bookingSearch(page: PageDriver, q: BookingQuery): Promise<BookingResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.checkin)) throw new BrowserError("date d'arrivée attendue au format AAAA-MM-JJ", "politique");
  const p = await pwOf(page);
  const url = searchUrl(q);
  const checkout = new URL(url).searchParams.get("checkout")!;
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 40_000 });
  await refuseCookies(p).catch(() => false);
  // Une ville passe telle quelle ; une adresse précise renvoie vers l'accueil : on cherche alors comme une
  // personne, en tapant l'adresse et en prenant la suggestion de Booking, puis on pose dates et personnes.
  if (!/searchresults/.test(p.url())) {
    await dismissOverlays(p);
    const box = p.locator('input[name="ss"]').first();
    await box.click({ timeout: 8000 });
    await box.fill("");
    await p.keyboard.type(q.place, { delay: 55 });
    const suggestion = p.locator('[data-testid="autocomplete-result"], [role="option"]').first();
    await suggestion.waitFor({ timeout: 8000 }).catch(() => {
      throw new BrowserError("Booking ne propose rien pour cette adresse", "element_introuvable");
    });
    await suggestion.click({ timeout: 5000 });
    await p.waitForTimeout(600);
    await dismissOverlays(p);
    await p.locator('button[type="submit"]').first().click({ timeout: 8000 });
    await p.waitForURL(/searchresults/, { timeout: 25_000 });
    await p.goto(withParams(p.url(), q, checkout), { waitUntil: "domcontentloaded", timeout: 40_000 });
  }
  await dismissOverlays(p);
  // Les fiches arrivent après le premier rendu : on attend qu'au moins une soit là.
  await p.waitForSelector('[data-testid="property-card"]', { timeout: 25_000 }).catch(() => {
    throw new BrowserError("aucune fiche de logement sur la page de résultats", "element_introuvable");
  });
  await p.waitForTimeout(1500);
  // Lu par une fonction passée en texte : le compilateur n'y glisse rien qui manquerait dans la page.
  const stays: BookingStay[] = await p.evaluate(READ_CARDS);
  const out = stays.filter((s) => s.title).map((s) => ({ ...s, priceCents: priceToCents(s.price) }));
  if (!out.length) throw new BrowserError("fiches illisibles sur la page de résultats", "element_introuvable");
  return { site: "booking", place: q.place, checkin: q.checkin, checkout, adults: q.adults ?? 1, stays: out };
}
