import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Llm } from "./llm.ts";
import type { User } from "./users.ts";

type Q = Pick<Db, "query">;

/**
 * Mell parle de plus en plus comme la personne en face. Pas de règles : le modèle lit ses derniers
 * messages et écrit une note courte (tutoiement, longueur, ponctuation, emojis, mots à elle, humeur),
 * et comment s'en rapprocher sans la singer. La note est relue à chaque tour et refaite tous les
 * REFRESH_EVERY messages reçus, à partir de MIN_MESSAGES.
 */
const MIN_MESSAGES = 5;
const REFRESH_EVERY = 12;
const SAMPLE = 40;

/** La ligne du contexte : comment elle écrit, et comment t'en rapprocher. */
export function voiceContext(user: Pick<User, "voice_note">): string | undefined {
  return user.voice_note ? `Comment elle écrit, et comment t'en rapprocher (sans la singer, sans perdre ta netteté) :\n${user.voice_note}` : undefined;
}

/** Refait la note si assez de nouveaux messages sont arrivés. À lancer en fond ; ne jette jamais. */
export async function refreshVoiceNote(db: Q, cfg: Config, llm: Llm, user: Pick<User, "id" | "voice_note" | "voice_note_msgs">): Promise<void> {
  try {
    const count = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE user_id = $1 AND direction = 'in' AND text IS NOT NULL AND tapback IS NULL`, [user.id])).rows[0].n;
    if (count < MIN_MESSAGES || (user.voice_note && count - user.voice_note_msgs < REFRESH_EVERY)) return;
    const sample = (
      await db.query<{ text: string }>(
        `SELECT text FROM (SELECT text, id FROM messages WHERE user_id = $1 AND direction = 'in' AND text IS NOT NULL AND tapback IS NULL ORDER BY id DESC LIMIT $2) s ORDER BY id`,
        [user.id, SAMPLE],
      )
    ).rows.map((r) => r.text.trim()).filter((t) => t && !t.startsWith("[") && t.length < 600);
    if (sample.length < MIN_MESSAGES) return;
    const reply = await llm.chat({
      model: cfg.models.quick,
      purpose: "quick",
      maxTokens: 300,
      messages: [
        {
          role: "system",
          content:
            "Tu lis des textos qu'une personne envoie à son assistant. Décris en 3 à 5 lignes courtes comment elle écrit : tutoiement ou vouvoiement, longueur des messages, ponctuation et majuscules, emojis (lesquels), argot et mots à elle, mélange de langues, humeur générale. Termine par une ligne « S'en rapprocher : ... » qui dit, concrètement, ce que l'assistant peut reprendre d'elle (ses mots, sa longueur, ses emojis) tout en restant net et sûr de lui. Pas de jugement sur la personne, pas de conseil, pas de markdown.",
        },
        { role: "user", content: sample.map((t) => `- ${t}`).join("\n") },
      ],
      signal: AbortSignal.timeout(20_000),
    });
    const note = (reply.text ?? "").trim().slice(0, 900);
    if (!note) return;
    await db.query(`UPDATE users SET voice_note = $2, voice_note_msgs = $3 WHERE id = $1`, [user.id, note, count]);
  } catch {
    // La voix se refera au tour suivant.
  }
}
