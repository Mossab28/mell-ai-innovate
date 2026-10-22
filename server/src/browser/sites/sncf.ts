import { BrowserError, type PageDriver } from "../types.ts";
import { clean, isIsoDate, jsonAfter, minutesOf, norm, pwOf, refuseCookies, step, typeSlowly, type Pw } from "./common.ts";

/**
 * SNCF Connect : trains entre deux villes à une date, en lecture seule.
 *
 * Comme une personne : onglet Trains, départ et arrivée choisis dans les suggestions du site, date
 * et heure dans le calendrier, Rechercher. On lit la réponse que le site se renvoie
 * (bff/api/v1/itineraries) : horaires, durée, direct ou non, prix le plus bas, complet. Aucun clic
 * sur une offre, rien n'est mis au panier.
 */

export interface SncfQuery {
  from: string;
  to: string;
  /** AAAA-MM-JJ, jour du départ. */
  date: string;
  /** HH:MM, heure de départ souhaitée (la recherche part de l'heure paire juste avant). */
  time?: string;
}

export interface SncfTrain {
  departure: string;
  arrival: string;
  duration: string;
  from: string;
  to: string;
  summary: string;
  price?: number;
  bookable: boolean;
  status?: string;
  /** Trajets régionaux : « 1 correspondance », et les travaux ou perturbations que le site signale. */
  connections?: string;
  alerts?: string[];
}

export interface SncfResult {
  site: "sncf";
  from: string;
  to: string;
  date: string;
  trains: SncfTrain[];
  cheapest?: SncfTrain;
}

const BASE = "https://www.sncf-connect.com";
const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** « jeudi 15 octobre 2026 » : le libellé que SNCF Connect met sur la case du calendrier. */
export function calendarLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Le menu des heures ne propose que les heures paires de 4 h à 22 h : on prend celle juste avant. */
export function hourChoice(time: string | undefined): string {
  const m = minutesOf(time);
  const h = m === undefined ? 6 : Math.floor(m / 60);
  const even = Math.min(22, Math.max(4, h - (h % 2)));
  return `${String(even).padStart(2, "0")}h`;
}

