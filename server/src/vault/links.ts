import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db.ts";
import { normalizeSite } from "./refs.ts";
import { VaultError } from "./types.ts";

type Q = Pick<Db, "query">;

export type LinkKind = "login" | "totp" | "personal" | "card";
const LINK_MINUTES = 30;

export interface VaultLink {
  token_hash: string;
  user_id: string;
  kind: LinkKind;
  site: string | null;
  task_id: string | null;
  expires_at: Date;
  used_at: Date | null;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Lien à usage unique, valable 30 min, pour saisir un secret hors du fil.
 * Le jeton (256 bits) n'est jamais stocké en clair, seulement son haché.
 */
export async function issueLink(
  q: Q,
  publicUrl: string,
  p: { userId: string; kind: LinkKind; site?: string; taskId?: string },
): Promise<{ url: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const site = p.site ? normalizeSite(p.site) : null;
  if (site === "_pending") throw new VaultError("précise le domaine complet du compte");
  if (p.taskId) {
    const task = (await q.query(
      `SELECT id FROM tasks WHERE id = $1 AND user_id = $2
       AND status IN ('proposed', 'authorized', 'awaiting_bank')
       AND (expires_at IS NULL OR expires_at > now())`,
      [p.taskId, p.userId],
    )).rows[0];
    if (!task) throw new VaultError("cette tâche n'est plus disponible");
    if ((p.kind === "login" || p.kind === "totp") && !site) throw new VaultError("précise le domaine complet du compte");
  }
  const { rows } = await q.query<{ expires_at: Date }>(
    `INSERT INTO vault_links (token_hash, user_id, kind, site, task_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6)) RETURNING expires_at`,
    [hash(token), p.userId, p.kind, site, p.taskId ?? null, LINK_MINUTES],
  );
  return { url: `${publicUrl.replace(/\/+$/, "")}/v/${token}`, expiresAt: rows[0].expires_at };
}

/** Lien encore valable (ni utilisé, ni expiré). Ne le consomme pas : un aperçu de lien fait un GET. */
export async function peekLink(q: Q, token: string): Promise<VaultLink | undefined> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return undefined;
  return (
    await q.query<VaultLink>(`SELECT * FROM vault_links WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`, [hash(token)])
  ).rows[0];
}

/** Consomme le lien, atomiquement : deux envois simultanés, un seul passe. */
export async function consumeLink(q: Q, token: string): Promise<VaultLink | undefined> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return undefined;
  return (
    await q.query<VaultLink>(
      `UPDATE vault_links SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING *`,
      [hash(token)],
    )
  ).rows[0];
}

/** Rend le lien à nouveau utilisable si l'écriture au coffre a échoué. */
export async function releaseLink(q: Q, token: string): Promise<void> {
  await q.query(`UPDATE vault_links SET used_at = NULL WHERE token_hash = $1`, [hash(token)]);
}
