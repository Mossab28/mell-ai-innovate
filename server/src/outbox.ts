import { EventEmitter } from "node:events";
import type { OutboundMessage } from "@mella/shared";
import type { Db } from "./db.ts";

/** Prévient les long-polls en attente qu'une ligne a du nouveau. */
export const outboxEvents = new EventEmitter().setMaxListeners(0);

const CLAIM_SECONDS = 60;
const MAX_ATTEMPTS = 5;

export interface Enqueue {
  userId: string;
  kind: "text" | "tapback" | "delete" | "typing" | "edit" | "call" | "contact" | "image" | "card";
  text?: string;
  /** Pour kind = "card" : l'adresse de l'image (text = légende/lien), envoyés dans le même message. */
  image?: string;
  tapback?: string;
  targetGuid?: string;
  effect?: "confetti" | "loud";
  /** Rend l'envoi idempotent (ex. une occurrence de rappel). */
  dedupeKey?: string;
  /** N'envoyer qu'à partir de cette heure (brief préparé en avance). */
  notBefore?: Date;
  /** À quoi la bulle se rapporte (« reminder:<id> ») : sert quand la personne réagit dessus. */
  ref?: string;
  /** Répondre dans le fil de ce message de la personne. */
  replyTo?: string;
}

type Q = Pick<Db, "query">;

/** Ajoute des envois dans l'ordre. Le destinataire et la ligne viennent de l'utilisateur. */
export async function enqueue(db: Q, items: Enqueue[]): Promise<number> {
  let n = 0;
  const lines = new Set<string>();
  for (const it of items) {
    const { rows } = await db.query<{ id: number; line_id: string }>(
      `INSERT INTO outbox (user_id, line_id, to_handle, kind, text, tapback, target_guid, effect, dedupe_key, not_before, ref, reply_to, image_url)
       SELECT u.id, u.line_id, u.handle, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11 FROM users u WHERE u.id = $1
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id, line_id`,
      [it.userId, it.kind, it.text ?? null, it.tapback ?? null, it.targetGuid ?? null, it.effect ?? null, it.dedupeKey ?? null, it.notBefore ?? null, it.ref ?? null, it.replyTo ?? null, it.image ?? null],
    );
    if (rows[0]) {
      n++;
      lines.add(rows[0].line_id);
      if (it.kind === "text") {
        await db.query(`INSERT INTO messages (user_id, direction, text, sent_at) VALUES ($1, 'out', $2, coalesce($3, now()))`, [
          it.userId,
          it.text,
          it.notBefore ?? null,
        ]);
      }
    }
  }
  for (const l of lines) outboxEvents.emit(l);
  return n;
}

/**
 * Demande au relais d'effacer un message reçu (mot de passe, code, numéro de carte tapé dans
 * le fil) : il ne doit rester nulle part sur le Mac de la ligne. Le relais le supprime de
 * Messages par l'API privée, ou renvoie une erreur s'il ne peut pas.
 */
export function requestDeletion(db: Q, userId: string, messageGuid: string): Promise<number> {
  return enqueue(db, [{ userId, kind: "delete", targetGuid: messageGuid, dedupeKey: `delete:${messageGuid}` }]);
}

/**
 * Réclame les envois d'une ligne. Une réclamation expire au bout de 60 s : si le relais meurt
 * en plein envoi, le message repart. Au-delà de 5 tentatives, il passe en échec.
 */
export async function claim(db: Db, lineId: string, limit = 20): Promise<OutboundMessage[]> {
  await db.query(
    `UPDATE outbox SET status = 'failed', error = coalesce(error, 'trop de tentatives')
     WHERE line_id = $1 AND status = 'claimed' AND claimed_until < now() AND attempts >= $2`,
    [lineId, MAX_ATTEMPTS],
  );
  const { rows } = await db.query(
    `UPDATE outbox SET status = 'claimed', attempts = attempts + 1, claimed_until = now() + make_interval(secs => $2)
     WHERE id IN (
       SELECT id FROM outbox
       WHERE line_id = $1 AND (status = 'queued' OR (status = 'claimed' AND claimed_until < now()))
         AND (not_before IS NULL OR not_before <= now())
       ORDER BY id LIMIT $3 FOR UPDATE SKIP LOCKED)
     RETURNING id, to_handle, kind, text, tapback, target_guid, effect, reply_to, image_url`,
    [lineId, CLAIM_SECONDS, limit],
  );
  return rows
    .sort((a: any, b: any) => Number(a.id) - Number(b.id))
    .map((r: any) => ({
      id: Number(r.id),
      to: r.to_handle,
      kind: r.kind,
      text: r.text ?? undefined,
      tapback: r.tapback ?? undefined,
      targetGuid: r.target_guid ?? undefined,
      effect: r.effect ?? undefined,
      replyTo: r.reply_to ?? undefined,
      image: r.image_url ?? undefined,
    }));
}

/**
 * Attend des envois jusqu'à `waitMs` (borné à 25 s). Réveillé tout de suite par un ajout,
 * et revérifie toutes les 2 s pour les envois programmés qui arrivent à leur heure.
 */
export async function waitAndClaim(db: Db, lineId: string, waitMs: number): Promise<OutboundMessage[]> {
  const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 25_000);
  for (;;) {
    const got = await claim(db, lineId);
    const left = deadline - Date.now();
    if (got.length || left <= 0) return got;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        outboxEvents.off(lineId, done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(left, 2000));
      outboxEvents.on(lineId, done);
    });
  }
}

export async function ack(db: Db, lineId: string, results: Array<{ id: number; ok: boolean; error?: string; guid?: string }>): Promise<void> {
  for (const r of results) {
    if (r.ok) {
      const guid = typeof r.guid === "string" && r.guid.length < 100 ? r.guid : null;
      await db.query(`UPDATE outbox SET status = 'sent', sent_at = now(), error = NULL, guid = coalesce($3, guid) WHERE id = $1 AND line_id = $2`, [r.id, lineId, guid]);
    } else {
      // Échec côté relais : on remet en file, sauf si on a épuisé les tentatives.
      await db.query(
        `UPDATE outbox SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'queued' END, error = $4, claimed_until = NULL
         WHERE id = $1 AND line_id = $2`,
        [r.id, lineId, MAX_ATTEMPTS, (r.error ?? "erreur inconnue").slice(0, 500)],
      );
    }
  }
}
