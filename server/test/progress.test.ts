import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { findOrCreateUser } from "../src/users.ts";
import { enqueue } from "../src/outbox.ts";
import { progressBecome } from "../src/progress.ts";

let app: App;
let userId = "";

beforeAll(async () => {
  app = await createApp(loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", LOG_LEVEL: "silent" } as any));
  userId = (await findOrCreateUser(app.db, "+33644444444", "l1", undefined)).user.id;
});
afterAll(() => app.stop());

describe("bulle d'avancement", () => {
  it("devenue le résultat sur son téléphone, elle l'est aussi dans le fil que Mell relit (22/10)", async () => {
    await enqueue(app.db, [{ userId, kind: "text", text: "⏳ Looking at google.com…", ref: "status" }]);
    await app.db.query(`UPDATE outbox SET status = 'sent', guid = 'g-status' WHERE user_id = $1 AND ref = 'status'`, [userId]);
    expect(await progressBecome(app.db, userId, "Air France is the only direct SkyTeam option: €821 for two.")).toBe(true);
    const out = (await app.db.query<{ text: string }>(`SELECT text FROM messages WHERE user_id = $1 AND direction = 'out' ORDER BY id`, [userId])).rows.map((r) => r.text);
    expect(out).toEqual(["Air France is the only direct SkyTeam option: €821 for two."]);
  });
});
