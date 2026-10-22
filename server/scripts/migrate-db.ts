/**
 * Recopie toute la base de Mell d'une source vers une destination, PGlite ou Postgres dans les deux sens :
 *   npx tsx server/scripts/migrate-db.ts pglite://./.data/pglite postgres://user:pass@host/mell
 *   npx tsx server/scripts/migrate-db.ts pglite://./restore/pglite pglite://./.data/pglite
 * La destination reçoit d'abord les migrations (schéma identique), puis chaque table, dans l'ordre des
 * dépendances (les clés étrangères sont relâchées le temps de la copie sur Postgres), puis les séquences
 * sont recalées. Rien n'est effacé à la source. À la fin, les comptes de lignes sont comparés table par table.
 */
import { migrate, openDb, type Db } from "../src/db.ts";

const [src, dst] = process.argv.slice(2);
if (!src || !dst || src === dst) {
  console.error("usage : migrate-db.ts <source> <destination>  (pglite://dossier ou postgres://…)");
  process.exit(2);
}

const BATCH = 500;

async function tables(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

/** Les tables dans un ordre qui respecte les clés étrangères (parents d'abord). */
async function ordered(db: Db, names: string[]): Promise<string[]> {
  const { rows } = await db.query<{ child: string; parent: string }>(
    `SELECT tc.table_name AS child, ccu.table_name AS parent
     FROM information_schema.table_constraints tc
     JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`,
  );
  const deps = new Map<string, Set<string>>();
  for (const n of names) deps.set(n, new Set());
  for (const r of rows) if (r.child !== r.parent && deps.has(r.child)) deps.get(r.child)!.add(r.parent);
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string, stack: string[]) => {
    if (seen.has(n)) return;
    if (stack.includes(n)) return; // cycle : on laisse tel quel
    for (const p of deps.get(n) ?? []) visit(p, [...stack, n]);
    seen.add(n);
    out.push(n);
  };
  for (const n of names) visit(n, []);
  return out;
}

async function columns(db: Db, table: string): Promise<string[]> {
  const { rows } = await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]);
  return rows.map((r) => r.column_name);
}

async function main() {
  const a = await openDb(src);
  const b = await openDb(dst);
  const isPg = /^postgres(ql)?:\/\//.test(dst);
  await migrate(b);
  const names = await ordered(a, await tables(a));
  if (isPg) await b.query(`SET session_replication_role = replica`);
  const report: Array<{ table: string; src: number; dst: number }> = [];
  for (const t of names) {
    const cols = await columns(a, t);
    const quoted = cols.map((c) => `"${c}"`).join(", ");
    const total = Number((await a.query<{ n: string }>(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n);
    await b.query(`DELETE FROM "${t}"`);
    let copied = 0;
    for (let offset = 0; offset < total; offset += BATCH) {
      const { rows } = await a.query<Record<string, unknown>>(`SELECT ${quoted} FROM "${t}" ORDER BY 1 LIMIT ${BATCH} OFFSET ${offset}`);
      for (const row of rows) {
        const values = cols.map((c) => {
          const v = row[c];
          return v !== null && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v) && !Array.isArray(v) ? JSON.stringify(v) : v;
        });
        await b.query(`INSERT INTO "${t}" (${quoted}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT DO NOTHING`, values);
        copied++;
      }
    }
    const dstCount = Number((await b.query<{ n: string }>(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n);
    report.push({ table: t, src: total, dst: dstCount });
    console.log(`${t.padEnd(28)} ${String(total).padStart(7)} -> ${String(dstCount).padStart(7)}${dstCount !== total ? "  ÉCART" : ""}`);
  }
  if (isPg) await b.query(`SET session_replication_role = DEFAULT`);
  // Les séquences (bigserial) repartent après la plus grande valeur copiée.
  const { rows: seqs } = await b.query<{ sequence_name: string }>(`SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public'`);
  for (const { sequence_name } of seqs) {
    const m = sequence_name.match(/^(.+)_(\w+)_seq$/);
    if (!m) continue;
    try {
      await b.query(`SELECT setval('${sequence_name}', coalesce((SELECT max("${m[2]}") FROM "${m[1]}"), 0) + 1, false)`);
    } catch {}
  }
  const gaps = report.filter((r) => r.src !== r.dst);
  console.log(gaps.length ? `\n${gaps.length} table(s) avec écart` : "\nToutes les tables copiées à l'identique.");
  await a.close();
  await b.close();
  process.exit(gaps.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
