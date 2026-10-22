import type { Db } from "./db.ts";
import { enqueue } from "./outbox.ts";

type Q = Pick<Db, "query">;

/**
 * Le « chargement » de Mell pendant un travail de fond : les trois petits points restent allumés,
 * et une seule bulle d'avancement se met à jour sur place (« ⏳ Je regarde Booking… » puis
 * « ⏳ 14 logements, je compare les prix… ») au lieu d'empiler des messages. iMessage permet
 * 5 modifications par bulle dans les 15 minutes : au-delà, une nouvelle bulle prend le relais.
 */

const MAX_EDITS = 4;
/** Un travail court n'affiche pas de bulle : les trois petits points, puis le résultat. « ✓ Terminé » ne sert qu'aux longs. */
const SHOW_AFTER_MS = 25_000;

/** Le travail de fond en cours par personne : le fil de sa demande et son début. */
const work = new Map<string, { guid: string | null; startedAt: number; token: symbol }>();
export function startWork(userId: string, guid: string | null): symbol {
  const token = Symbol();
  work.set(userId, { guid, startedAt: Date.now(), token });
  return token;
}
/** Seul celui qui a ouvert le travail le referme (un tour et un travail de fond peuvent se croiser). */
export function endWork(userId: string, token: symbol): void {
  if (work.get(userId)?.token === token) work.delete(userId);
}

interface StatusBubble {
  id: number;
  guid: string | null;
  edits: number;
  status: string;
}

async function current(q: Q, userId: string): Promise<StatusBubble | undefined> {
  return (
    await q.query<StatusBubble>(
      `SELECT id::int, guid, edits, status FROM outbox WHERE user_id = $1 AND ref = 'status' AND created_at > now() - interval '14 minutes' ORDER BY id DESC LIMIT 1`,
      [userId],
    )
  ).rows[0];
}

/**
 * La bulle d'avancement change sous ses yeux (étapes, puis le résultat) : le fil garde ce qu'elle voit. Sans ça il gardait
 * « ⏳ Looking at google.com… » à la place de la réponse, et Mell relisait un fil où il n'avait rien dit (22/10).
 */
async function retext(q: Q, userId: string, id: number, text: string, onlyQueued = false): Promise<void> {
  const old = (await q.query<{ text: string | null }>(`SELECT text FROM outbox WHERE id = $1`, [id])).rows[0]?.text;
  // Pas encore partie : seulement si la ligne ne l'a pas prise entre-temps (sinon elle part avec l'ancien texte).
  const changed = (await q.query(`UPDATE outbox SET text = $2 WHERE id = $1${onlyQueued ? " AND status = 'queued'" : ""} RETURNING id`, [id, text])).rows.length > 0;
  if (changed && old && old !== text) {
    await q.query(`UPDATE messages SET text = $3 WHERE id = (SELECT id FROM messages WHERE user_id = $1 AND direction = 'out' AND text = $2 ORDER BY id DESC LIMIT 1)`, [userId, old, text]);
  }
}

export async function progress(q: Q, userId: string, text: string): Promise<void> {
  const body = text.replace(/^[⏳✓]\s*/u, "").trim();
  const t = `⏳ ${/[.!?…:]$/.test(body) ? body : `${body}…`}`;
  const cur = await current(q, userId);
  const w = work.get(userId);
  // Pas de bulle pour un travail qui finira vite : la première ne part qu'après SHOW_AFTER_MS.
  if (!cur && w && Date.now() - w.startedAt < SHOW_AFTER_MS) return;
  if (cur?.status === "queued") {
    // Pas encore parti : on change simplement son texte.
    await retext(q, userId, cur.id, t, true);
    return;
  }
  if (cur?.guid && cur.edits < MAX_EDITS) {
    await q.query(`UPDATE outbox SET edits = edits + 1 WHERE id = $1`, [cur.id]);
    await enqueue(q, [{ userId, kind: "edit", targetGuid: cur.guid, text: t }]);
    await retext(q, userId, cur.id, t);
    return;
  }
  await enqueue(q, [{ userId, kind: "text", text: t, ref: "status", ...(w?.guid ? { replyTo: w.guid } : {}) }]);
}

/** Fin du travail : la bulle d'avancement passe à « ✓ », juste avant le résultat. */
/**
 * La bulle d'avancement devient la première bulle du résultat, comme chez Instinct (une phrase, une bulle qui s'édite,
 * puis elle se clôt sur le résultat) : un « ✓ Terminé » ajoutait une bulle de plus pour rien (face-à-face du 19/10).
 * Rend false si elle n'est pas modifiable (pas partie, pas acquittée, trop éditée) : le résultat part alors à part.
 */
export async function progressBecome(q: Q, userId: string, text: string): Promise<boolean> {
  let cur = await current(q, userId);
  if (cur?.status === "queued") {
    await q.query(`DELETE FROM outbox WHERE id = $1 AND status = 'queued'`, [cur.id]);
    return false;
  }
  for (let i = 0; cur && !cur.guid && i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    cur = await current(q, userId);
  }
  if (!cur?.guid || cur.edits > MAX_EDITS) return false;
  await q.query(`UPDATE outbox SET edits = edits + 1, ref = 'status:done' WHERE id = $1`, [cur.id]);
  await enqueue(q, [{ userId, kind: "edit", targetGuid: cur.guid, text }]);
  await retext(q, userId, cur.id, text);
  return true;
}

export async function progressDone(q: Q, userId: string, lang: string, ok = true): Promise<void> {
  let cur = await current(q, userId);
  // Pas encore partie : elle n'a plus lieu d'être, le résultat arrive.
  if (cur?.status === "queued") {
    await q.query(`DELETE FROM outbox WHERE id = $1 AND status = 'queued'`, [cur.id]);
    return;
  }
  // Partie mais pas encore acquittée par le relais : sans son identifiant, elle resterait « ⏳ … » sous le résultat.
  for (let i = 0; cur && !cur.guid && i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    cur = await current(q, userId);
  }
  if (!cur?.guid || cur.edits > MAX_EDITS) return;
  await q.query(`UPDATE outbox SET edits = edits + 1, ref = 'status:done' WHERE id = $1`, [cur.id]);
  const text = ok ? (lang === "en" ? "✓ Done" : "✓ Terminé") : lang === "en" ? "✕ Stopped" : "✕ Arrêté";
  await enqueue(q, [{ userId, kind: "edit", targetGuid: cur.guid, text }]);
  await retext(q, userId, cur.id, text);
}

/** Les trois petits points, entretenus tant que Mell travaille (iMessage les éteint seul au bout d'une minute). */
export async function keepTyping(q: Q, userId: string): Promise<void> {
  await enqueue(q, [{ userId, kind: "typing" }]);
}
