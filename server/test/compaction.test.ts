import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { refreshThreadSummary } from "../src/compaction.ts";
import { HISTORY } from "../src/history.ts";
import { systemPrompt } from "../src/prompt.ts";
import { getUser } from "../src/users.ts";

/** La fiche de reprise (à la Hermes et OpenClaw) : ce qui sort de la fenêtre est repris, mis à jour, et lu par l'agent. */
let app: App;
let userId: string;
const cfg = loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", LOG_LEVEL: "silent" } as any);
const seen: string[] = [];
const llm = {
  async chat(input: any) {
    seen.push(String(input.messages[1].content));
    return { text: `Ce qui a été fait :\n${seen.length}e passage`, toolCalls: [] };
  },
} as any;

beforeAll(async () => {
  app = await createApp(cfg);
  userId = (await app.db.query(`INSERT INTO users (handle, line_id, name) VALUES ('+33644444444', 'l1', 'Moss') RETURNING id`)).rows[0].id;
});
afterAll(() => app.stop());

const say = (n: number, from = 0) =>
  app.db.query(
    `INSERT INTO messages (user_id, direction, guid, text) SELECT $1, CASE WHEN g % 2 = 0 THEN 'in' ELSE 'out' END, 'g' || g, 'message ' || g FROM generate_series($2::int, $3::int) g`,
    [userId, from, from + n - 1],
  );

describe("fiche de reprise du fil", () => {
  it("rien tant que la fenêtre contient tout le fil", async () => {
    await say(HISTORY);
    await refreshThreadSummary(app.db, cfg, llm, (await getUser(app.db, userId)) as any);
    expect((await getUser(app.db, userId)).thread_summary).toBeNull();
  });

  it("reprend ce qui sort de la fenêtre, puis met à jour la fiche précédente", async () => {
    await say(20, HISTORY);
    await refreshThreadSummary(app.db, cfg, llm, (await getUser(app.db, userId)) as any);
    const u1 = await getUser(app.db, userId);
    expect(u1.thread_summary).toContain("1e passage");
    expect(seen[0]).toContain("message 0");
    expect(seen[0]).not.toContain("Fiche précédente");
    await say(20, HISTORY + 20);
    await refreshThreadSummary(app.db, cfg, llm, u1 as any);
    expect(seen[1]).toContain("Fiche précédente");
    expect(seen[1]).not.toContain("message 0\n");
    expect((await getUser(app.db, userId)).thread_summary).toContain("2e passage");
  });

  it("l'agent la lit dans son contexte", async () => {
    const system = await systemPrompt(app.db, await getUser(app.db, userId), new Date(), "tool");
    expect(system).toContain("ta fiche de reprise");
    expect(system).toContain("2e passage");
  });
});
