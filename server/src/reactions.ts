import type { Db } from "./db.ts";

type Q = Pick<Db, "query">;

/**
 * Parler à Mell par réaction, comme à Instinct : un 👍 sur « Je le prends ? » vaut oui, un 👎
 * vaut non, un ❓ demande d'expliquer, un 👍 sur un rappel dit « c'est fait ». On retrouve la
 * bulle visée grâce à son identifiant iMessage (rendu par le relais à l'envoi), et la réaction
 * devient une phrase que le reste de Mell comprend.
 */

export const isPositiveTapback = (t: string) => POSITIVE.has(t);

const POSITIVE = new Set(["like", "love", "emphasize", "👍", "👌", "🙏", "✅", "💯", "🔥", "👏", "❤️", "😍", "🥰", "🫶", "💪"]);
const NEGATIVE = new Set(["dislike", "👎", "❌", "🙅", "🙅‍♂️", "🙅‍♀️"]);
const QUESTION = new Set(["question", "❓", "🤔", "❔"]);

const EMOJI: Record<string, string> = { like: "👍", love: "❤️", emphasize: "‼️", dislike: "👎", question: "❓", laugh: "😂" };

export interface PendingReaction {
  id: number;
  tapback: string | null;
  target_guid: string | null;
}

export type ReactionMeaning =
  | { kind: "answer"; text: string }
  /** Réaction sur un rappel : la personne l'a vu, la relance n'a plus lieu d'être. */
  | { kind: "seen" }
  | { kind: "none" };

/** Le sens d'une réaction, d'après la bulle visée. Pur, testable. */
export function meaningOf(tapback: string, target: { text: string | null; ref: string | null } | undefined): ReactionMeaning {
  if (!target?.text) return { kind: "none" };
  const quote = target.text.length > 160 ? `${target.text.slice(0, 157)}...` : target.text;
  const asks = /\?\s*$/.test(target.text.trim());
  const mark = `[réaction ${EMOJI[tapback] ?? tapback} sur ton message « ${quote} »]`;
  if (POSITIVE.has(tapback)) {
    // Un pouce sur une question vaut oui. Sur une simple info, c'est « bien reçu » : rien à répondre.
    if (asks) return { kind: "answer", text: `${mark} (= oui)` };
    return target.ref?.startsWith("reminder:") ? { kind: "seen" } : { kind: "none" };
  }
  if (NEGATIVE.has(tapback)) return { kind: "answer", text: `${mark} (= ${asks ? "non" : "ça ne me va pas"})` };
  if (QUESTION.has(tapback)) return { kind: "answer", text: `${mark} (= je ne comprends pas)` };
  // Le reste (😂, 😮, 🫡, un emoji libre) : le modèle décide, souvent de ne rien dire ou de réagir en retour.
  return { kind: "answer", text: mark };
}

/**
 * Traduit les réactions en attente. Rend les phrases à ajouter au tour, et range chacune dans
 * l'historique à la place de la réaction (le modèle voit « 👍 sur « Je le prends ? » Oui. »).
 */
export async function readReactions(db: Q, userId: string, pending: PendingReaction[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const p of pending) {
    if (!p.tapback || !p.target_guid) continue;
    const target = (
      await db.query<{ text: string | null; ref: string | null }>(`SELECT text, ref FROM outbox WHERE user_id = $1 AND guid = $2 AND kind = 'text' LIMIT 1`, [userId, p.target_guid])
    ).rows[0];
    // Une carte est un lien seul : on cite son titre, pas son adresse.
    if (target?.ref?.startsWith("card:")) {
      const c = (await db.query<{ title: string; subtitle: string | null }>(`SELECT title, subtitle FROM cards WHERE id = $1 AND user_id = $2`, [target.ref.slice(5), userId])).rows[0];
      if (c) target.text = `la carte ${c.title}${c.subtitle ? ` (${c.subtitle})` : ""}`;
    }
    const m = meaningOf(p.tapback, target);
    if (m.kind !== "answer") continue;
    await db.query(`UPDATE messages SET text = $2 WHERE id = $1`, [p.id, m.text]);
    out.set(p.id, m.text);
  }
  return out;
}
