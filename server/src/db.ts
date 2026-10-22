import { mkdir, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

/**
 * Accès base minimal, commun à Postgres (prod) et PGlite (dev, simulateur, tests).
 * PGlite est un Postgres complet en processus : mêmes requêtes, mêmes verrous SKIP LOCKED.
 */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Exécute `fn` dans une transaction sur une seule connexion. */
  tx<R>(fn: (q: Pick<Db, "query">) => Promise<R>): Promise<R>;
  close(): Promise<void>;
  /** Archive cohérente de la base (PGlite seulement) : pour les sauvegardes. */
  dump?: () => Promise<Uint8Array>;
}

export async function openDb(url: string | undefined): Promise<Db> {
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    // Postgres géré (Aiven) : son autorité de certification vient de DATABASE_CA ; sinon le chiffrement reste, sans vérifier le certificat.
    const ssl = /[?&]sslmode=(require|verify-ca|verify-full)/.test(url) ? (process.env.DATABASE_CA ? { ca: process.env.DATABASE_CA } : { rejectUnauthorized: false }) : undefined;
    const connectionString = url.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "");
    const pool = new pg.Pool({ connectionString, ssl, max: 10 });
    pool.on("error", (err) => console.error("[db] erreur de connexion", err.message));
    return {
      query: async (sql, params) => ({ rows: (await pool.query(sql, params as any[])).rows }),
      tx: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const out = await fn({ query: async (sql, params) => ({ rows: (await client.query(sql, params as any[])).rows }) });
          await client.query("COMMIT");
          return out;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  // url absente : base en mémoire ; sinon un dossier local (ex. ./.data/pglite).
  const dir = url?.replace(/^pglite:\/\//, "");
  // PGlite ne crée que le dernier dossier du chemin : on crée les parents.
  if (dir) await mkdir(dirname(dir), { recursive: true });
  const lite = dir ? new PGlite(dir) : new PGlite();
  return {
    query: async (sql, params) => ({ rows: (await lite.query(sql, params as any[])).rows as any[] }),
    tx: (fn) => lite.transaction((t) => fn({ query: async (sql, params) => ({ rows: (await t.query(sql, params as any[])).rows as any[] }) })),
    close: () => lite.close(),
    // Sauvegarde : l'archive du dossier de données, prise par PGlite lui-même (cohérente, sans arrêter le serveur).
    dump: async () => new Uint8Array(await (await lite.dumpDataDir("gzip")).arrayBuffer()),
  };
}

const MIGRATIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "migrations");

export async function migrate(db: Db): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    await db.tx(async (q) => {
      for (const stmt of splitSql(sql)) await q.query(stmt);
      await q.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
    });
  }
}

/** Découpe sur les `;` de fin de ligne. Suffisant tant que les migrations n'ont pas de fonctions plpgsql. */
function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}
