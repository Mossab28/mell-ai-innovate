import { randomInt } from "node:crypto";
import type { Db } from "../db.ts";
import type { Config } from "../config.ts";

type Q = Pick<Db, "query">;

/**
 * L'adresse mail de Mell pour une personne : son prénom et quatre signes tirés au sort
 * (`moss.k7q2@...`), comme le `2333q@mail.instinct.com` d'Instinct mais lisible. Créée au premier
 * besoin, jamais changée ; seule la partie avant @ est gardée, le domaine suit la config.
 */

// Ni 0/o, ni 1/l/i : l'adresse se recopie à la main sans erreur.
const SIGNS = "abcdefghjkmnpqrstuvwxyz23456789";

function draw(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += SIGNS[randomInt(SIGNS.length)];
  return s;
}

/** Prénom réduit à des lettres sans accent, pour la partie avant @. */
export function aliasBase(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .slice(0, 12);
}

export function mailOn(cfg: Pick<Config, "mail">): boolean {
  return cfg.mail.domains.length > 0;
}

export function addressOf(cfg: Pick<Config, "mail">, alias: string): string {
  return `${alias}@${cfg.mail.domains[0]}`;
}

/** Son adresse Mell, créée si elle n'en a pas encore. Undefined si aucun domaine n'est configuré. */
export async function ensureAddress(q: Q, cfg: Pick<Config, "mail">, user: { id: string; name: string | null; mail_alias?: string | null }): Promise<string | undefined> {
  if (!mailOn(cfg)) return undefined;
  if (user.mail_alias) return addressOf(cfg, user.mail_alias);
  const base = aliasBase(user.name);
  for (let i = 0; i < 8; i++) {
    const alias = base ? `${base}.${draw(4)}` : draw(6);
    const { rows } = await q.query<{ mail_alias: string }>(
      `UPDATE users SET mail_alias = coalesce(mail_alias, $2) WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM users WHERE mail_alias = $2)
       RETURNING mail_alias`,
      [user.id, alias],
    );
    if (rows[0]?.mail_alias) {
      user.mail_alias = rows[0].mail_alias;
      return addressOf(cfg, rows[0].mail_alias);
    }
  }
  throw new Error("adresse mail introuvable");
}

/** La personne derrière un destinataire (`moss.k7q2+resa@domaine` compris), si le domaine est le nôtre. */
export async function userForRecipient(q: Q, cfg: Pick<Config, "mail">, rcpt: string): Promise<string | undefined> {
  const m = rcpt.trim().toLowerCase().match(/^([^@\s]+)@([^@\s]+)$/);
  if (!m || !cfg.mail.domains.includes(m[2])) return undefined;
  const alias = m[1].split("+")[0];
  return (await q.query<{ id: string }>(`SELECT id FROM users WHERE mail_alias = $1`, [alias])).rows[0]?.id;
}

/** Ses adresses à elle : celle de Google connecté et celles qu'elle a confirmées dans le fil. */
export async function ownAddresses(q: Q, userId: string): Promise<string[]> {
  const { rows } = await q.query<{ address: string }>(
    `SELECT address FROM mail_addresses WHERE user_id = $1
     UNION SELECT lower(email) FROM google_connections WHERE user_id = $1 AND status = 'active' AND email IS NOT NULL
     UNION SELECT lower(login) FROM app_connections WHERE user_id = $1 AND service IN ('gmail', 'calendar') AND status = 'active' AND login IS NOT NULL`,
    [userId],
  );
  return rows.map((r) => r.address);
}

export async function addOwnAddress(q: Q, userId: string, address: string): Promise<string> {
  const a = address.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(a)) throw new Error("adresse mail invalide");
  await q.query(`INSERT INTO mail_addresses (user_id, address, source) VALUES ($1, $2, 'user') ON CONFLICT DO NOTHING`, [userId, a]);
  return a;
}
