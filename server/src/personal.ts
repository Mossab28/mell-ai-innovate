import type { Db } from "./db.ts";

type Q = Pick<Db, "query">;

/**
 * Ses infos perso : une mémoire lisible par le modèle (pas des secrets). Mell les retient dès qu'elle les donne et
 * s'en sert pour remplir les formulaires (réservation, livraison). Mots de passe et cartes restent au coffre.
 */
/** discounts : ses cartes de réduction, abonnements et cartes de fidélité, appliqués sur tout site où ils valent. */
export const PERSONAL_INFO_FIELDS = ["full_name", "email", "phone", "address", "birthdate", "discounts"] as const;
export type PersonalField = (typeof PERSONAL_INFO_FIELDS)[number];

const LABELS: Record<PersonalField, { fr: string; en: string }> = {
  full_name: { fr: "nom complet", en: "full name" },
  email: { fr: "e-mail", en: "email" },
  phone: { fr: "téléphone", en: "phone" },
  address: { fr: "adresse", en: "address" },
  birthdate: { fr: "date de naissance", en: "date of birth" },
  discounts: { fr: "cartes de réduction", en: "discount cards" },
};
export const personalLabel = (f: PersonalField, lang: string) => LABELS[f][lang === "en" ? "en" : "fr"];

export async function getPersonal(db: Q, userId: string): Promise<Partial<Record<PersonalField, string>>> {
  const rows = (await db.query<{ field: PersonalField; value: string }>(`SELECT field, value FROM personal_info WHERE user_id = $1`, [userId])).rows;
  return Object.fromEntries(rows.map((r) => [r.field, r.value]));
}

/** Pose ou efface des champs (null ou vide = effacer). Rend les champs touchés. */
export async function setPersonal(db: Q, userId: string, values: Partial<Record<string, unknown>>): Promise<string[]> {
  const touched: string[] = [];
  for (const f of PERSONAL_INFO_FIELDS) {
    if (!(f in values)) continue;
    const v = values[f];
    if (v === null || v === undefined || String(v).trim() === "") {
      await db.query(`DELETE FROM personal_info WHERE user_id = $1 AND field = $2`, [userId, f]);
    } else {
      await db.query(
        `INSERT INTO personal_info (user_id, field, value) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, field) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [userId, f, String(v).trim().slice(0, 300)],
      );
    }
    touched.push(f);
  }
  return touched;
}

/** Une ligne de contexte pour le modèle (et pour le navigateur). */
/**
 * Ses infos perso pour agir : celles qu'elle a données, plus le numéro d'où elle écrit à Mell quand elle n'en a pas donné
 * d'autre (au banc du 19/10, Mell lui redemandait son téléphone pour un formulaire alors qu'il lui écrivait dessus).
 */
export async function personalFor(db: Q, user: { id: string; handle: string }, o: { forModel?: boolean } = {}): Promise<Partial<Record<PersonalField, string>>> {
  const p = await getPersonal(db, user.id);
  // Pour le navigateur, le numéro seul : il est tapé tel quel dans le formulaire.
  if (!p.phone && /^\+\d{8,15}$/.test(user.handle)) p.phone = o.forModel ? `${user.handle} (le numéro d'où elle t'écrit)` : user.handle;
  return p;
}

export function personalLine(p: Partial<Record<PersonalField, string>>): string {
  const parts = PERSONAL_INFO_FIELDS.filter((f) => p[f]).map((f) => `${f} = ${p[f]}`);
  return parts.length ? parts.join(" ; ") : "";
}
