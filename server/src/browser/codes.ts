import type { Db } from "../db.ts";
import { enqueue } from "../outbox.ts";

type Q = Pick<Db, "query">;

/**
 * Codes de vérification demandés dans le fil (SMS, mail, appli), comme Instinct : la tâche
 * pose la question, garde le navigateur ouvert, et la réponse de la personne lui est routée
 * au lieu de partir au routeur. Le code ne reste pas dans l'historique.
 */

export const CODE_WAIT_MS = 5 * 60_000;
const CODE = /^\s*(?:code\s*[:=]?\s*)?([A-Za-z0-9]{4,8}|\d{3}[\s-]\d{3})\s*[.!]?\s*$/i;

/** Le texte ressemble-t-il à un code seul (« 645046 », « 123 456 », « code: A7K2Q9 ») ? */
export function extractCode(text: string | null | undefined): string | undefined {
  const m = CODE.exec(text ?? "");
  if (!m) return undefined;
  const code = m[1].replace(/[\s-]/g, "");
  // Un mot ordinaire de 4 à 8 lettres n'est pas un code : il en faut au moins un chiffre.
  return /\d/.test(code) ? code : undefined;
}

/** Pose la question dans le fil et attend la réponse, au plus `waitMs`. Rend le code, ou rien. */
export async function askCode(
  q: Q,
  p: { userId: string; taskId?: string; question: string; waitMs?: number; pollMs?: number; signal?: AbortSignal },
): Promise<string | undefined> {
  const waitMs = p.waitMs ?? CODE_WAIT_MS;
  const { rows } = await q.query<{ id: number }>(
    `INSERT INTO browser_waits (user_id, task_id, question, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING id`,
    [p.userId, p.taskId ?? null, p.question.slice(0, 500), waitMs / 1000],
  );
  const id = rows[0].id;
  await enqueue(q, [{ userId: p.userId, kind: "text", text: p.question }]);
  const until = Date.now() + waitMs;
  while (Date.now() < until && !p.signal?.aborted) {
    await new Promise((r) => setTimeout(r, p.pollMs ?? 1000));
    const r = (await q.query<{ answer: string | null }>(`SELECT answer FROM browser_waits WHERE id = $1`, [id])).rows[0];
    if (r?.answer) {
      // Consommé : le code ne reste pas en base.
      await q.query(`UPDATE browser_waits SET answer = NULL WHERE id = $1`, [id]);
      return r.answer;
    }
  }
  await q.query(`UPDATE browser_waits SET answered_at = coalesce(answered_at, now()), expires_at = least(expires_at, now()) WHERE id = $1`, [id]);
  return undefined;
}

/**
 * Appelé sur le tour de la personne, avant le routeur : si une tâche attend un code et que le
 * message en est un, il part à la tâche, le message est expurgé, et le tour s'arrête là.
 */
export async function takeCodeReply(q: Q, userId: string, messages: Array<{ id: number; text: string | null }>): Promise<boolean> {
  const texts = messages.filter((m) => m.text?.trim());
  if (texts.length !== 1) return false;
  const code = extractCode(texts[0].text);
  if (!code) return false;
  const { rows } = await q.query<{ id: number }>(
    `UPDATE browser_waits SET answer = $2, answered_at = now()
     WHERE id = (SELECT id FROM browser_waits WHERE user_id = $1 AND answered_at IS NULL AND expires_at > now() ORDER BY id DESC LIMIT 1)
     RETURNING id`,
    [userId, code],
  );
  if (!rows.length) return false;
  await q.query(`UPDATE messages SET text = $2 WHERE id = $1`, [texts[0].id, "[code transmis à la tâche en cours]"]);
  return true;
}
