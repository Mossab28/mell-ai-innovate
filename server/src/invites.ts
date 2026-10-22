import { randomBytes } from "node:crypto";
import type { Db } from "./db.ts";

type Q = Pick<Db, "query">;

/**
 * Invitations : le levier de lancement d'Instinct (rareté, invitations, créateurs). Chaque personne
 * a un code de 5 invitations ; un créateur reçoit un stock. Le code voyage dans le texte pré-rempli
 * du bouton (« Salut Mell ! (k7q2) ») et sert aussi d'attribution.
 */

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function newCode(len = 5): string {
  const bytes = randomBytes(len);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

/**
 * Invitations par profondeur dans l'arbre : 5 pour une personne que Moss'Ab fait entrer (ou entrée par une campagne),
 * 3 pour celles qu'elle invite, 1 au rang suivant, 0 au bout. MELLA_INVITE_QUOTAS=5,3,1,0 pour changer l'échelle.
 */
export const QUOTAS = (process.env.MELLA_INVITE_QUOTAS ?? "5,3,1,0").split(",").map((n) => Math.max(0, Number(n) || 0));
export const quotaFor = (depth: number) => QUOTAS[Math.min(Math.max(0, depth), QUOTAS.length - 1)] ?? 0;

/** Consomme une invitation du code, atomiquement. Rend qui a invité (null pour une campagne), ou undefined si le code ne fait pas entrer. */
export async function redeemInvite(q: Q, code: string | undefined): Promise<{ code: string; ownerId: string | null } | undefined> {
  if (!code) return undefined;
  const { rows } = await q.query<{ code: string; owner_id: string | null }>(
    `UPDATE invites SET uses_left = uses_left - 1, used = used + 1 WHERE code = $1 AND uses_left > 0 RETURNING code, owner_id`,
    [code.toLowerCase()],
  );
  return rows[0] ? { code: rows[0].code, ownerId: rows[0].owner_id } : undefined;
}

/** Range une personne sous celle qui l'a invitée : parrain, profondeur, code d'entrée. */
export async function attachToInviter(q: Q, userId: string, inv: { code: string; ownerId: string | null }): Promise<void> {
  await q.query(
    `UPDATE users SET attribution_code = $2, invited_by = $3,
       invite_depth = coalesce((SELECT invite_depth + 1 FROM users p WHERE p.id = $3), 0)
     WHERE id = $1 AND ($3::uuid IS NULL OR $3::uuid <> $1)`,
    [userId, inv.code, inv.ownerId],
  );
}

/** Vrai si le code fait entrer (et en consomme une place). */
export async function useInvite(q: Q, code: string | undefined): Promise<boolean> {
  return !!(await redeemInvite(q, code));
}

/**
 * Le code d'invitation d'une personne, créé à la première demande avec le quota de sa profondeur.
 * Rend undefined au bout de l'arbre (quota 0) : pas de lien à donner.
 */
export async function inviteOf(q: Q, userId: string): Promise<{ code: string; uses_left: number; used: number; quota: number } | undefined> {
  const existing = (await q.query<{ code: string; uses_left: number; used: number }>(`SELECT code, uses_left, used FROM invites WHERE owner_id = $1`, [userId])).rows[0];
  if (existing) return { ...existing, quota: existing.uses_left + existing.used };
  const depth = (await q.query<{ invite_depth: number }>(`SELECT invite_depth FROM users WHERE id = $1`, [userId])).rows[0]?.invite_depth ?? 0;
  const uses = quotaFor(depth);
  if (!uses) return undefined;
  for (;;) {
    const code = newCode();
    const { rows } = await q.query<{ code: string; uses_left: number }>(
      `INSERT INTO invites (code, owner_id, uses_left) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING code, uses_left`,
      [code, userId, uses],
    );
    if (rows[0]) return { ...rows[0], used: 0, quota: uses };
  }
}

/** Stock d'invitations pour un créateur ou une campagne. */
export async function createInvite(q: Q, p: { code?: string; uses: number; label?: string }): Promise<string> {
  const code = (p.code ?? newCode(6)).toLowerCase();
  if (!/^[a-z0-9]{4,8}$/.test(code)) throw new Error("code invalide : 4 à 8 lettres ou chiffres");
  await q.query(`INSERT INTO invites (code, label, uses_left) VALUES ($1, $2, $3) ON CONFLICT (code) DO UPDATE SET uses_left = invites.uses_left + EXCLUDED.uses_left, label = coalesce(EXCLUDED.label, invites.label)`, [
    code,
    p.label ?? null,
    Math.max(0, Math.round(p.uses)),
  ]);
  return code;
}

/** Fait entrer les `count` premières personnes de la liste. Rend leurs identifiants. */
export async function admitFromWaitlist(q: Q, count: number): Promise<string[]> {
  const { rows } = await q.query<{ id: string }>(
    `UPDATE users SET status = 'active', admitted_at = now()
     WHERE id IN (SELECT id FROM users WHERE status = 'waitlist' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id`,
    [Math.max(0, Math.round(count))],
  );
  return rows.map((r) => r.id);
}

export function waitlistBubbles(lang: string): Array<{ text: string; effect?: "confetti" }> {
  return lang === "fr"
    ? [
        { text: "Tu es sur la liste ! 🎉", effect: "confetti" },
        { text: "Les places sont comptées pour l'instant. Je t'écris ici dès que c'est ton tour." },
      ]
    : [
        { text: "You're on the list! 🎉", effect: "confetti" },
        { text: "Spots are limited for now. I'll text you right here the moment it's your turn." },
      ];
}

export function stillWaitingBubble(lang: string): string {
  return lang === "fr" ? "Toujours sur la liste, je t'écris dès que c'est ton tour." : "Still on the list, I'll text you as soon as it's your turn.";
}
