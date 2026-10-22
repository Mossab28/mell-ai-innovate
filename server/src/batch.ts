import type { Db } from "./db.ts";
import type { Config } from "./config.ts";
import type { Llm } from "./llm.ts";
import type { Schedule } from "./schedules.ts";
import { enqueue } from "./outbox.ts";
import { render } from "./style.ts";
import { userContext, BRIEF_SYSTEM, PULSE_SYSTEM, REMINDER_SYSTEM } from "./prompt.ts";
import { getUser } from "./users.ts";
import { formatLocal } from "./time.ts";
import { weatherLine } from "./weather.ts";
import { wrapUntrusted } from "./untrusted.ts";
import { googleRuntime } from "./google/runtime.ts";
import { listEvents } from "./google/calendar.ts";
import { searchMail } from "./google/gmail.ts";
import { proactiveNotBefore } from "./watches.ts";

/**
 * Chemin batch : ce qui n'est pas du temps réel (brief du matin, veilles). Le travail est
 * figé dans `batch_jobs` à l'avance, traité sans urgence, et le résultat attend son heure
 * dans la file d'envoi (`not_before`). Ce découpage permet de passer plus tard à
 * l'inférence batch de Bedrock sans toucher au reste.
 */

type Q = Pick<Db, "query">;
const LEASE_SECONDS = 300;
const MAX_ATTEMPTS = 3;
/** Un brief qui n'est pas prêt deux heures après son heure ne part plus. */
const LATE_LIMIT_SECONDS = 7200;

export async function enqueueBrief(q: Q, cfg: Config, s: Schedule, deliverAt: Date, occurrence: string): Promise<void> {
  const user = await getUser(q, s.user_id);
  const payload = [
    `Consigne de l'utilisateur pour ce brief : ${s.message}`,
    // Heure locale : en UTC, le modèle lisait « 05:30 » et annonçait un brief à 5 h 30 au lieu de 7 h 30.
    `Heure d'envoi : ${formatLocal(deliverAt, user.timezone, user.lang)} (fuseau ${user.timezone}).`,
    // Le brief part avec la vraie météo de sa ville, comme ceux d'Instinct (« Rain after 5, grab an umbrella »).
    user.city ? await weatherLine(user.city, user.lang, new Intl.DateTimeFormat("en-CA", { timeZone: user.timezone }).format(deliverAt)) : undefined,
    await googleDay(q, user, new Intl.DateTimeFormat("en-CA", { timeZone: user.timezone }).format(deliverAt)),
    await inboxDay(q, user.id),
    await userContext(q, user, deliverAt),
  ].filter(Boolean).join("\n\n");
  await q.query(
    `INSERT INTO batch_jobs (user_id, kind, schedule_id, deliver_at, payload, model, dedupe_key)
     VALUES ($1, 'morning_brief', $2, $3, $4, $5, $6) ON CONFLICT (dedupe_key) DO NOTHING`,
    [s.user_id, s.id, deliverAt, payload, cfg.models.batch, `brief:${occurrence}`],
  );
}

/**
 * Un rappel ponctuel, rédigé en avance par le modèle : ce qu'il y a à rappeler (le texte écrit à la création) et ce qui
 * s'est dit depuis, pour un rappel juste (le détail connu, rien de déjà fait). Part à l'heure pile (`deliver_at`).
 */
export async function enqueueReminder(q: Q, cfg: Config, s: Schedule, deliverAt: Date, occurrence: string): Promise<void> {
  const user = await getUser(q, s.user_id);
  const since = s.created_at ? new Date(s.created_at) : new Date(deliverAt.getTime() - 86_400_000);
  const { rows } = await q.query<{ direction: string; text: string | null }>(
    `SELECT direction, text FROM (SELECT * FROM messages WHERE user_id = $1 AND sent_at > $2 AND text IS NOT NULL ORDER BY id DESC LIMIT 20) m ORDER BY id`,
    [s.user_id, since],
  );
  const thread = rows.map((r) => `${r.direction === "in" ? "Utilisateur" : "Mell"} : ${String(r.text).slice(0, 300)}`).join("\n");
  const payload = [
    `Rappel posé le ${formatLocal(since, user.timezone, user.lang)} : « ${s.message} »`,
    `Heure du rappel : ${formatLocal(deliverAt, user.timezone, user.lang)} (fuseau ${user.timezone}).`,
    thread ? `Ce qui s'est dit depuis :\n${thread}` : "Rien ne s'est dit depuis.",
    await userContext(q, user, deliverAt),
  ].join("\n\n");
  await q.query(
    `INSERT INTO batch_jobs (user_id, kind, schedule_id, deliver_at, payload, model, dedupe_key)
     VALUES ($1, 'reminder', $2, $3, $4, $5, $6) ON CONFLICT (dedupe_key) DO NOTHING`,
    [s.user_id, s.id, deliverAt, payload, cfg.models.batch, `reminder:${occurrence}`],
  );
}

