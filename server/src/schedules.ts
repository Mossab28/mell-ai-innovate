import type { Db } from "./db.ts";
import { enqueue } from "./outbox.ts";
import { formatLocal, nextCron } from "./time.ts";
import type { Config } from "./config.ts";
import { enqueueBrief, enqueueReminder } from "./batch.ts";

type Q = Pick<Db, "query">;

export interface Schedule {
  id: string;
  user_id: string;
  kind: "once" | "recurring";
  action: "send_text" | "brief" | "follow_up" | "check_back";
  cron: string | null;
  timezone: string;
  message: string;
  next_run_at: Date;
  created_at?: Date;
  missed_policy: "send_late" | "skip";
  grace_seconds: number;
  status: string;
  follow_up_message?: string | null;
  follow_up_minutes?: number | null;
  after_at?: Date | null;
  /** wake : appel à l'heure dite ; if_no_answer : appel si elle ne réagit pas au texto (migration 014). */
  call_mode?: "wake" | "if_no_answer" | null;
}

/** Délai avant l'appel quand elle n'a pas réagi au rappel : court, c'est un rappel qui ne doit pas être raté. */
const CALL_AFTER_MINUTES = 5;

export async function createOnce(
  db: Q,
  userId: string,
  at: Date,
  message: string,
  tz: string,
  followUp?: { message: string; minutes: number },
  call?: "wake" | "if_no_answer",
): Promise<Schedule> {
  const minutes = followUp ? Math.min(24 * 60, Math.max(call ? 2 : 10, Math.round(followUp.minutes))) : null;
  const { rows } = await db.query<Schedule>(
    `INSERT INTO schedules (user_id, kind, timezone, message, next_run_at, missed_policy, follow_up_message, follow_up_minutes, call_mode)
     VALUES ($1, 'once', $2, $3, $4, 'send_late', $5, $6, $7) RETURNING *`,
    [userId, tz, message.slice(0, 1000), at, followUp?.message.slice(0, 500) ?? null, minutes, call ?? null],
  );
  return rows[0];
}

export async function createRecurring(
  db: Q,
  userId: string,
  p: { cron: string; tz: string; message: string; action?: "send_text" | "brief" },
): Promise<Schedule> {
  const next = nextCron(p.cron, p.tz, new Date()); // lève si l'expression est fausse
  const { rows } = await db.query<Schedule>(
    `INSERT INTO schedules (user_id, kind, action, cron, timezone, message, next_run_at, missed_policy)
     VALUES ($1, 'recurring', $2, $3, $4, $5, $6, 'skip') RETURNING *`,
    [userId, p.action ?? "send_text", p.cron, p.tz, p.message.slice(0, 1000), next],
  );
  return rows[0];
}

const MAX_CHECK_BACKS = 5;
/** Un retour en retard de plus d'un quart d'heure ne part plus : « le prix tombe à 23 h 53 » ne vaut plus rien à minuit. */
const CHECK_BACK_GRACE_SECONDS = 900;

/**
 * Un retour que Mell se fixe de lui-même (un prix qui tient jusqu'à 23 h 53, un panier qui expire, une réponse qu'elle
 * doit donner). Rien n'est écrit d'avance : à l'heure dite, un travail de fond relit le fil et décide, un mot ou rien.
 */
