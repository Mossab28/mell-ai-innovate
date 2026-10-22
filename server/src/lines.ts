import type { Db } from "./db.ts";

export interface Line {
  id: string;
  handle: string;
  secret: string;
  active: boolean;
  max_users: number;
}

/** Crée ou met à jour les lignes décrites par `id|handle|secret;...`. */
export async function seedLines(db: Db, spec: string | undefined): Promise<void> {
  for (const chunk of (spec ?? "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const [id, handle, secret] = chunk.split("|");
    if (!id || !handle || !secret) throw new Error(`ligne mal décrite : ${chunk}`);
    await upsertLine(db, { id, handle, secret });
  }
}

export async function upsertLine(db: Db, l: { id: string; handle: string; secret: string; maxUsers?: number }): Promise<void> {
  await db.query(
    `INSERT INTO lines (id, handle, secret, max_users) VALUES ($1, $2, $3, coalesce($4, 500))
     ON CONFLICT (id) DO UPDATE SET handle = excluded.handle, secret = excluded.secret, max_users = coalesce($4, lines.max_users)`,
    [l.id, l.handle, l.secret, l.maxUsers ?? null],
  );
}

export async function getLine(db: Db, id: string): Promise<Line | undefined> {
  return (await db.query<Line>(`SELECT * FROM lines WHERE id = $1`, [id])).rows[0];
}

/**
 * Ligne la moins chargée parmi celles qui ont encore de la place. C'est la page d'accueil
 * qui l'appelle pour choisir à quel numéro le bouton « Écris à Mell » envoie.
 */
export async function pickLine(db: Db): Promise<Line | undefined> {
  const { rows } = await db.query<Line & { users: number }>(
    `SELECT l.*, count(u.id)::int AS users FROM lines l LEFT JOIN users u ON u.line_id = l.id
     WHERE l.active GROUP BY l.id HAVING count(u.id) < l.max_users
     ORDER BY count(u.id)::float / l.max_users, l.id LIMIT 1`,
  );
  return rows[0];
}

export async function touchLine(db: Db, id: string): Promise<void> {
  await db.query(`UPDATE lines SET last_seen_at = now() WHERE id = $1`, [id]);
}
