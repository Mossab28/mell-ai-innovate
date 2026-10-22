import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

/**
 * Horaires officiels SNCF en données ouvertes (GTFS, licence ODbL), sans navigateur : TGV INOUI, OUIGO,
 * Intercités, TER (fichier unifié) et Transilien (fichier à part). Rechargés une fois par jour, lus en
 * mémoire. Aucun prix : c'est le secours quand SNCF Connect bloque, et la réponse instantanée aux
 * questions d'horaires. Les anciens fichiers par activité sont figés depuis janvier 2025 : jamais eux.
 */

const FEEDS = {
  sncf: "https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip",
  transilien: "https://eu.ftp.opendatasoft.com/sncf/gtfs/transilien-gtfs.zip",
};
const DAY_MS = 86_400_000;
const run = promisify(execFile);

export interface TrainTime {
  departure: string;
  arrival: string;
  from: string;
  to: string;
  /** « TER », « TGV INOUI », « Transilien N », « Car TER ». */
  line: string;
  number?: string;
  direction?: string;
}

interface Timetable {
  loadedAt: number;
  names: string[];
  folded: string[];
  /** Position de chaque gare, pour « Paris » : ses grandes gares s'appellent « Gare Montparnasse » côté Transilien. */
  inParis: boolean[];
  /** Arrêts du trajet, par trois : gare (indice dans names), départ et arrivée en minutes depuis minuit. */
  trips: Array<{ stops: Int32Array; service: string; line: string; number?: string; direction?: string }>;
  byStation: Map<number, number[]>;
  services: Map<string, Set<string>>;
}

let table: Timetable | undefined;
let loading: Promise<Timetable> | undefined;

export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const minutes = (t: string) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};
const clock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Une ligne CSV, guillemets compris (« Paris, Gare de Lyon »). */
function cells(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") out.push(cur), (cur = "");
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function eachRow(file: string, fn: (row: Record<string, string>) => void): Promise<void> {
  if (!existsSync(file)) return;
  let head: string[] | undefined;
  for await (const raw of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    const line = raw.replace(/^﻿/, "");
    if (!line) continue;
    const c = cells(line);
    if (!head) {
      head = c;
      continue;
    }
    const row: Record<string, string> = {};
    for (let i = 0; i < head.length; i++) row[head[i]] = c[i] ?? "";
    fn(row);
  }
}

/** Télécharge les deux fichiers s'ils ont plus d'un jour. En cas d'échec, on garde la copie d'hier. */
async function refresh(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const [name, url] of Object.entries(FEEDS)) {
    const zip = join(dir, `${name}.zip`);
    if (existsSync(zip) && Date.now() - statSync(zip).mtimeMs < DAY_MS) continue;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      await run("unzip", ["-o", "-q", zip, "-d", join(dir, name)], { timeout: 120_000 });
    } catch {
      // Copie précédente, s'il y en a une.
    }
  }
}

async function load(dir: string): Promise<Timetable> {
  await refresh(dir);
  const names: string[] = [];
  const inParis: boolean[] = [];
  const index = new Map<string, number>();
  const trips: Timetable["trips"] = [];
  const services = new Map<string, Set<string>>();
  for (const feed of Object.keys(FEEDS)) {
    const base = join(dir, feed);
    // Gares : chaque quai renvoie à sa zone d'arrêt (parent_station), une gare est une zone.
    const area = new Map<string, number>();
    const parents = new Map<string, string>();
    const stopNames = new Map<string, string>();
    const paris = new Map<string, boolean>();
    await eachRow(join(base, "stops.txt"), (r) => {
      stopNames.set(r.stop_id, r.stop_name);
      if (r.parent_station) parents.set(r.stop_id, r.parent_station);
      const [lat, lon] = [Number(r.stop_lat), Number(r.stop_lon)];
      paris.set(r.stop_id, lat > 48.815 && lat < 48.903 && lon > 2.224 && lon < 2.47);
    });
    for (const [id, name] of stopNames) {
      const root = parents.get(id) ?? id;
      const label = stopNames.get(root) || name;
      const key = `${feed}|${root}`;
      if (!index.has(key)) {
        index.set(key, names.push(label) - 1);
        inParis.push(paris.get(root) ?? paris.get(id) ?? false);
      }
      area.set(id, index.get(key)!);
    }
    // Produit : dans le fichier unifié il est dans l'identifiant du quai (« StopPoint:OCETrain TER-87393488 »).
    const product = (stopId: string) => /^StopPoint:OCE(.+)-\d+$/.exec(stopId)?.[1];
    const routes = new Map<string, { name: string; type: string }>();
    await eachRow(join(base, "routes.txt"), (r) => routes.set(r.route_id, { name: r.route_short_name || r.route_long_name, type: r.route_type }));
    const tripInfo = new Map<string, { service: string; route: string; headsign: string; short: string }>();
    await eachRow(join(base, "trips.txt"), (r) => tripInfo.set(r.trip_id, { service: `${feed}|${r.service_id}`, route: r.route_id, headsign: r.trip_headsign, short: r.trip_short_name ?? "" }));
    await eachRow(join(base, "calendar.txt"), (r) => {
      const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const set = services.get(`${feed}|${r.service_id}`) ?? new Set<string>();
      const start = Date.UTC(+r.start_date.slice(0, 4), +r.start_date.slice(4, 6) - 1, +r.start_date.slice(6, 8));
      const end = Date.UTC(+r.end_date.slice(0, 4), +r.end_date.slice(4, 6) - 1, +r.end_date.slice(6, 8));
      for (let t = start; t <= end && t - start < 400 * DAY_MS; t += DAY_MS) {
        const d = new Date(t);
        if (r[days[d.getUTCDay()]] === "1") set.add(d.toISOString().slice(0, 10).replace(/-/g, ""));
      }
      services.set(`${feed}|${r.service_id}`, set);
    });
    await eachRow(join(base, "calendar_dates.txt"), (r) => {
      const key = `${feed}|${r.service_id}`;
      const set = services.get(key) ?? new Set<string>();
      if (r.exception_type === "1") set.add(r.date);
      else set.delete(r.date);
      services.set(key, set);
    });
    // Arrêts de chaque trajet, regroupés puis rangés par ordre de passage.
    const grouped = new Map<string, Array<[number, number, number, number]>>();
    const firstStop = new Map<string, string>();
    await eachRow(join(base, "stop_times.txt"), (r) => {
      const a = area.get(r.stop_id);
      if (a === undefined) return;
      let g = grouped.get(r.trip_id);
      if (!g) grouped.set(r.trip_id, (g = []));
      if (!firstStop.has(r.trip_id)) firstStop.set(r.trip_id, r.stop_id);
      g.push([Number(r.stop_sequence), a, minutes(r.departure_time || r.arrival_time), minutes(r.arrival_time || r.departure_time)]);
    });
    for (const [tripId, g] of grouped) {
      const info = tripInfo.get(tripId);
      if (!info) continue;
      g.sort((x, y) => x[0] - y[0]);
      const route = routes.get(info.route);
      const kind = product(firstStop.get(tripId) ?? "");
      const line = feed === "transilien" && route?.name && route.name !== "TER" ? `Transilien ${route.name}` : kind ?? (route?.type === "3" ? "Car" : route?.name || "Train");
      const stops = new Int32Array(g.length * 3);
      g.forEach((s, i) => stops.set([s[1], s[2], s[3]], i * 3));
      trips.push({ stops, service: info.service, line, number: info.short || info.headsign || undefined, direction: undefined });
    }
  }
  const byStation = new Map<number, number[]>();
  trips.forEach((t, i) => {
    for (let k = 0; k < t.stops.length; k += 3) {
      const s = t.stops[k];
      const list = byStation.get(s);
      if (!list) byStation.set(s, [i]);
      else if (list[list.length - 1] !== i) list.push(i);
    }
  });
  return { loadedAt: Date.now(), names, folded: names.map(fold), inParis, trips, byStation, services };
}

