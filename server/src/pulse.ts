import type { Db } from "./db.ts";
import type { Config } from "./config.ts";
import { userContext } from "./prompt.ts";
import { getUser, type User } from "./users.ts";
import { formatLocal, zonedToUtc } from "./time.ts";
import { weatherLine } from "./weather.ts";
import { wrapUntrusted } from "./untrusted.ts";
import { googleRuntime } from "./google/runtime.ts";
import { listEvents } from "./google/calendar.ts";
import { awaitingReplies, searchMail } from "./google/gmail.ts";
import { buildHistory } from "./agent.ts";
import { parsePulseTimes } from "./rhythm.ts";

/**
 * La veille de Mell, ce qui fait qu'il écrit en premier (« the agent that texts you first ») :
 * trois passages par jour à heure locale (les heures par défaut ci-dessous, ou celles que rhythm.ts a posées
 * pour elle d'après son vrai rythme), où un modèle regarde sa semaine et décide s'il y a
 * une raison de lui écrire maintenant, ou se tait. Le code ne fait que rassembler les faits
 * et caler l'heure ; la décision et le texte sont au modèle (consigne PULSE_SYSTEM).
 */

type Q = Pick<Db, "query">;
type Slot = { name: "morning" | "midday" | "evening"; at: string; label: string };

export const PULSE_SLOTS: Slot[] = [
  { name: "morning", at: "07:45", label: "matin (son brief)" },
  { name: "midday", at: "12:30", label: "midi" },
  { name: "evening", at: "18:30", label: "soir" },
];
/** Passé ce délai après l'heure du passage, on le saute : un texto de 12 h 30 n'a plus de sens à 15 h. */
const WINDOW_MINUTES = 90;
/** Elle est en pleine conversation : le passage attend qu'elle ait fini. */
const BUSY_MINUTES = 15;
/** Une personne silencieuse depuis un mois ne reçoit plus de veille. */
const ACTIVE_DAYS = 30;

const localDay = (at: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Un passage de planification : crée les veilles dues, préparées sans urgence par le chemin batch. */
export async function planPulses(db: Db, cfg: Config, now = new Date()): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.status = 'active'
       AND EXISTS (SELECT 1 FROM messages m WHERE m.user_id = u.id AND m.direction = 'in' AND m.sent_at > now() - make_interval(days => $1))`,
    [ACTIVE_DAYS],
  );
  let planned = 0;
  for (const { id } of rows) {
    try {
      if (await planFor(db, cfg, await getUser(db, id), now)) planned++;
    } catch {
      // Une personne dont la boîte ne répond pas ne bloque pas les autres.
    }
  }
  return planned;
}

async function planFor(db: Db, cfg: Config, user: User, now: Date): Promise<boolean> {
  const today = localDay(now, user.timezone);
  const own = parsePulseTimes(user.pulse_times);
  const slots = own ? PULSE_SLOTS.map((s) => ({ ...s, at: own[s.name] })) : PULSE_SLOTS;
  // Un réveil qu'elle a demandé plus tard dans la matinée : elle dort. Le mot du matin attend qu'il soit passé.
  const wake = (
    await db.query<{ at: Date }>(
      `SELECT next_run_at AS at FROM schedules WHERE user_id = $1 AND status = 'active' AND call_mode = 'wake' AND next_run_at > $2 AND next_run_at < $3 ORDER BY next_run_at LIMIT 1`,
      [user.id, zonedToUtc(`${today}T${slots[0].at}`, user.timezone), zonedToUtc(`${today}T12:00`, user.timezone)],
    )
  ).rows[0];
  for (const slot of slots) {
    const due = slot.name === "morning" && wake ? new Date(new Date(wake.at).getTime() + 10 * 60_000) : zonedToUtc(`${today}T${slot.at}`, user.timezone);
    // Le brief du matin se prépare en avance pour partir à l'heure ; midi et soir partent quand ils sont prêts.
    const opens = slot.name === "morning" ? due.getTime() - cfg.briefPrepareMinutes * 60_000 : due.getTime();
    if (now.getTime() < opens || now.getTime() > due.getTime() + WINDOW_MINUTES * 60_000) continue;
    const key = `pulse:${user.id}:${today}:${slot.name}`;
    if ((await db.query(`SELECT 1 FROM batch_jobs WHERE dedupe_key = $1`, [key])).rows.length) continue;
    if (user.quiet_until && new Date(user.quiet_until) > due) continue;
    // Elle a déjà son brief, demandé elle-même : le passage du matin ne le double pas.
    if (slot.name === "morning" && (await db.query(`SELECT 1 FROM schedules WHERE user_id = $1 AND action = 'brief' AND status = 'active'`, [user.id])).rows.length) continue;
    if (slot.name !== "morning" && (await db.query(`SELECT 1 FROM messages WHERE user_id = $1 AND sent_at > now() - make_interval(mins => $2)`, [user.id, BUSY_MINUTES])).rows.length) continue;
    const deliverAt = slot.name === "morning" ? due : now;
    const payload = await snapshot(db, user, slot, deliverAt);
    await db.query(
      `INSERT INTO batch_jobs (user_id, kind, deliver_at, payload, model, dedupe_key) VALUES ($1, 'pulse', $2, $3, $4, $5) ON CONFLICT (dedupe_key) DO NOTHING`,
      [user.id, deliverAt, payload, cfg.models.pulse, key],
    );
    return true;
  }
  return false;
}

/** Ce que le modèle voit pour décider : sa semaine, ses mails, ce qu'on lui doit, ce qu'on s'est déjà dit. */
async function snapshot(q: Q, user: User, slot: Slot, at: Date): Promise<string> {
  const day = localDay(at, user.timezone);
  const parts: Array<string | undefined> = [`Passage du ${slot.label} : ${formatLocal(at, user.timezone, user.lang)}.`];
  if (slot.name === "morning" && user.city) parts.push(await weatherLine(user.city, user.lang, day).catch(() => undefined));
  parts.push(...(await googleWeek(q, user, day, slot)));
  parts.push(await mellInbox(q, user.id));
  parts.push(await alreadySaid(q, user));
  parts.push(await conversation(q, user.id));
  parts.push(await userContext(q, user, at));
  return parts.filter(Boolean).join("\n\n");
}

async function googleWeek(q: Q, user: User, day: string, slot: Slot): Promise<string[]> {
  const g = googleRuntime();
  if (!g) return [];
  const [gmail, calendar] = await Promise.all([g.connectionFor(q, user.id, "gmail"), g.connectionFor(q, user.id, "calendar")]);
  const out: string[] = [];
  if (calendar?.status === "active") {
    try {
      // Sept jours : assez tôt pour un anniversaire ou un cadeau, pas seulement le jour même.
      const events = await listEvents(g, q, user, { from: day, to: addDays(day, 6) });
      out.push(events.length
        ? `Son agenda, aujourd'hui et les six jours qui viennent :\n${wrapUntrusted(JSON.stringify(events.map((e) => ({ title: e.title, start: e.start, end: e.end, all_day: e.all_day || undefined, location: e.location, attendees: e.attendees?.length }))), "son agenda Google")}`
        : "Son agenda : rien cette semaine.");
    } catch {}
  }
  if (gmail?.status === "active") {
    // Le matin, depuis hier ; à midi et le soir, depuis le passage précédent.
    const since = Math.floor((Date.now() - (slot.name === "morning" ? 24 : 6) * 3_600_000) / 1000);
    try {
      const mails = await searchMail(g, q, user, `is:unread after:${since} -category:promotions -category:social`, 12);
      if (mails.length) out.push(`Mails non lus arrivés depuis le dernier passage :\n${wrapUntrusted(JSON.stringify(mails.map((m) => ({ from: m.from, subject: m.subject, date: m.date, snippet: m.snippet.slice(0, 200) }))), "sa boîte mail")}`);
    } catch {}
    // Les fils sans réponse ne bougent pas d'heure en heure : une fois par jour, au brief.
    if (slot.name === "morning") try {
      const waiting = await awaitingReplies(g, q, user);
      if (waiting.length) out.push(`Mails qu'elle a envoyés, restés sans réponse depuis plus de deux jours :\n${wrapUntrusted(JSON.stringify(waiting.map(({ to, subject, date }) => ({ to, subject, sent: date }))), "sa boîte mail")}`);
    } catch {}
  }
  return out;
}

