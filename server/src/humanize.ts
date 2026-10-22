import type { Config } from "./config.ts";
import type { Llm } from "./llm.ts";

/**
 * Faire parler Mell comme une personne, sans règle écrite à la main.
 *
 * Mesuré le 16/10 sur le banc de voix (40 messages, juge à l'aveugle) :
 *  - la liste des tics ci-dessous, dans les consignes : 7,4 -> 7,8 sur 10, autant de bonnes réponses. Gardée.
 *  - la note + réécriture après coup (humanize) : 7,2 -> 6,3, bonnes réponses 83 % -> 56 % (elle traduisait
 *    en français des réponses anglaises et changeait le sens). Pas branchée ; gardée ici pour d'autres essais. La liste des tics vient de deux projets libres qui la
 * maintiennent : humanizer (github.com/blader/humanizer, MIT) et anti-slop
 * (github.com/kjmagnan1s/anti-slop, MIT), adaptée au texto ; la voix visée est celle d'Instinct,
 * relevée mot à mot (infra/voice/instinct-lines.md).
 */

/** Les tics d'IA, tels que les recensent humanizer et anti-slop, ramenés à ce qui se voit dans un texto. */
export const AI_TELLS = `Ce qui trahit une IA dans un texto (d'après les projets libres humanizer et anti-slop) :
- Mettre en scène au lieu de dire : amorce (« Bonne question », « Alors, voici », « Pour faire simple »), « ce n'est pas X, c'est Y », chute dramatique ou maxime, objection que personne n'a soulevée.
- Le rythme mécanique : trois éléments par réflexe, phrases qui commencent pareil, qualificatifs empilés, tirets et parenthèses partout.
- Le gonflement : vocabulaire d'IA (« crucial », « essentiel », « n'hésite pas », « je suis là pour », « parfait ! », « absolument »), importance exagérée, ton commercial.
- Les restes de chatbot : politesses d'assistant, « en tant qu'assistant », avertissements sur ce qu'on ne peut pas faire alors qu'on n'a rien demandé, « autre chose ? ».
- Écrire pour le mauvais lecteur : réexpliquer ce qu'elle sait déjà, reformuler sa demande, récapituler ce qu'on vient de faire, détailler ce qu'elle n'a pas demandé.
- La mise en forme d'IA : gras, titres, listes pour deux idées, emojis décoratifs.
Ce qui sonne humain : le fait d'abord, des phrases courtes et inégales, les mots qu'on emploie à l'oral, une seule question quand une décision attend, et s'arrêter quand c'est dit.`;

const HUMAN = {
  type: "score",
  name: "human",
  instructions:
    "Cette réponse ressemble-t-elle à un texto écrit par un assistant humain compétent (direct, le fait d'abord, sans formule) ou à une réponse de chatbot ? Juge le ton et la forme, pas l'exactitude.",
  levels: [
    { label: "Chatbot", description: "Formules d'assistant, amorce ou récapitulatif, ton commercial ou trop poli, explications que personne n'a demandées, mise en forme de document." },
    { label: "Correct", description: "Utile et assez naturel, mais une ou deux tournures d'IA ou un peu trop long." },
    { label: "Humain", description: "On croirait le texto d'une personne : direct, dense, naturel, rien de trop." },
  ],
};

/** Note de 0 (chatbot) à 2 (humain), ou undefined si le modèle de décision ne répond pas. */
export async function humanScore(cfg: Pick<Config, "decisions">, userText: string, reply: string): Promise<number | undefined> {
  const d = cfg.decisions;
  if (!d.key) return undefined;
  try {
    const res = await fetch(`${d.base.replace(/\/+$/, "")}/decisions`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: d.model, input: `Message de la personne :\n${userText}\n\nRéponse de l'assistant :\n${reply}`, questions: [HUMAN] }),
      signal: AbortSignal.timeout(d.timeoutMs),
    });
    if (!res.ok) return undefined;
    const j: any = await res.json();
    const s = Number(j.answers?.find((a: any) => a.name === "human")?.score);
    return Number.isFinite(s) ? s : undefined;
  } catch {
    return undefined;
  }
}

const REWRITE = `${AI_TELLS}

Tu réécris la réponse d'un assistant personnel par texto pour qu'elle sonne comme une personne qui écrit à quelqu'un qu'elle connaît. Règles :
- Garde exactement les faits, chiffres, heures, noms, liens et adresses. N'ajoute rien, n'invente rien.
- Garde tels quels les repères [react:...], [effet:...] et [rien], à leur place.
- Garde la langue de la réponse. Garde la séparation en bulles (ligne vide entre deux bulles), deux bulles au plus.
- Plus court si possible, jamais plus long. Une seule question, à la fin, seulement si une décision attend.
- Jamais de tiret long, jamais de markdown.
Réponds uniquement par la réponse réécrite.`;

/** Réécrit une réponse qui sonne IA. Rend la réponse d'origine si la réécriture échoue. */
export async function rewriteHuman(cfg: Pick<Config, "models">, llm: Llm, userText: string, reply: string): Promise<string> {
  try {
    const r = await llm.chat({
      model: cfg.models.quick,
      purpose: "humanize",
      maxTokens: 500,
      messages: [
        { role: "system", content: REWRITE },
        { role: "user", content: `Message de la personne :\n${userText}\n\nRéponse à réécrire :\n${reply}` },
      ],
      signal: AbortSignal.timeout(20_000),
    });
    const out = r.text?.trim();
    return out ? out : reply;
  } catch {
    return reply;
  }
}

/** Le passage complet : note, et réécriture seulement si la réponse sonne chatbot. */
export async function humanize(cfg: Pick<Config, "decisions" | "models">, llm: Llm, userText: string, reply: string | null): Promise<string | null> {
  if (!reply?.trim() || /^\s*\[(react:[^\]]+|rien)\]\s*$/i.test(reply)) return reply;
  const score = await humanScore(cfg, userText, reply);
  if (score === undefined || score >= 1.3) return reply;
  return rewriteHuman(cfg, llm, userText, reply);
}
