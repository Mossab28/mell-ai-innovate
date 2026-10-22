import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Db } from "./db.ts";

const run = promisify(execFile);

/**
 * Sauvegarde de la mémoire de Mell, chaque nuit et à la demande (/admin/backup) :
 * - la base (PGlite) : conversations, faits, rappels, veilles, tâches, mails, cartes, comptes, sessions ;
 * - le coffre (OpenBao sur le VPS) : ses données Raft, sa clé de scellement et sa configuration, pris par SSH.
 * Deux archives datées dans `backups/` (14 gardées), chacune envoyée dans le seau S3 (chiffré, versionné, Paris).
 * Restaurer = poser l'archive de la base dans `.data/pglite` et celle du coffre dans `~/mella-vault` d'une
 * autre machine : c'est aussi le chemin pour déménager Mell (un Mac mini, un autre serveur).
 */
export interface BackupOptions {
  dir: string;
  bucket?: string;
  region?: string;
  /** `user@hôte` du coffre ; le serveur y a déjà sa clé SSH (tunnel). */
  vaultSsh?: string;
}

export interface BackupResult {
  db?: { file: string; bytes: number; uploaded: boolean };
  vault?: { file: string; bytes: number; uploaded: boolean };
  errors: string[];
}

const KEEP = 14;

export async function runBackup(db: Db, o: BackupOptions): Promise<BackupResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out: BackupResult = { errors: [] };
  await mkdir(o.dir, { recursive: true });
  const s3 = o.bucket ? new S3Client({ region: o.region ?? "eu-west-3" }) : undefined;
  const upload = async (key: string, body: Uint8Array) => {
    if (!s3) return false;
    await s3.send(new PutObjectCommand({ Bucket: o.bucket!, Key: key, Body: body, ContentType: "application/gzip" }));
    return true;
  };

  if (db.dump) {
    try {
      const bytes = await db.dump();
      const file = `pglite-${stamp}.tar.gz`;
      await writeFile(join(o.dir, file), bytes);
      out.db = { file, bytes: bytes.length, uploaded: false };
      out.db.uploaded = await upload(`pglite/${file}`, bytes).catch((e) => (out.errors.push(`S3 base : ${(e as Error).message}`), false));
    } catch (e) {
      out.errors.push(`base : ${(e as Error).message}`);
    }
  } else out.errors.push("base : pas de dump (Postgres externe : utiliser pg_dump)");

  if (o.vaultSsh) {
    try {
      // Archive prise à distance en un flux : données Raft, clé de scellement, configuration.
      const { stdout } = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", o.vaultSsh, "tar czf - -C ~/mella-vault data secrets bao.hcl"], { encoding: "buffer", maxBuffer: 512 * 1024 * 1024, timeout: 120_000 });
      const bytes = new Uint8Array(stdout as unknown as Buffer);
      const file = `vault-${stamp}.tar.gz`;
      await writeFile(join(o.dir, file), bytes);
      out.vault = { file, bytes: bytes.length, uploaded: false };
      out.vault.uploaded = await upload(`vault/${file}`, bytes).catch((e) => (out.errors.push(`S3 coffre : ${(e as Error).message}`), false));
    } catch (e) {
      out.errors.push(`coffre : ${(e as Error).message}`);
    }
  }

  // La configuration (jetons, clés, dont la clé Web Bot Auth) : sans elle, une restauration ne redémarre pas.
  for (const envFile of [join(process.env.HOME ?? "/home/ubuntu", "mell.env")]) {
    try {
      const bytes = new Uint8Array(await (await import("node:fs/promises")).readFile(envFile));
      await upload(`env/mell.env-${stamp}`, bytes);
    } catch {}
  }
  // Ménage local : les 14 dernières de chaque sorte.
  for (const prefix of ["pglite-", "vault-"]) {
    const files = (await readdir(o.dir)).filter((f) => f.startsWith(prefix)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP))) await rm(join(o.dir, f), { force: true });
  }
  return out;
}

/** Les sauvegardes locales présentes, pour /admin/backup en GET. */
export async function listBackups(dir: string): Promise<Array<{ file: string; bytes: number; at: Date }>> {
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".tar.gz")).sort().reverse();
    return Promise.all(files.map(async (file) => ({ file, bytes: (await stat(join(dir, file))).size, at: (await stat(join(dir, file))).mtime })));
  } catch {
    return [];
  }
}
