import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { Db } from "../db.ts";
import type { StorageState } from "./types.ts";

type Q = Pick<Db, "query">;

/**
 * Profils web chiffrés : AES-256-GCM, une clé par personne dérivée (HKDF) de la clé maîtresse
 * MELLA_BROWSER_KEY, l'identifiant de la personne en données authentifiées. Une ligne copiée
 * d'une personne à l'autre ne se déchiffre pas. Sans clé maîtresse, une clé de processus est
 * tirée au démarrage : les sessions survivent à la tâche, pas au redémarrage.
 */
export class ProfileStore {
  private readonly master: Buffer;
  readonly ephemeral: boolean;

  constructor(masterKeyB64?: string) {
    const k = masterKeyB64 ? Buffer.from(masterKeyB64, "base64") : undefined;
    if (k && k.length !== 32) throw new Error("MELLA_BROWSER_KEY doit faire 32 octets en base64");
    this.ephemeral = !k;
    this.master = k ?? randomBytes(32);
  }

  private key(userId: string): Buffer {
    return Buffer.from(hkdfSync("sha256", this.master, Buffer.from(userId), "mella-browser-profile-v1", 32));
  }

  seal(userId: string, state: StorageState): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key(userId), iv);
    c.setAAD(Buffer.from(userId));
    const body = Buffer.concat([c.update(JSON.stringify(state), "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
  }

  open(userId: string, sealed: string): StorageState {
    const raw = Buffer.from(sealed, "base64");
    const d = createDecipheriv("aes-256-gcm", this.key(userId), raw.subarray(0, 12));
    d.setAAD(Buffer.from(userId));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
  }

  async load(q: Q, userId: string): Promise<StorageState | undefined> {
    const row = (await q.query<{ sealed: string }>(`SELECT sealed FROM browser_profiles WHERE user_id = $1`, [userId])).rows[0];
    if (!row) return undefined;
    try {
      return this.open(userId, row.sealed);
    } catch {
      return undefined; // clé changée : on repart d'un profil vierge plutôt que d'échouer
    }
  }

  async save(q: Q, userId: string, state: StorageState): Promise<void> {
    // Bornes : un profil n'a pas à peser plus de quelques centaines de Ko.
    const trimmed: StorageState = {
      cookies: (state.cookies ?? []).slice(0, 600),
      origins: (state.origins ?? []).slice(0, 60).map((o) => ({ origin: o.origin, localStorage: (o.localStorage ?? []).filter((e) => e.value.length < 20_000).slice(0, 100) })),
    };
    await q.query(
      `INSERT INTO browser_profiles (user_id, sealed) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = now()`,
      [userId, this.seal(userId, trimmed)],
    );
  }

  /** « Déconnecter = supprimer » : toutes les sessions web de la personne disparaissent. */
  async forget(q: Q, userId: string): Promise<boolean> {
    return (await q.query(`DELETE FROM browser_profiles WHERE user_id = $1 RETURNING user_id`, [userId])).rows.length > 0;
  }
}