export async function createCheckBack(db: Q, userId: string, at: Date, why: string, tz: string): Promise<Schedule> {
  // Un seul retour par échéance : un retour déjà prévu à moins de 45 minutes est déplacé et réécrit, pas doublé
  // (le 19/10, trois retours pour le même panier, plus un rappel, à quelques minutes d'écart).
  const near = (
    await db.query<Schedule>(
      `UPDATE schedules SET next_run_at = $3, message = $4
       WHERE id = (SELECT id FROM schedules WHERE user_id = $1 AND action = 'check_back' AND status = 'active'
                   AND abs(extract(epoch FROM next_run_at - $2::timestamptz)) < 2700 ORDER BY next_run_at LIMIT 1)
       RETURNING *`,
      [userId, at, at, why.slice(0, 1000)],
    )
  ).rows[0];
  if (near) return near;
  const active = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM schedules WHERE user_id = $1 AND action = 'check_back' AND status = 'active'`, [userId])).rows[0].n;
  if (active >= MAX_CHECK_BACKS) throw new Error(`déjà ${MAX_CHECK_BACKS} retours prévus : annule celui qui ne sert plus (cancel_schedule)`);
  const { rows } = await db.query<Schedule>(
    `INSERT INTO schedules (user_id, kind, action, timezone, message, next_run_at, missed_policy, grace_seconds)
     VALUES ($1, 'once', 'check_back', $2, $3, $4, 'skip', $5) RETURNING *`,
    [userId, tz, why.slice(0, 1000), at, CHECK_BACK_GRACE_SECONDS],
  );
  return rows[0];
}

export async function listActive(db: Q, userId: string): Promise<Schedule[]> {
  return (await db.query<Schedule>(`SELECT * FROM schedules WHERE user_id = $1 AND status = 'active' ORDER BY next_run_at LIMIT 30`, [userId])).rows;
}

export async function cancelSchedule(db: Q, userId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  return (await db.query(`UPDATE schedules SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING id`, [id, userId])).rows.length > 0;
}

/**
 * Un passage de l'ordonnanceur. Rappels : le texte est déjà écrit, on le met en file à l'heure.
 * Briefs : préparés en avance par le chemin batch, puis envoyés à l'heure pile.
 * Rattrapage après coupure : un rappel ponctuel part en retard (signalé), une routine trop
 * ancienne est sautée. Chaque passage traite un lot borné : la boucle a toujours une fin.
 */
export async function runDue(db: Db, cfg: Config, now = new Date(), limit = 100): Promise<number> {
  const prepareMs = cfg.briefPrepareMinutes * 60_000;
  const reminderPrepareMs = cfg.reminderPrepareMinutes * 60_000;
  let handled = 0;
  for (let i = 0; i < limit; i++) {
    const done = await db.tx(async (q) => {
      // Un brief et un rappel ponctuel (texto, sans appel) sont pris en avance : rédigés par le modèle, envoyés à l'heure pile.
      const { rows } = await q.query<Schedule>(
        `SELECT * FROM schedules
         WHERE status = 'active' AND next_run_at <= $1::timestamptz + CASE
           WHEN action = 'brief' THEN make_interval(secs => $2)
           WHEN action = 'send_text' AND kind = 'once' AND call_mode IS NULL THEN make_interval(secs => $3)
           ELSE interval '0' END
         ORDER BY next_run_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [now, prepareMs / 1000, reminderPrepareMs / 1000],
      );
      const s = rows[0];
      if (!s) return false;
      const due = new Date(s.next_run_at);
      const lateMs = now.getTime() - due.getTime();
      const stale = lateMs > s.grace_seconds * 1000;
      const occurrence = `${s.id}:${due.toISOString()}`;

      // « Pas avant lundi » : les briefs de la période sautent, ses rappels à elle partent quand même.
      const quiet = (await q.query<{ quiet_until: Date | null }>(`SELECT quiet_until FROM users WHERE id = $1`, [s.user_id])).rows[0]?.quiet_until;
      const silenced = !!quiet && new Date(quiet) > due;
      if (s.action === "brief") {
        if (!(stale && s.missed_policy === "skip") && !silenced) await enqueueBrief(q, cfg, s, due, occurrence);
      } else if (s.action === "check_back") {
        // Retour que Mell s'était fixé : un travail de fond, avec ses outils, relit le fil et décide. S'il y en a déjà un
        // en cours pour elle, l'avis lui est remis.
        if (!stale && !silenced) {
          const { createJob } = await import("./agent.ts");
          await createJob(
            q,
            cfg,
            s.user_id,
            `[système] C'est le moment que tu t'étais fixé (${formatLocal(due, s.timezone, "fr")}) pour revenir vers elle de toi-même : « ${s.message} ». Relis le fil. Si c'est toujours en suspens et que ça compte encore pour elle, écris-lui maintenant ce qui l'aide. Si c'est réglé, dépassé, ou qu'elle a déjà répondu, ne dis rien. Pour lui écrire, appelle send_message ; ton texte final reste pour toi et ne lui parvient pas.`,
            null,
            { quietOk: true },
          );
        }
      } else if (s.action === "follow_up") {
        // La relance ne part que si elle n'a ni réagi ni écrit depuis le rappel.
        const answered = (await q.query(`SELECT 1 FROM messages WHERE user_id = $1 AND direction = 'in' AND sent_at > $2 LIMIT 1`, [s.user_id, s.after_at ?? due])).rows.length > 0;
        // Relance d'un rappel « ne doit pas être raté » : un appel plutôt qu'un texto de plus.
        if (!answered && s.call_mode) await enqueue(q, [{ userId: s.user_id, kind: "call", text: s.message, dedupeKey: `call:${occurrence}`, ref: `followup:${s.id}` }]);
        else if (!answered && !silenced) await enqueue(q, [{ userId: s.user_id, kind: "text", text: s.message, dedupeKey: `sched:${occurrence}`, ref: `followup:${s.id}` }]);
      } else if (!(stale && s.missed_policy === "skip")) {
        // Rappel ponctuel pris en avance : le modèle le rédige avec ce qui s'est dit depuis, et il part à l'heure. Trop juste
        // (moins d'une minute) ou en retard : le texte écrit à la création part tel quel, il est toujours là.
        const prepared = s.kind === "once" && !s.call_mode && due.getTime() - now.getTime() >= 60_000;
        if (prepared) await enqueueReminder(q, cfg, s, due, occurrence);
        else {
          const text = stale ? `(En retard, désolé) ${s.message}` : s.message;
          await enqueue(q, [{ userId: s.user_id, kind: "text", text, dedupeKey: `sched:${occurrence}`, ref: `reminder:${s.id}` }]);
        }
        // Réveil : l'appel part à l'heure, avec le texto. Un réveil trop en retard n'appelle plus.
        if (s.call_mode === "wake" && !stale) await enqueue(q, [{ userId: s.user_id, kind: "call", text: s.message, dedupeKey: `call:${occurrence}`, ref: `reminder:${s.id}` }]);
        const followText = s.follow_up_message ?? (s.call_mode === "if_no_answer" ? s.message : null);
        if (s.kind === "once" && followText) {
          await q.query(
            `INSERT INTO schedules (user_id, kind, action, timezone, message, next_run_at, missed_policy, after_at, call_mode)
             VALUES ($1, 'once', 'follow_up', $2, $3, $4::timestamptz + make_interval(mins => $5), 'skip', $4, $6)`,
            [
              s.user_id,
              s.timezone,
              followText,
              // Après l'heure du rappel (pas celle de sa préparation) : une réponse entre les deux compte.
              new Date(Math.max(now.getTime(), due.getTime())),
              s.follow_up_minutes ?? (s.call_mode === "if_no_answer" ? CALL_AFTER_MINUTES : 60),
              s.call_mode === "if_no_answer" ? "if_no_answer" : null,
            ],
          );
        }
      }

      if (s.kind === "once") {
        await q.query(`UPDATE schedules SET status = 'done', last_run_at = $2 WHERE id = $1`, [s.id, now]);
      } else {
        // Prochaine occurrence après maintenant : pas de rafale de rattrapage après une longue coupure.
        const after = new Date(Math.max(now.getTime(), due.getTime()));
        const next = nextCron(s.cron!, s.timezone, after);
        await q.query(`UPDATE schedules SET next_run_at = $2, last_run_at = $3 WHERE id = $1`, [s.id, next, now]);
      }
      return true;
    });
    if (!done) break;
    handled++;
  }
  return handled;
}
