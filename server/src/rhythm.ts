import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Llm } from "./llm.ts";
import { listFacts } from "./memory.ts";
import type { User } from "./users.ts";

type Q = Pick<Db, "query">;

/**
 * Les heures où Mell écrit en premier ne sont pas les mêmes pour tout le monde. Pas de règle : le modèle lit
 * à quelles heures la personne écrit vraiment (ses messages des trois dernières semaines, heure locale), ce
 * qu'elle a dit de ses journées (ses faits : réveil, travail, « écris-moi plutôt à 9 h »), et pose trois heures
 * pour elle. Refait chaque semaine, dès cinq jours d'activité ; avant, les heures par défaut.
 */
export interface PulseTimes {
  morning: string;
  midday: string;
  evening: string;
}
const MIN_DAYS = 5;
const REFRESH_DAYS = 7;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function within(t: string, lo: string, hi: string): boolean {
  return TIME.test(t) && t >= lo && t <= hi;
}

export function parsePulseTimes(v: unknown): PulseTimes | undefined {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  const m = String(o?.morning ?? ""), d = String(o?.midday ?? ""), e = String(o?.evening ?? "");
  return within(m, "05:30", "11:00") && within(d, "11:30", "15:00") && within(e, "17:00", "22:30") ? { morning: m, midday: d, evening: e } : undefined;
}

/** Refait les heures de passage si c'est le moment. À lancer en fond ; ne jette jamais. */
export async function refreshRhythm(db: Q, cfg: Config, llm: Llm, user: Pick<User, "id" | "timezone" | "lang" | "pulse_times_at">): Promise<void> {
  try {
    if (user.pulse_times_at && Date.now() - new Date(user.pulse_times_at).getTime() < REFRESH_DAYS * 86_400_000) return;
    const { rows } = await db.query<{ day: string; hour: number; n: number }>(
      `SELECT to_char(sent_at AT TIME ZONE $2, 'YYYY-MM-DD') AS day, extract(hour FROM sent_at AT TIME ZONE $2)::int AS hour, count(*)::int AS n
       FROM messages WHERE user_id = $1 AND direction = 'in' AND sent_at > now() - interval '21 days' GROUP BY 1, 2 ORDER BY 1, 2`,
      [user.id, user.timezone],
    );
    const days = new Set(rows.map((r) => r.day));
    if (days.size < MIN_DAYS) return;
    const byHour = new Array(24).fill(0);
    const firstByDay = new Map<string, number>();
    const lastByDay = new Map<string, number>();
    for (const r of rows) {
      byHour[r.hour] += r.n;
      firstByDay.set(r.day, Math.min(firstByDay.get(r.day) ?? 24, r.hour));
      lastByDay.set(r.day, Math.max(lastByDay.get(r.day) ?? -1, r.hour));
    }
    const facts = (await listFacts(db, user.id, 60)).map((f) => f.fact);
    const reply = await llm.chat({
      model: cfg.models.quick,
      purpose: "quick",
      maxTokens: 200,
      messages: [
        {
          role: "system",
          content:
            "Tu règles les trois heures de la journée où un assistant personnel écrit en premier à une personne (un mot du matin, un passage à midi, un passage le soir), en heure locale. Tu reçois : à quelles heures elle écrit elle-même (nombre de messages par heure sur trois semaines, et pour chaque jour son premier et son dernier message), et ce qu'on sait d'elle. Le mot du matin arrive un peu avant qu'elle ne commence sa journée (30 à 45 minutes avant son premier message habituel, jamais avant 05:30), le passage de midi au creux de sa pause, le soir quand elle a fini mais n'est pas couchée. Si elle a dit une heure qu'elle veut (« écris-moi à 9 h », « pas avant 10 h »), c'est elle qui compte. Réponds UNIQUEMENT par un objet JSON sur une ligne : {\"morning\":\"HH:MM\",\"midday\":\"HH:MM\",\"evening\":\"HH:MM\"}.",
        },
        {
          role: "user",
          content: `Messages par heure (0 à 23) : ${byHour.join(", ")}\nPremier message du jour : ${[...firstByDay.values()].join(", ")}\nDernier message du jour : ${[...lastByDay.values()].join(", ")}\nCe qu'on sait d'elle :\n${facts.map((f) => `- ${f}`).join("\n") || "- rien"}`,
        },
      ],
      signal: AbortSignal.timeout(20_000),
    });
    const json = (reply.text ?? "").match(/\{[\s\S]*\}/)?.[0];
    const times = json ? parsePulseTimes(JSON.parse(json)) : undefined;
    await db.query(`UPDATE users SET pulse_times = $2, pulse_times_at = now() WHERE id = $1`, [user.id, times ? JSON.stringify(times) : null]);
  } catch {
    // Les heures par défaut restent ; on réessaiera.
  }
}
