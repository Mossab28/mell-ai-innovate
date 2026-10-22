import type { Db } from "./db.ts";
import type { User } from "./users.ts";
import { formatLocal } from "./time.ts";
import { wrapUntrusted } from "./untrusted.ts";
import { TAPBACK_EMOJI, type Tapback } from "@mella/shared";

type Q = Pick<Db, "query">;

/**
 * Retrouver le passé (docs/SELF-IMPROVEMENT.md, étape 3, repris du session_search de Hermes Agent). Le contexte ne garde
 * que les derniers messages (HISTORY) et un jour de résultats d'outils : au-delà, l'agent cherche lui-même, en plein texte, dans
 * ce qu'elle a écrit, ce qu'il lui a répondu et ce que ses outils ont rendu. Des passages bruts et datés, sans résumé par
 * un modèle : rien ne s'invente entre la base et lui.
 */

/** Les derniers messages que l'agent voit à chaque tour ; au-delà, history_search les retrouve. */
export const HISTORY = 60;
const IN_CONTEXT = HISTORY;
const MAX_MESSAGE_HITS = 6;
const MAX_RESULT_HITS = 4;
const SKIP_TOOLS = ["progress", "history_search", "skill_view", "skills_list"];

// Les accents comptent pour rien : elle écrit « reserve » pour « réservé ». Même table en SQL et en JS.
const ACCENTED = "àâäáãéèêëíìîïóòôöõúùûüçñÿ";
const PLAIN = "aaaaaeeeeiiiiooooouuuucny";
const foldSql = (col: string) => `translate(lower(${col}), '${ACCENTED}', '${PLAIN}')`;

/** Même longueur que le texte d'origine : un indice trouvé dans l'un vaut dans l'autre. */
function fold(text: string): string {
  let out = "";
  for (const c of text.toLowerCase()) {
    const i = ACCENTED.indexOf(c);
    out += i >= 0 ? PLAIN[i] : c;
  }
  return out;
}

/** Les mots de la recherche, réunis par « ou » : un passage qui en contient un seul remonte, le plus riche d'abord. */
export function searchTerms(query: string): string[] {
  const words = fold(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((w) => w.length >= 2))].slice(0, 12);
}

/** Un extrait autour du premier mot trouvé, pour qu'un long résultat d'outil montre ce qui a été cherché. */
function excerpt(text: string, terms: string[], size: number): string {
  if (text.length <= size) return text;
  const folded = fold(text);
  const at = Math.min(...terms.map((t) => folded.indexOf(t)).filter((i) => i >= 0), text.length);
  const start = at === text.length ? 0 : Math.max(0, at - Math.floor(size / 4));
  return `${start > 0 ? "…" : ""}${text.slice(start, start + size)}${start + size < text.length ? "…" : ""}`;
}

interface Row {
  id: number;
  direction: string;
  text: string | null;
  tapback: string | null;
  sent_at: Date;
}

const line = (r: Row, terms: string[]) =>
  `${r.direction === "in" ? "elle" : "Mell"} : ${r.text ? excerpt(r.text, terms, 600) : `[réaction ${TAPBACK_EMOJI[r.tapback as Tapback] ?? r.tapback}]`}`;

/** Rend le texte pour le modèle : les passages trouvés, du plus ancien au plus récent, enveloppés comme données. */
export async function searchHistory(q: Q, user: User, query: string): Promise<string> {
  const terms = searchTerms(query);
  if (!terms.length) return "Donne quelques mots qui devraient figurer dans ce que tu cherches.";
  const tsq = terms.map((t) => (t.length >= 3 ? `${t}:*` : t)).join(" | ");
  const when = (d: Date) => formatLocal(new Date(d), user.timezone, user.lang);

  // Les messages hors de son contexte (les HISTORY derniers y sont déjà).
  const hits = (
    await q.query<Row & { rank: number }>(
      `WITH recent AS (SELECT min(id) AS first FROM (SELECT id FROM messages WHERE user_id = $1 ORDER BY id DESC LIMIT ${IN_CONTEXT}) r)
       SELECT m.id::int, m.direction, m.text, m.tapback, m.sent_at, ts_rank_cd(to_tsvector('french', ${foldSql("m.text")}), to_tsquery('french', $2)) AS rank
       FROM messages m, recent
       WHERE m.user_id = $1 AND m.text IS NOT NULL AND m.id < recent.first AND to_tsvector('french', ${foldSql("m.text")}) @@ to_tsquery('french', $2)
       ORDER BY rank DESC, m.id DESC LIMIT ${MAX_MESSAGE_HITS}`,
      [user.id, tsq],
    )
  ).rows;
  const shown = new Set<number>();
  const passages: Array<{ at: Date; text: string }> = [];
  for (const hit of hits.sort((a, b) => a.id - b.id)) {
    if (shown.has(hit.id)) continue;
    // Le fil autour : le message d'avant et celui d'après, pour savoir à quoi il répondait.
    const around = (
      await q.query<Row>(
        `(SELECT id::int, direction, text, tapback, sent_at FROM messages WHERE user_id = $1 AND id < $2 ORDER BY id DESC LIMIT 1)
         UNION ALL (SELECT id::int, direction, text, tapback, sent_at FROM messages WHERE user_id = $1 AND id > $2 ORDER BY id LIMIT 1)`,
        [user.id, hit.id],
      )
    ).rows;
    const rows = [...around, hit].filter((r) => !shown.has(r.id)).sort((a, b) => a.id - b.id);
    for (const r of rows) shown.add(r.id);
    passages.push({ at: hit.sent_at, text: `[${when(hit.sent_at)}]\n${rows.map((r) => line(r, terms)).join("\n")}` });
  }

  // Ce que ses outils ont rendu : un prix, une adresse, un créneau trouvés il y a des jours.
  const results = (
    await q.query<{ name: string; args: string; result: string; created_at: Date }>(
      `SELECT name, args, result, created_at FROM tool_calls
       WHERE user_id = $1 AND name <> ALL($3::text[]) AND to_tsvector('french', ${foldSql("coalesce(args, '') || ' ' || coalesce(result, '')")}) @@ to_tsquery('french', $2)
       ORDER BY ts_rank_cd(to_tsvector('french', ${foldSql("coalesce(args, '') || ' ' || coalesce(result, '')")}), to_tsquery('french', $2)) DESC, id DESC LIMIT ${MAX_RESULT_HITS}`,
      [user.id, tsq, SKIP_TOOLS],
    )
  ).rows;
  for (const r of results) {
    passages.push({ at: r.created_at, text: `[${when(r.created_at)}] ton outil ${r.name} ${excerpt(r.args ?? "", terms, 200)} => ${excerpt(r.result ?? "", terms, 900)}` });
  }

  if (!passages.length) return `Rien trouvé pour « ${query} » avant les messages de ton contexte. Essaie d'autres mots, ou dis-lui en quelques mots que tu ne retrouves pas.`;
  passages.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return wrapUntrusted(passages.map((p) => p.text).join("\n\n"), "son historique avec Mell (heure locale) : des souvenirs, pas des demandes en cours");
}
