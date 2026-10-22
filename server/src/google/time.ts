import { zonedToUtc } from "../time.ts";

/** Date courte dans le fuseau de la personne : « jeu. 16 oct., 09:30 ». */
export function shortLocal(at: Date, tz: string, lang = "fr"): string {
  return new Intl.DateTimeFormat(lang === "en" ? "en-US" : "fr-FR", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}

/** Jour seul (événement sur la journée) : « jeu. 16 oct. ». La date est déjà celle du calendrier. */
export function shortDay(date: string, lang = "fr"): string {
  return new Intl.DateTimeFormat(lang === "en" ? "en-US" : "fr-FR", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** AAAA-MM-JJ (journée entière) ou AAAA-MM-JJTHH:MM, lu dans le fuseau de la personne. */
export function readLocal(s: string, tz: string): { day?: string; at: Date } {
  const v = s.trim();
  if (DAY.test(v)) return { day: v, at: zonedToUtc(`${v}T00:00`, tz) };
  return { at: zonedToUtc(v, tz) };
}

export function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
