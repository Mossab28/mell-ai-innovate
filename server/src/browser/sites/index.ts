import type { Db } from "../../db.ts";
import type { User } from "../../users.ts";
import { trainTimes } from "../../trains/gtfs.ts";
import { browseForUser, browserRuntime, type SessionManager } from "../index.ts";
import { BrowserError, type PageDriver } from "../types.ts";
import { whyBlocked } from "./common.ts";
import { doctolibSearch, type DoctolibQuery } from "./doctolib.ts";
import { sncfSearch, type SncfQuery } from "./sncf.ts";
import { theforkSearch, type TheForkQuery } from "./thefork.ts";
import { bookingSearch, searchUrl as bookingUrl, type BookingQuery } from "./booking.ts";

export { doctolibSearch, type DoctolibQuery, type DoctolibResult } from "./doctolib.ts";
export { sncfSearch, type SncfQuery, type SncfResult } from "./sncf.ts";
export { theforkSearch, type TheForkQuery, type TheForkResult } from "./thefork.ts";
export { bookingSearch, type BookingQuery, type BookingResult } from "./booking.ts";

/**
 * Les parcours enregistrés : une recherche fiable, sans modèle à chaque étape, sur les sites où la
 * boucle d'agent échoue le plus (banc du 14/10 : Doctolib 2 sur 32). Si le parcours casse (site
 * changé, anti-robot), on retente une fois avec le second navigateur, puis on rend la main à la
 * boucle d'agent, puis on dit honnêtement ce qui bloque.
 */

export type SiteName = "doctolib" | "sncf" | "thefork" | "booking";
export type SiteQuery = { doctolib: DoctolibQuery; sncf: SncfQuery; thefork: TheForkQuery; booking: BookingQuery };

const FLOWS: { [K in SiteName]: (page: PageDriver, q: SiteQuery[K], o: { tz?: string }) => Promise<unknown> } = {
  doctolib: (page, q, o) => doctolibSearch(page, q, { tz: o.tz }),
  sncf: (page, q) => sncfSearch(page, q),
  thefork: (page, q) => theforkSearch(page, q),
  booking: (page, q) => bookingSearch(page, q),
};

/** Ouvre la page de résultats d'une recherche de site sur une page donnée (avant une réservation par le navigateur). */
export function openSiteResults<K extends SiteName>(site: K, page: PageDriver, q: SiteQuery[K], tz?: string): Promise<unknown> {
  return FLOWS[site](page, q, { tz });
}

export const SITE_NAMES = Object.keys(FLOWS) as SiteName[];

const START: Record<SiteName, string> = {
  doctolib: "https://www.doctolib.fr/",
  sncf: "https://www.sncf-connect.com/",
  thefork: "https://www.thefork.fr/",
  booking: "https://www.booking.com/",
};

/** La même demande, en phrase, pour la boucle d'agent quand le parcours n'a pas suffi. */
export function objectiveFor<K extends SiteName>(site: K, q: SiteQuery[K]): string {
  if (site === "booking") {
    const b = q as BookingQuery;
    return `Sur booking.com (${bookingUrl(b)}), logements à ${b.place} du ${b.checkin}${b.checkout ? ` au ${b.checkout}` : ""} pour ${b.adults ?? 1} personne(s), du moins cher : nom, prix total, note, distance. Lecture seule, ne réserve rien.`;
  }
  if (site === "doctolib") {
    const d = q as DoctolibQuery;
    return `Sur doctolib.fr, trouve les premiers créneaux disponibles pour ${d.speciality} à ${d.place}${d.telehealth ? " en téléconsultation" : ""} : nom du praticien, adresse, date et heure. Lecture seule, ne réserve rien.`;
  }
  if (site === "sncf") {
    const s = q as SncfQuery;
    return `Sur sncf-connect.com, trains de ${s.from} à ${s.to} le ${s.date}${s.time ? ` à partir de ${s.time}` : ""} : horaires, durée, direct ou non, prix le plus bas. Lecture seule, ne mets rien au panier.`;
  }
  const t = q as TheForkQuery;
  return `Sur thefork.fr, créneaux disponibles pour ${t.partySize} personnes le ${t.date}${t.time ? ` vers ${t.time}` : ""}${t.restaurant ? ` au restaurant ${t.restaurant}` : ""}${t.cuisine ? `, cuisine ${t.cuisine}` : ""}${t.area ? ` (${t.area})` : ""}. Lecture seule, ne réserve rien.`;
}

export interface SiteSearchResult {
  site: SiteName;
  /** « parcours » : données lues dans les réponses du site ; « agent » : la boucle d'agent a pris le relais. */
  via: "parcours" | "agent" | "horaires";
  ok: boolean;
  data?: unknown;
  answer?: string;
  reason?: string;
  engine: string;
  ms: number;
}

const FLOW_TIMEOUT_MS = 75_000;

