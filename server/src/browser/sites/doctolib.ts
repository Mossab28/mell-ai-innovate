import { BrowserError, type PageDriver } from "../types.ts";
import { clean, inPage, jsonAfter, norm, pwOf, refuseCookies, slotLabel, step, typeSlowly, type Pw } from "./common.ts";

/**
 * Doctolib : premiers créneaux pour une spécialité et un lieu, en lecture seule.
 *
 * Comme une personne : barre de recherche (spécialité puis lieu, choisis dans les suggestions du
 * site), bouton Rechercher. On lit la liste que le site se renvoie (patient-health-search/hcp/search),
 * puis les disponibilités de chaque praticien avec la même requête que la page fait quand on fait
 * défiler les fiches (search/availabilities.json). Aucun clic sur un créneau, rien n'est réservé.
 */

export interface DoctolibQuery {
  speciality: string;
  place: string;
  /** Téléconsultation plutôt qu'au cabinet. */
  telehealth?: boolean;
}

export interface DoctolibOption {
  practitioner: string;
  speciality?: string;
  address: string;
  motive?: string;
  slots: Array<{ at: string; label: string }>;
  url: string;
}

export interface DoctolibResult {
  site: "doctolib";
  searchUrl: string;
  /** Praticiens trouvés par le site pour cette recherche. */
  total: number;
  /** Praticiens dont on a lu l'agenda (la première page de résultats). */
  checked: number;
  options: DoctolibOption[];
}

const BASE = "https://www.doctolib.fr";

/**
 * Dans la page : la requête de disponibilités que Doctolib fait quand on fait défiler les fiches,
 * quatre fiches à la fois. Rien cette semaine : le site donne la date du prochain créneau, on lit
 * ce jour-là. En texte, voir inPage().
 */
const AVAILABILITIES_FN = `async ({ providers, start, telehealth }) => {
  const one = async (h, from) => {
    const u = new URLSearchParams({ telehealth: String(telehealth), limit: "7", start_date_time: from, visit_motive_id: h.motive, agenda_ids: h.agendas, practice_ids: h.practice });
    const r = await fetch("/search/availabilities.json?" + u, { credentials: "include", headers: { accept: "application/json" } });
    return r.ok ? r.json() : { error: r.status };
  };
  const out = [];
  for (let i = 0; i < providers.length; i += 4) {
    const batch = await Promise.all(providers.slice(i, i + 4).map(async (h) => {
      let a = await one(h, start);
      if (!a.error && !a.total && a.next_slot) a = await one(h, a.next_slot);
      const slots = (a.availabilities || []).flatMap((d) => d.slots || []).map((s) => (typeof s === "string" ? s : s.start_date)).filter(Boolean);
      return { id: h.id, slots, error: a.error };
    }));
    out.push(...batch);
  }
  return out;
}`;