/**
 * Sa journée vue de Google, figée au moment de préparer le brief : rendez-vous du jour, mails non lus
 * des dernières 24 h hors promotions. Données de tiers, donc enveloppées. Rien si Google n'est pas connecté.
 */
async function googleDay(q: Q, user: Awaited<ReturnType<typeof getUser>>, day: string): Promise<string | undefined> {
  const g = googleRuntime();
  if (!g) return undefined;
  const [gmail, calendar] = await Promise.all([g.connectionFor(q, user.id, "gmail"), g.connectionFor(q, user.id, "calendar")]);
  if (gmail?.status !== "active" && calendar?.status !== "active") return undefined;
  const parts: string[] = [];
  try {
    const events = await listEvents(g, q, user, { from: day, to: day });
    parts.push(events.length ? `Agenda du jour :\n${wrapUntrusted(JSON.stringify(events.map((e) => ({ title: e.title, start: e.start, end: e.end, location: e.location }))), "son agenda Google")}` : "Agenda du jour : rien.");
  } catch {}
  try {
    const mails = await searchMail(g, q, user, "is:unread newer_than:1d -category:promotions -category:social -category:updates", 10);
    if (mails.length) parts.push(`Mails non lus depuis hier :\n${wrapUntrusted(JSON.stringify(mails.map((m) => ({ from: m.from, subject: m.subject, snippet: m.snippet.slice(0, 160) }))), "sa boîte mail")}`);
  } catch {}
  return parts.length ? parts.join("\n\n") : undefined;
}

/** Les mails reçus sur l'adresse de Mell depuis hier (sa boîte qui fait suivre, ceux où il est en copie). */
async function inboxDay(q: Q, userId: string): Promise<string | undefined> {
  const { rows } = await q.query(
    `SELECT from_addr, from_name, subject, left(body, 160) AS snippet FROM inbox
     WHERE user_id = $1 AND kind IN ('forwarded', 'other', 'from_user') AND (kind <> 'other' OR authenticated) AND received_at > now() - interval '24 hours'
     ORDER BY id DESC LIMIT 10`,
    [userId],
  );
  if (!rows.length) return undefined;
  return `Mails reçus sur ton adresse depuis hier :\n${wrapUntrusted(JSON.stringify(rows.map((m: any) => ({ from: m.from_name || m.from_addr, subject: m.subject, snippet: m.snippet }))), "les mails reçus sur ton adresse")}`;
}

/** Ce que vaut un passage de veille, pour l'agent : un message seulement s'il change quelque chose pour elle. */
const VEILLE = `Écris-lui seulement s'il y a une chose concrète qui compte maintenant : un rendez-vous qui demande quelque chose, un mail qui attend sa réponse ou une action (jamais une newsletter), une échéance, ce que tu surveilles qui a bougé, une décision qu'elle te doit. Le matin, s'il y a au moins une chose à faire aujourd'hui ou demain : une première ligne très courte qui dit ce qui compte, puis une ligne par chose, l'info d'abord et ta proposition. À midi et le soir, seulement ce qui est nouveau depuis le dernier passage. Jamais une chose déjà dite (regarde ce que tu lui as écrit de toi-même), jamais de récap vide, de météo seule ni de rappel de ce qu'elle a programmé. Tu peux vérifier un détail avec tes outils. Dans le doute, tais-toi. Pour lui écrire, appelle send_message ; ton texte final reste pour toi et ne lui parvient pas.`;