/** `noAgent` : pas de repli sur la boucle d'agent (surveillances : un passage doit rester bon marché). */
export async function siteSearchForUser<K extends SiteName>(user: User, site: K, q: SiteQuery[K], opts: { noAgent?: boolean } = {}): Promise<SiteSearchResult> {
  const rt = browserRuntime();
  if (!rt) throw new BrowserError("navigateur non branché sur ce serveur", "politique");
  const t0 = Date.now();
  const failures: string[] = [];
  for (const sessions of [rt.sessions, rt.fallback].filter(Boolean) as SessionManager[]) {
    const r = await runFlow(rt.db, sessions, user, site, q);
    if (r.ok) return { site, via: "parcours", ok: true, data: r.data, engine: sessions.engineName, ms: Date.now() - t0 };
    failures.push(`${sessions.engineName} : ${r.reason}`);
    // Le second navigateur n'aide que contre un anti-robot ; un site changé le reste pour lui aussi.
    if (!r.blocked) break;
  }
  if (opts.noAgent) return { site, via: "parcours", ok: false, reason: failures.join(" ; "), engine: rt.sessions.engineName, ms: Date.now() - t0 };
  // Trains : les horaires officiels (données ouvertes SNCF) répondent sans navigateur, sans prix ni places.
  if (site === "sncf") {
    const sq = q as SiteQuery["sncf"];
    const after = sq.time && /^\d{1,2}:\d{2}/.test(sq.time) ? `${String(Math.max(0, Number(sq.time.split(":")[0]) - 1)).padStart(2, "0")}:${sq.time.split(":")[1].slice(0, 2)}` : undefined;
    const trains = await trainTimes({ from: sq.from, to: sq.to, date: sq.date, after, max: 8 }).catch(() => []);
    if (trains.length) {
      return { site, via: "horaires", ok: true, data: { site: "sncf", source: "horaires officiels SNCF (données ouvertes), sans prix ni places restantes", from: sq.from, to: sq.to, date: sq.date, trains }, reason: failures.join(" ; "), engine: "horaires", ms: Date.now() - t0 };
    }
  }
  // Dernier recours : la boucle d'agent, qui lit l'écran et s'adapte.
  try {
    // Le parcours dédié a déjà échoué : un repli court, pas quarante étapes muettes.
    const b = await browseForUser(user, { objective: objectiveFor(site, q), startUrl: START[site], maxSteps: 20 });
    return {
      site,
      via: "agent",
      ok: b.status === "done",
      answer: b.answer,
      reason: b.status === "done" ? undefined : [b.reason, ...failures].filter(Boolean).join(" ; "),
      engine: b.engine,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { site, via: "agent", ok: false, reason: [...failures, e instanceof Error ? e.message : String(e)].join(" ; "), engine: rt.sessions.engineName, ms: Date.now() - t0 };
  }
}

async function runFlow<K extends SiteName>(
  db: Pick<Db, "query">,
  sessions: SessionManager,
  user: User,
  site: K,
  q: SiteQuery[K],
): Promise<{ ok: true; data: unknown } | { ok: false; reason: string; blocked: boolean }> {
  const t0 = Date.now();
  let page: PageDriver | undefined;
  let out: { ok: true; data: unknown } | { ok: false; reason: string; blocked: boolean };
  let timer: NodeJS.Timeout | undefined;
  try {
    page = await sessions.open(user.id);
    sessions.setBusy(user.id, true);
    const flow = FLOWS[site](page, q, { tz: user.timezone });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BrowserError(`parcours trop long (${FLOW_TIMEOUT_MS / 1000} s)`, "delai")), FLOW_TIMEOUT_MS);
    });
    flow.catch(() => {});
    out = { ok: true, data: await Promise.race([flow, timeout]) };
  } catch (e) {
    const blockedBy = page ? await whyBlocked(page) : undefined;
    const be = e instanceof BrowserError ? e : new BrowserError(e instanceof Error ? e.message.split("\n")[0] : String(e));
    out = { ok: false, reason: blockedBy ? `bloqué par ${blockedBy}` : be.message, blocked: !!blockedBy || be.category === "detection_robot" };
    // Un parcours abandonné en route ne doit pas continuer à manipuler la page que l'agent va reprendre.
    if (be.category === "delai") await sessions.close(user.id).catch(() => {});
  } finally {
    if (timer) clearTimeout(timer);
    sessions.setBusy(user.id, false);
    await sessions.save(user.id);
  }
  await db
    .query(
      `INSERT INTO browser_runs (user_id, task_id, engine, objective, status, answer, reason, steps, duration_ms, cost_usd, errors, pages)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, 0, $7, 0, $8, $9)`,
      [
        user.id,
        `${sessions.engineName}/parcours`,
        `parcours ${site} ${JSON.stringify(q)}`.slice(0, 1000),
        out.ok ? "done" : "error",
        out.ok ? JSON.stringify(out.data).slice(0, 4000) : null,
        out.ok ? null : out.reason,
        Date.now() - t0,
        JSON.stringify(out.ok ? [] : [out.reason]),
        JSON.stringify([START[site]]),
      ],
    )
    .catch(() => {});
  return out;
}