export async function doctolibSearch(page: PageDriver, q: DoctolibQuery, o: { tz?: string; max?: number; now?: Date } = {}): Promise<DoctolibResult> {
  if (!q.speciality?.trim() || !q.place?.trim()) throw new BrowserError("il faut une spécialité et un lieu", "politique");
  const p = await pwOf(page);
  await step("page d'accueil", () => page.goto(`${BASE}/`, 30_000));
  await refuseCookies(p);

  const what = p.locator("input.searchbar-query-input, input[placeholder^='Nom, sp']").first();
  await step("champ spécialité", () => what.waitFor({ timeout: 15_000 }));
  await step("suggestions de spécialité", () =>
    jsonAfter(
      p,
      (r: Pw) => /patient-health-search\/api\/v1\/autocomplete/.test(r.url()) && norm(bodyQuery(r.request().postData())) === norm(q.speciality),
      () => typeSlowly(what, q.speciality),
      15_000,
    ),
  );
  await step("choix de la spécialité", () => pick(p, q.speciality, "spécialité"));

  const where = p.locator("input.searchbar-place-input, input[placeholder^='Où']").first();
  await step("suggestions de lieu", () =>
    jsonAfter(p, (r: Pw) => /place_autocomplete/.test(r.url()) && norm(queryOf(r.url())) === norm(q.place), () => typeSlowly(where, q.place), 15_000),
  );
  await step("choix du lieu", () => pick(p, q.place, "lieu"));

  const data = await step("résultats de recherche", () =>
    jsonAfter<{ total: number; healthcareProviders: any[] }>(
      p,
      (r: Pw) => /patient-health-search\/api\/v1\/hcp\/search/.test(r.url()),
      () => p.getByRole("button", { name: /Rechercher/ }).first().click({ timeout: 10_000 }),
      25_000,
    ),
  );
  const searchUrl = p.url();
  if (!/\/search\?|doctolib\.fr\/[^/]+\/[^/?]+/.test(searchUrl)) throw new BrowserError(`la recherche n'a pas abouti (${searchUrl})`, "page_changee");

  const providers = (data.healthcareProviders ?? []).filter((h) => h.onlineBooking?.agendaIds?.length && h.matchedVisitMotive?.visitMotiveId && h.references?.practiceId);
  const start = (o.now ?? new Date()).toISOString();
  // On n'envoie à la page que ce dont la requête a besoin.
  const asked = providers.map((h) => ({
    id: h.id,
    motive: String(h.matchedVisitMotive.visitMotiveId),
    agendas: (h.matchedVisitMotive.agendaIds ?? h.onlineBooking.agendaIds).join("-"),
    practice: String(h.references.practiceId),
  }));
  const slots = await step("agendas des praticiens", () =>
    inPage<Array<{ id: string; slots: string[]; error?: number }>>(p, AVAILABILITIES_FN, { providers: asked, start, telehealth: !!q.telehealth }),
  );
  if (providers.length && slots.every((s) => s.error)) throw new BrowserError(`agendas illisibles (HTTP ${slots[0].error})`, "detection_robot");

  const byId = new Map(slots.map((s) => [s.id, s.slots]));
  const options = providers
    .map((h): DoctolibOption & { first: number } => {
      const list = (byId.get(h.id) ?? []).slice(0, 3);
      return {
        practitioner: clean([h.title, h.firstName, h.name].filter(Boolean).join(" ")),
        speciality: clean(h.speciality?.name) || undefined,
        address: clean([h.location?.address, [h.location?.zipcode, h.location?.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")),
        motive: clean(h.matchedVisitMotive?.name) || undefined,
        slots: list.map((at) => ({ at, label: slotLabel(at, o.tz) })),
        url: `${BASE}${String(h.link ?? "").split("#")[0]}`,
        first: list.length ? new Date(list[0]).getTime() : Infinity,
      };
    })
    .filter((x) => x.slots.length)
    .sort((a, b) => a.first - b.first)
    .slice(0, o.max ?? 5)
    .map(({ first: _f, ...rest }) => rest);

  return { site: "doctolib", searchUrl, total: Number(data.total ?? providers.length), checked: providers.length, options };
}

function bodyQuery(body: string | null): string {
  try {
    return String(JSON.parse(body ?? "{}").query ?? "");
  } catch {
    return "";
  }
}

function queryOf(url: string): string {
  try {
    return new URL(url).searchParams.get("query") ?? "";
  } catch {
    return "";
  }
}

/** Choisit la suggestion du site qui ressemble le plus à ce qui a été tapé (jamais « Autour de moi »). */
async function pick(p: Pw, typed: string, what: string): Promise<void> {
  const options = p.locator("button[role=option]");
  await options.first().waitFor({ timeout: 10_000 }).catch(() => {
    throw new BrowserError(`aucune suggestion pour le ${what} « ${typed} »`, "element_introuvable");
  });
  await p.waitForTimeout(250);
  const texts: string[] = (await options.allInnerTexts()).map((t: string) => norm(t));
  const want = norm(typed);
  const ok = (i: number) => !/^autour de moi/.test(texts[i]);
  let i = texts.findIndex((t, k) => ok(k) && t.startsWith(want));
  if (i < 0) i = texts.findIndex((t, k) => ok(k) && t.includes(want.split(" ")[0]));
  if (i < 0) i = texts.findIndex((_t, k) => ok(k));
  if (i < 0) throw new BrowserError(`aucune suggestion utilisable pour le ${what} « ${typed} »`, "element_introuvable");
  await options.nth(i).click({ timeout: 5000 });
  await p.waitForTimeout(400);
}
