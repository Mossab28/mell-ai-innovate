import type { Db } from "./db.ts";

type Q = Pick<Db, "query">;
/**
 * Sa fiche est bornée, comme la mémoire de Hermes Agent (MEMORY.md, 2200 caractères) : quand elle est pleine, l'agent
 * regroupe ou oublie lui-même ce qui ne sert plus. Rien ne s'efface en silence (avant le 19/10, les plus anciens
 * souvenirs partaient sans qu'il le sache au-delà de 200).
 */
export const MEMORY_BUDGET = 2200;

export interface Fact {
  id: number;
  fact: string;
}

/** Caractères occupés par sa fiche, hors un souvenir qu'on remplace. */
export async function memoryUsed(db: Q, userId: string, exceptId?: number): Promise<number> {
  return Number((await db.query<{ n: number }>(`SELECT coalesce(sum(length(fact)), 0)::int AS n FROM memories WHERE user_id = $1 AND id <> $2`, [userId, exceptId ?? -1])).rows[0]?.n ?? 0);
}

const full = (used: number, adding: number) =>
  `sa fiche est pleine (${used} caractères sur ${MEMORY_BUDGET}, celui-ci en fait ${adding}) : regroupe deux souvenirs proches en un seul avec update_memory, ou oublie avec forget ce qui ne sert plus, puis réessaie`;

export async function listFacts(db: Q, userId: string, limit = 100): Promise<Fact[]> {
  return (await db.query<Fact>(`SELECT id::int, fact FROM memories WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`, [userId, limit])).rows;
}

/** Rend le souvenir retenu, ou ce qui l'empêche (fiche pleine) pour que l'agent regroupe. */
export async function remember(db: Q, userId: string, fact: string): Promise<Fact | { error: string }> {
  const clean = fact.trim().slice(0, 500);
  const dup = (await db.query<Fact>(`SELECT id::int, fact FROM memories WHERE user_id = $1 AND lower(fact) = lower($2)`, [userId, clean])).rows[0];
  if (dup) return dup;
  const used = await memoryUsed(db, userId);
  if (used + clean.length > MEMORY_BUDGET) return { error: full(used, clean.length) };
  const { rows } = await db.query<Fact>(`INSERT INTO memories (user_id, fact) VALUES ($1, $2) RETURNING id::int, fact`, [userId, clean]);
  return rows[0];
}

export async function updateFact(db: Q, userId: string, id: number, fact: string): Promise<boolean | { error: string }> {
  const clean = fact.trim().slice(0, 500);
  const used = await memoryUsed(db, userId, id);
  if (used + clean.length > MEMORY_BUDGET) return { error: full(used, clean.length) };
  const { rows } = await db.query(`UPDATE memories SET fact = $3, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId, clean]);
  return rows.length > 0;
}

export async function forget(db: Q, userId: string, id: number): Promise<boolean> {
  return (await db.query(`DELETE FROM memories WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId])).rows.length > 0;
}
