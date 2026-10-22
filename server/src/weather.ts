/**
 * Météo par Open-Meteo (projet libre, sans clé ni compte). Le banc de voix a vu Mell inventer
 * « 60-70 % de pluie » faute d'outil : maintenant elle regarde, et le brief du matin aussi.
 */

const GEO = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";

/** Codes météo WMO, réduits à ce qu'on dirait dans un texto. */
const CODES: Array<[number[], string, string]> = [
  [[0], "grand soleil", "clear"],
  [[1, 2], "éclaircies", "partly sunny"],
  [[3], "couvert", "overcast"],
  [[45, 48], "brouillard", "fog"],
  [[51, 53, 55, 56, 57], "bruine", "drizzle"],
  [[61, 63, 66, 80, 81], "pluie", "rain"],
  [[65, 67, 82], "forte pluie", "heavy rain"],
  [[71, 73, 75, 77, 85, 86], "neige", "snow"],
  [[95, 96, 99], "orages", "thunderstorms"],
];

function describe(code: number, lang: string): string {
  const hit = CODES.find(([codes]) => codes.includes(code));
  return hit ? (lang === "en" ? hit[2] : hit[1]) : lang === "en" ? "mixed" : "variable";
}

export interface Place {
  name: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface DayForecast {
  date: string;
  sky: string;
  min_c: number;
  max_c: number;
  rain_mm: number;
  rain_chance: number;
  wind_kmh: number;
  /** Heures où la pluie est probable (≥ 50 %), en heure locale du lieu. */
  rain_hours?: string;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "user-agent": "Mell" } });
  if (!res.ok) throw new Error(`météo indisponible (${res.status})`);
  return res.json();
}

export async function findPlace(name: string, lang: string): Promise<Place | undefined> {
  const q = name.split(",")[0].trim();
  if (!q) return undefined;
  const j = await getJson(`${GEO}?name=${encodeURIComponent(q)}&count=1&language=${lang === "en" ? "en" : "fr"}`);
  const r = j.results?.[0];
  return r ? { name: r.name, country: r.country, latitude: r.latitude, longitude: r.longitude, timezone: r.timezone ?? "auto" } : undefined;
}

/** Prévision jour par jour, de `from` (AAAA-MM-JJ, heure du lieu) sur `days` jours, 16 au plus. */
export async function forecast(place: Place, lang: string, days = 3, from?: string): Promise<DayForecast[]> {
  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    timezone: place.timezone,
    daily: "weather_code,temperature_2m_min,temperature_2m_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max",
    hourly: "precipitation_probability",
    forecast_days: "16",
  });
  const j = await getJson(`${FORECAST}?${params}`);
  const d = j.daily;
  const out: DayForecast[] = [];
  for (let i = 0; i < (d?.time?.length ?? 0); i++) {
    if (from && d.time[i] < from) continue;
    if (out.length >= Math.max(1, Math.min(days, 16))) break;
    const hours = (j.hourly?.time ?? [])
      .map((t: string, k: number) => [t, j.hourly.precipitation_probability[k]] as const)
      .filter(([t, p]: readonly [string, number]) => t.startsWith(d.time[i]) && p >= 50)
      .map(([t]: readonly [string, number]) => Number(t.slice(11, 13)));
    out.push({
      date: d.time[i],
      sky: describe(d.weather_code[i], lang),
      min_c: Math.round(d.temperature_2m_min[i]),
      max_c: Math.round(d.temperature_2m_max[i]),
      rain_mm: Math.round(d.precipitation_sum[i] * 10) / 10,
      rain_chance: d.precipitation_probability_max[i] ?? 0,
      wind_kmh: Math.round(d.wind_speed_10m_max[i]),
      rain_hours: hours.length ? spans(hours) : undefined,
    });
  }
  return out;
}

/** [7, 8, 9, 15, 16] -> « 7h-10h, 15h-17h » */
function spans(hours: number[]): string {
  const out: string[] = [];
  let start = hours[0];
  let prev = hours[0];
  for (const h of [...hours.slice(1), -1]) {
    if (h === prev + 1) {
      prev = h;
      continue;
    }
    out.push(`${start}h-${prev + 1}h`);
    start = prev = h;
  }
  return out.join(", ");
}

/** La météo d'un lieu en une ligne de contexte, pour le brief. Ne lève jamais. */
export async function weatherLine(city: string, lang: string, date: string): Promise<string | undefined> {
  try {
    const place = await findPlace(city, lang);
    if (!place) return undefined;
    const [d] = await forecast(place, lang, 1, date);
    if (!d) return undefined;
    const rain = d.rain_hours ? `, pluie probable ${d.rain_hours}` : d.rain_chance >= 30 ? `, ${d.rain_chance} % de risque de pluie` : "";
    return `Météo du jour à ${place.name} : ${d.sky}, ${d.min_c} à ${d.max_c} °C${rain}, vent jusqu'à ${d.wind_kmh} km/h.`;
  } catch {
    return undefined;
  }
}