/** Traite un lot borné de travaux batch. Rend le nombre traités. */
export async function runBatch(db: Db, cfg: Config, llm: Llm, limit = 10): Promise<number> {
  await db.query(
    `UPDATE batch_jobs SET status = 'skipped', error = 'trop tard', finished_at = now()
     WHERE status IN ('queued', 'running') AND deliver_at < now() - make_interval(secs => $1)`,
    [LATE_LIMIT_SECONDS],
  );
  await db.query(
    `UPDATE batch_jobs SET status = 'failed', finished_at = now()
     WHERE status = 'running' AND lease_until < now() AND attempts >= $1`,
    [MAX_ATTEMPTS],
  );
  let n = 0;
  for (; n < limit; n++) {
    const job = (
      await db.query(
        `UPDATE batch_jobs SET status = 'running', attempts = attempts + 1, lease_until = now() + make_interval(secs => $1)
         WHERE id = (SELECT id FROM batch_jobs
                     WHERE (status = 'queued' OR (status = 'running' AND lease_until < now())) AND attempts < $2
                       -- Brief et veille partent à l'heure, par l'agent lui-même : pas de préparation en avance.
                       AND (kind NOT IN ('pulse', 'morning_brief') OR deliver_at <= now())
                     ORDER BY deliver_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING *`,
        [LEASE_SECONDS, MAX_ATTEMPTS],
      )
    ).rows[0];
    if (!job) break;
    if (job.kind === "pulse" || job.kind === "morning_brief") {
      // Plus de rédaction à part : ce qui a été rassemblé devient un résultat d'outil (le tour suivant en voit la source, au
      // lieu de renier le brief comme le 19/10), et c'est l'agent qui décide, avec ses outils, d'écrire ou de se taire.
      try {
        const { createJob } = await import("./agent.ts");
        await db.query(`INSERT INTO tool_calls (user_id, mode, name, args, result, ms) VALUES ($1, 'task', 'veille', $2, $3, 0)`, [
          job.user_id,
          JSON.stringify({ passage: job.kind === "morning_brief" ? "brief demandé" : "veille" }),
          String(job.payload).slice(0, 8000),
        ]);
        await createJob(db, cfg, job.user_id, `${job.kind === "morning_brief" ? "[système] C'est l'heure du brief qu'elle t'a demandé." : "[système] C'est un de tes passages de veille."} Voici ce que tu as rassemblé (aussi dans le résultat « veille » de tes outils) :\n\n${job.payload}\n\n${VEILLE}`, null, { quietOk: true });
        await db.query(`UPDATE batch_jobs SET status = 'done', result = 'confié à l''agent', finished_at = now() WHERE id = $1`, [job.id]);
      } catch (err) {
        await db.query(`UPDATE batch_jobs SET status = 'queued', lease_until = NULL, error = $2 WHERE id = $1`, [job.id, String(err).slice(0, 500)]);
      }
      continue;
    }
    try {
      const reply = await llm.chat({
        model: job.model,
        purpose: "batch",
        maxTokens: 700,
        messages: [
          { role: "system", content: job.kind === "pulse" ? PULSE_SYSTEM : job.kind === "reminder" ? REMINDER_SYSTEM : BRIEF_SYSTEM },
          { role: "user", content: job.payload },
        ],
        signal: AbortSignal.timeout(120_000),
      });
      // Rien qui mérite un texto (veille, ou « moins de messages ») : on se tait.
      const { bubbles } = /^\s*\[rien\]\s*$/i.test(reply.text ?? "") ? { bubbles: [] as string[] } : render(reply.text);
      await db.tx(async (q) => {
        await enqueue(
          q,
          bubbles.map((text, i) => ({
            userId: job.user_id,
            kind: "text" as const,
            text,
            notBefore: new Date(job.deliver_at),
            dedupeKey: `batch:${job.id}:${i}`,
            // Un rappel garde sa référence : un 👍 dessus vaut « vu », la relance tombe.
            ...(job.kind === "reminder" && job.schedule_id ? { ref: `reminder:${job.schedule_id}` } : {}),
          })),
        );
        // Rappel sans objet (déjà fait, annulé) : sa relance n'a plus lieu d'être.
        if (job.kind === "reminder" && !bubbles.length) {
          await q.query(`UPDATE schedules SET status = 'cancelled' WHERE user_id = $1 AND action = 'follow_up' AND status = 'active' AND after_at = $2`, [job.user_id, job.deliver_at]);
        }
        await q.query(`UPDATE batch_jobs SET status = 'done', result = $2, finished_at = now() WHERE id = $1`, [job.id, reply.text]);
      });
    } catch (err) {
      await db.query(`UPDATE batch_jobs SET status = 'queued', lease_until = NULL, error = $2 WHERE id = $1`, [job.id, String(err).slice(0, 500)]);
    }
  }
  return n;
}
