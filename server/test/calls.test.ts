import { describe, expect, it } from "vitest";
import { openDb, migrate } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { createOnce, runDue } from "../src/schedules.ts";

/** « Mell t'appelle » : un réveil appelle à l'heure, un rappel important appelle s'il n'y a pas de réaction. */
async function setup() {
  const db = await openDb(undefined);
  await migrate(db);
  await db.query(`INSERT INTO lines (id, handle, secret) VALUES ('l1', '+33100000000', 's')`);
  const uid = (await db.query<{ id: string }>(`INSERT INTO users (handle, line_id) VALUES ('+33611111111', 'l1') RETURNING id`)).rows[0].id;
  return { db, uid, cfg: loadConfig({} as any) };
}
const sent = async (db: any) => (await db.query(`SELECT kind, text FROM outbox ORDER BY id`)).rows.map((r: any) => `${r.kind}:${r.text}`);

describe("appels de rappel", () => {
  it("un réveil part en texto et en appel à l'heure dite", async () => {
    const { db, uid, cfg } = await setup();
    const now = new Date();
    await createOnce(db, uid, new Date(now.getTime() - 1000), "Debout, train à 8 h 12.", "Europe/Paris", undefined, "wake");
    await runDue(db, cfg, now);
    expect(await sent(db)).toEqual(["text:Debout, train à 8 h 12.", "call:Debout, train à 8 h 12."]);
    await db.close();
  });

  it("un rappel important appelle seulement s'il n'y a eu ni réaction ni réponse", async () => {
    const { db, uid, cfg } = await setup();
    const now = new Date();
    await createOnce(db, uid, new Date(now.getTime() - 1000), "Ton médicament.", "Europe/Paris", undefined, "if_no_answer");
    await runDue(db, cfg, now);
    expect(await sent(db)).toEqual(["text:Ton médicament."]);
    await runDue(db, cfg, new Date(now.getTime() + 6 * 60_000));
    expect(await sent(db)).toEqual(["text:Ton médicament.", "call:Ton médicament."]);

    // Second rappel : un pouce de sa part avant l'échéance, et l'appel ne part pas.
    await createOnce(db, uid, new Date(now.getTime() + 7 * 60_000), "Appelle le garagiste.", "Europe/Paris", undefined, "if_no_answer");
    await runDue(db, cfg, new Date(now.getTime() + 8 * 60_000));
    await db.query(`INSERT INTO messages (user_id, direction, tapback, sent_at) VALUES ($1, 'in', 'like', $2)`, [uid, new Date(now.getTime() + 9 * 60_000)]);
    await runDue(db, cfg, new Date(now.getTime() + 14 * 60_000));
    expect((await sent(db)).filter((s: string) => s.startsWith("call:"))).toEqual(["call:Ton médicament."]);
    await db.close();
  });
});
