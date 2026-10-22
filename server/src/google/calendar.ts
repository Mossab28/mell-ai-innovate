import type { Db } from "../db.ts";
import type { User } from "../users.ts";
import { SCOPES } from "./oauth.ts";
import type { GoogleService } from "./service.ts";
import { nextDay, readLocal, shortDay, shortLocal } from "./time.ts";

type Q = Pick<Db, "query">;

/**
 * Google Agenda, agenda principal seulement. Les titres, lieux et descriptions viennent souvent
 * d'invitations de tiers : ce sont des données non fiables, enveloppées par les outils.
 */

interface EventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}
interface CalEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: EventTime;
  end?: EventTime;
  organizer?: { email?: string; self?: boolean };
  attendees?: Array<{ email?: string; responseStatus?: string; self?: boolean }>;
}

export interface EventSummary {
  id: string;
  title: string;
  start: string;
  end?: string;
  all_day: boolean;
  location?: string;
  organizer?: string;
  attendees?: string[];
  description?: string;
}

function when(t: EventTime | undefined, user: User): string | undefined {
  if (t?.dateTime) return shortLocal(new Date(t.dateTime), user.timezone, user.lang);
  if (t?.date) return shortDay(t.date, user.lang);
  return undefined;
}

export async function listEvents(g: GoogleService, q: Q, user: User, p: { from: string; to: string; query?: string }): Promise<EventSummary[]> {
  const from = readLocal(p.from, user.timezone).at;
  const to = readLocal(p.to, user.timezone);
  // Une date seule en fin de plage compte jusqu'au soir.
  const end = to.day ? readLocal(nextDay(to.day), user.timezone).at : to.at;
  if (end <= from) throw new Error("la fin de la plage est avant son début");
  const params = new URLSearchParams({ timeMin: from.toISOString(), timeMax: end.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "50" });
  if (p.query?.trim()) params.set("q", p.query.trim());
  const r = await g.api<{ items?: CalEvent[] }>(q, user.id, SCOPES.calendarEvents, "GET", `${g.endpoints.calendar}/calendars/primary/events?${params}`);
  return (r.items ?? [])
    .filter((e) => e.status !== "cancelled")
    .map((e) => ({
      id: e.id,
      title: e.summary ?? "(sans titre)",
      start: when(e.start, user) ?? "?",
      end: when(e.end, user),
      all_day: !!e.start?.date,
      location: e.location,
      organizer: e.organizer?.self ? undefined : e.organizer?.email,
      attendees: e.attendees?.filter((a) => !a.self).slice(0, 15).map((a) => `${a.email}${a.responseStatus ? ` (${a.responseStatus})` : ""}`),
      description: e.description ? e.description.slice(0, 300) : undefined,
    }));
}

export interface NewEvent {
  title: string;
  start: string;
  end?: string;
  location?: string;
  description?: string;
  attendees: string[];
}

/** Pose l'événement. Avec des invités, Google leur envoie l'invitation : la garde est faite avant (google/tools.ts). */
export async function createEvent(g: GoogleService, q: Q, user: User, e: NewEvent, taskId?: string): Promise<{ id: string; when: string }> {
  const tz = user.timezone;
  const s = readLocal(e.start, tz);
  let start: EventTime;
  let end: EventTime;
  if (s.day) {
    const last = e.end ? readLocal(e.end, tz).day : undefined;
    start = { date: s.day };
    // Google prend la fin d'une journée entière comme exclusive.
    end = { date: nextDay(last ?? s.day) };
  } else {
    const endAt = e.end ? readLocal(e.end, tz).at : new Date(s.at.getTime() + 60 * 60_000);
    if (endAt <= s.at) throw new Error("l'événement finit avant de commencer");
    start = { dateTime: s.at.toISOString(), timeZone: tz };
    end = { dateTime: endAt.toISOString(), timeZone: tz };
  }
  const body = {
    summary: e.title.slice(0, 300),
    ...(e.location ? { location: e.location.slice(0, 300) } : {}),
    ...(e.description ? { description: e.description.slice(0, 4000) } : {}),
    start,
    end,
    ...(e.attendees.length ? { attendees: e.attendees.map((email) => ({ email })) } : {}),
  };
  const sendUpdates = e.attendees.length ? "all" : "none";
  const r = await g.api<CalEvent>(q, user.id, SCOPES.calendarEvents, "POST", `${g.endpoints.calendar}/calendars/primary/events?sendUpdates=${sendUpdates}`, body);
  await g.journal(q, user.id, "event", r.id, taskId);
  return { id: r.id, when: (s.day ? shortDay(s.day, user.lang) : shortLocal(s.at, tz, user.lang)) ?? e.start };
}