async function timetable(dir: string): Promise<Timetable> {
  if (table && Date.now() - table.loadedAt < DAY_MS) return table;
  // Une seule lecture à la fois ; la copie d'hier sert pendant le rechargement.
  loading ??= load(dir).then((t) => (table = t)).finally(() => (loading = undefined));
  return table ?? loading;
}

/**
 * Les gares qui correspondent à ce qu'elle a tapé : le nom exact et ceux qui commencent par lui
 * (« Lyon » : Lyon Part Dieu, Lyon Perrache), sinon ceux qui le contiennent (« Montparnasse »).
 * « Paris » : toutes les gares dans Paris, quel que soit leur nom.
 */
function stations(t: Timetable, typed: string): number[] {
  const q = fold(typed);
  if (!q) return [];
  const first: number[] = [];
  const inside: number[] = [];
  t.folded.forEach((n, i) => {
    if (n === q || n.startsWith(`${q} `) || (q === "paris" && t.inParis[i] && /^(gare|paris)\b/.test(n))) first.push(i);
    else if (` ${n} `.includes(` ${q} `)) inside.push(i);
  });
  return (first.length ? first : inside).slice(0, 60);
}

/**
 * Trains directs de `from` vers `to` un jour donné (AAAA-MM-JJ), à partir de `after` (HH:MM).
 * Les gares sont lues par leur nom : « Paris » couvre toutes les gares de Paris.
 */
export async function trainTimes(q: { from: string; to: string; date: string; after?: string; max?: number }, dir = join(process.cwd(), ".data", "gtfs")): Promise<TrainTime[]> {
  const t = await timetable(dir);
  const from = new Set(stations(t, q.from));
  const to = new Set(stations(t, q.to));
  if (!from.size || !to.size) return [];
  const day = q.date.replace(/-/g, "");
  const after = q.after ? Math.max(0, minutes(q.after)) : 0;
  const seen = new Set<string>();
  const out: Array<TrainTime & { m: number }> = [];
  const candidates = new Set<number>();
  for (const s of from) for (const i of t.byStation.get(s) ?? []) candidates.add(i);
  for (const i of candidates) {
    const trip = t.trips[i];
    if (!t.services.get(trip.service)?.has(day)) continue;
    const st = trip.stops;
    let dep = -1;
    for (let k = 0; k < st.length; k += 3) {
      if (dep < 0 && from.has(st[k])) dep = k;
      else if (dep >= 0 && to.has(st[k])) {
        const m = st[dep + 1];
        if (m >= after) {
          const train: TrainTime = { departure: clock(m), arrival: clock(st[k + 2]), from: t.names[st[dep]], to: t.names[st[k]], line: trip.line, number: trip.number };
          // Un même TER figure dans les deux fichiers, sous deux noms de gare : l'horaire suffit à le reconnaître.
          const key = `${train.departure}|${train.arrival}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ ...train, m });
          }
        }
        break;
      }
    }
  }
  return out.sort((a, b) => a.m - b.m).slice(0, q.max ?? 10).map(({ m: _m, ...rest }) => rest);
}

/** Charge les horaires en avance (au démarrage du serveur) : la première question n'attend pas. */
export function warmTrains(dir?: string): void {
  void trainTimes({ from: "Paris", to: "Lyon", date: new Date().toISOString().slice(0, 10) }, dir).catch(() => {});
}