export async function sncfSearch(page: PageDriver, q: SncfQuery, o: { max?: number } = {}): Promise<SncfResult> {
  if (!q.from?.trim() || !q.to?.trim()) throw new BrowserError("il faut une ville de départ et une ville d'arrivée", "politique");
  if (!isIsoDate(q.date)) throw new BrowserError("date attendue au format AAAA-MM-JJ", "politique");
  const p = await pwOf(page);
  await step("page d'accueil", () => page.goto(`${BASE}/`, 30_000));
  await refuseCookies(p);
  // Sur un navigateur distant (AgentCore), le bandeau arrive après le chargement et couvrirait les champs.
  await refuseCookies(p, 4000);
  const fields = p.getByPlaceholder("Gare, ville, lieu...");
  // Le bandeau de cookies peut tomber plusieurs secondes après la page et avaler le clic : on restait sur « Tout
  // rechercher », qui rend des itinéraires sans prix. On reclique, bandeau refusé, jusqu'à voir le formulaire des trains.
  await step("onglet Trains", async () => {
    for (let i = 0; i < 4; i++) {
      await p.locator("#home-search-tab-train").click({ timeout: 4000 }).catch(() => {});
      if (await fields.first().waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false)) return;
      await refuseCookies(p, 6000);
    }
    throw new BrowserError("le formulaire des trains ne s'ouvre pas", "page_changee");
  });
  await p.waitForTimeout(300);

  for (const [i, text] of [[0, q.from], [1, q.to]] as const) {
    const label = i === 0 ? "départ" : "arrivée";
    const suggestions = await step(`suggestions ${label}`, () =>
      jsonAfter(p, (r: Pw) => /bff\/api\/v2\/autocomplete/.test(r.url()) && norm(termOf(r.request().postData())) === norm(text), () => typeSlowly(fields.nth(i), text), 15_000),
    );
    await p.waitForTimeout(300);
    await step(`choix ${label}`, () => pickPlace(p, text, bestPlace(suggestions)));
  }

  await step("ouverture du calendrier", () => openCalendar(p));
  await step("choix du jour", () => pickDay(p, q.date));
  await step("menu des heures", () => p.locator("#startDateTime").click({ timeout: 8000 }));
  await p.waitForTimeout(400);
  await step("choix de l'heure", () => p.getByText(hourChoice(q.time), { exact: true }).last().click({ timeout: 8000 }));
  await p.waitForTimeout(300);
  await step("bouton Confirmer", () => p.getByRole("button", { name: "Confirmer" }).click({ timeout: 8000 }));
  await p.waitForTimeout(400);

  const data = await step("résultats", () =>
    jsonAfter<any>(
      p,
      (r: Pw) => /bff\/api\/v1\/itineraries$/.test(r.url().split("?")[0]) && r.request().method() === "POST",
      () => p.locator("button[name=search-button]").first().click({ timeout: 10_000 }),
      35_000,
    ),
  );
  const proposals: any[] = data?.longDistance?.proposals?.proposals ?? [];
  // TER, Transilien et trajets avec correspondances : le site les range en « porte à porte », sans prix.
  if (!proposals.length) {
    const regional = doorToDoor(data, o.max ?? 8);
    if (regional.length) return { site: "sncf", from: q.from, to: q.to, date: q.date, trains: regional };
    const status = clean(data?.longDistance?.status);
    throw new BrowserError(`aucun train renvoyé par le site${status ? ` (${status})` : ""}`, "page_changee");
  }
  // Le site rend parfois le même train deux fois (deux offres) : une ligne par train, la moins chère.
  const seen = new Set<string>();
  const unique = [...proposals]
    .sort((a, b) => (a.bestPrice?.value ?? Infinity) - (b.bestPrice?.value ?? Infinity))
    .filter((x) => {
      const key = `${x.departure?.timeLabel}|${x.arrival?.timeLabel}|${x.transporterDescription}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => proposals.indexOf(a) - proposals.indexOf(b));
  const trains = unique.slice(0, o.max ?? 8).map(
    (x): SncfTrain => ({
      departure: clean(x.departure?.timeLabel, 8),
      arrival: clean(x.arrival?.timeLabel, 8),
      duration: clean(x.durationLabel, 12),
      from: clean(x.departure?.originStationLabel, 60),
      to: clean(x.arrival?.destinationStationLabel, 60),
      summary: clean(x.transporterDescription, 60),
      price: typeof x.bestPrice?.value === "number" ? x.bestPrice.value : undefined,
      bookable: !!x.status?.isBookable,
      status: x.status?.isBookable ? undefined : clean(x.status?.label ?? x.status?.title, 40) || "indisponible",
    }),
  );
  const sellable = trains.filter((t) => t.bookable && t.price !== undefined);
  const cheapest = sellable.sort((a, b) => a.price! - b.price!)[0];
  return { site: "sncf", from: q.from, to: q.to, date: q.date, trains, cheapest };
}

/** Itinéraires « porte à porte » : horaires, durée, lignes empruntées (« Transilien N puis TER »), alertes. */
export function doorToDoor(data: any, max: number): SncfTrain[] {
  const seen = new Set<string>();
  const out: SncfTrain[] = [];
  for (const group of data?.doorToDoor?.results?.doorToDoorItineraries ?? []) {
    for (const it of group?.itineraries ?? []) {
      if (it?.feasible === false) continue;
      const rides = (it?.legs ?? []).filter((l: any) => l?.mode === "TRANSIT" && l?.type !== "WAITING");
      const names = rides.map((l: any) => clean(l?.type === "TER" ? "TER" : [l?.label, l?.line?.name].filter(Boolean).join(" "), 30)).filter(Boolean);
      const summary = names.filter((n: string, i: number) => n !== names[i - 1]).join(" puis ");
      const last = rides.at(-1);
      const to = clean(/Arrivée à (.+?) à \d/.exec(String(last?.stopSemanticLabel ?? ""))?.[1] ?? it?.destination?.label, 60);
      const train: SncfTrain = {
        departure: clean(it?.departureTimeLabel, 8),
        arrival: clean(it?.arrivalTimeLabel, 8),
        duration: clean(it?.durationLabel, 12),
        from: clean(it?.origin?.label, 60),
        to,
        summary: clean(summary, 80),
        bookable: true,
        connections: clean(it?.connectionsLabel, 30) || undefined,
        alerts: (it?.disruptions?.messages ?? []).map((m: any) => clean(m?.title, 160)).filter(Boolean).slice(0, 2),
      };
      const key = `${train.departure}|${train.arrival}|${train.summary}`;
      if (!train.departure || seen.has(key)) continue;
      seen.add(key);
      out.push(train);
    }
  }
  return out.sort((a, b) => a.departure.localeCompare(b.departure)).slice(0, max);
}

function termOf(body: string | null): string {
  try {
    return String(JSON.parse(body ?? "{}").searchTerm ?? "");
  } catch {
    return "";
  }
}

/**
 * La première gare ou ville que le site propose, dans son ordre à lui. « Paris Est » rendait d'abord « Paris est
 * toujours Paris, Passage Jouffroy » (un café) avant « Paris Gare de l'Est » : le trajet partait du café, à pied, sans prix.
 */
export function bestPlace(suggestions: any): string | undefined {
  const all: any[] = (suggestions?.places ?? []).flatMap((g: any) => g?.results ?? []);
  const place = all.find((r) => ["STATION", "CITY"].includes(r?.type?.placeType));
  return place ? clean(place.label, 120) : undefined;
}

/** La suggestion de la gare ou de la ville choisie ; à défaut, la première qui commence par ce qui a été tapé. */
async function pickPlace(p: Pw, typed: string, label?: string): Promise<void> {
  const options = p.locator("[role=option]");
  await options.first().waitFor({ timeout: 10_000 }).catch(() => {
    throw new BrowserError(`aucune gare ou ville pour « ${typed} »`, "element_introuvable");
  });
  const texts: string[] = (await options.allInnerTexts()).map((t: string) => norm(t));
  const chosen = label ? texts.findIndex((t) => t.startsWith(norm(label))) : -1;
  const i = chosen >= 0 ? chosen : Math.max(0, texts.findIndex((t) => t.startsWith(norm(typed))));
  await options.nth(i).click({ timeout: 5000 });
  await p.waitForTimeout(500);
}

/** Le calendrier s'ouvre parfois tout seul après le choix de l'arrivée : on ne clique que s'il est fermé. */
async function openCalendar(p: Pw): Promise<void> {
  if (await p.locator("#startDateTime").isVisible().catch(() => false)) return;
  await p.locator("button[aria-label^='Aller']").first().click({ timeout: 10_000 });
  await p.waitForTimeout(500);
}

/** Case du jour dans le calendrier, en avançant de mois en mois si besoin. */
async function pickDay(p: Pw, date: string): Promise<void> {
  const day = p.locator(`button[aria-label^='${calendarLabel(date)}']`).first();
  for (let i = 0; i < 12; i++) {
    if (await day.isVisible().catch(() => false)) {
      await day.click({ timeout: 5000 });
      await p.waitForTimeout(400);
      return;
    }
    const next = p.locator("button[aria-label*='mois suivant']").first();
    if (!(await next.isVisible().catch(() => false))) break;
    await next.click({ timeout: 5000 });
    await p.waitForTimeout(400);
  }
  throw new BrowserError(`le ${date} n'est pas proposé dans le calendrier du site`, "element_introuvable");
}