async function mellInbox(q: Q, userId: string): Promise<string | undefined> {
  const { rows } = await q.query(
    `SELECT from_addr, from_name, subject, left(body, 200) AS snippet FROM inbox
     WHERE user_id = $1 AND kind IN ('forwarded', 'other', 'from_user') AND (kind <> 'other' OR authenticated) AND received_at > now() - interval '24 hours'
       AND coalesce(note, '') <> 'prévenue' ORDER BY id DESC LIMIT 8`,
    [userId],
  );
  if (!rows.length) return undefined;
  return `Mails reçus sur ton adresse Mell depuis hier (pas encore signalés) :\n${wrapUntrusted(JSON.stringify(rows.map((m: any) => ({ from: m.from_name || m.from_addr, subject: m.subject, snippet: m.snippet }))), "les mails reçus sur ton adresse")}`;
}

/** Ses propres messages spontanés des trois derniers jours : rien ne revient deux fois. */
async function alreadySaid(q: Q, user: User): Promise<string> {
  const { rows } = await q.query<{ result: string; deliver_at: Date }>(
    `SELECT result, deliver_at FROM batch_jobs WHERE user_id = $1 AND kind IN ('pulse', 'morning_brief') AND status = 'done'
       AND deliver_at > now() - interval '3 days' AND result IS NOT NULL AND result !~* '^\\s*\\[rien\\]\\s*$' ORDER BY deliver_at`,
    [user.id],
  );
  if (!rows.length) return "Ce que tu lui as écrit de toi-même ces trois derniers jours : rien.";
  return `Ce que tu lui as écrit de toi-même ces trois derniers jours :\n${rows.map((r) => `- ${formatLocal(new Date(r.deliver_at), user.timezone, user.lang)} : ${r.result.replace(/\s+/g, " ").slice(0, 400)}`).join("\n")}`;
}

async function conversation(q: Q, userId: string): Promise<string | undefined> {
  const history = await buildHistory(q, userId, 16);
  if (!history.length) return undefined;
  return `La conversation récente (pour ne pas répéter ce qui est déjà réglé ou en cours) :\n${history.map((m) => `${m.role === "user" ? "Elle" : "Toi"} : ${String(m.content).replace(/\s+/g, " ").slice(0, 300)}`).join("\n")}`;
}
