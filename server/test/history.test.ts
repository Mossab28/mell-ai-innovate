import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { findOrCreateUser, getUser } from "../src/users.ts";
import { HISTORY, searchHistory, searchTerms } from "../src/history.ts";

let app: App;
let userId = "";

const say = (direction: "in" | "out", text: string, daysAgo: number) =>
  app.db.query(`INSERT INTO messages (user_id, direction, text, sent_at) VALUES ($1, $2, $3, now() - make_interval(days => $4))`, [userId, direction, text, daysAgo]);

beforeAll(async () => {
  app = await createApp(loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", LOG_LEVEL: "silent" } as any));
  userId = (await findOrCreateUser(app.db, "+33633333333", "l1", undefined)).user.id;
  await say("in", "mon dentiste c'est le Dr Lefèvre, 12 rue Oberkampf", 21);
  await say("out", "C'est noté.", 21);
  await say("in", "réserve chez Pink Mamma samedi", 20);
  await say("out", "Réservé chez Pink Mamma samedi à 20 h, table pour 2.", 20);
  for (let i = 0; i < HISTORY; i++) await say(i % 2 ? "out" : "in", `message récent ${i} sur le dentiste`, 1);
  await app.db.query(`INSERT INTO tool_calls (user_id, mode, name, args, result, created_at) VALUES ($1, 'task', 'web_search', '{"query":"japonais calme Paris 11"}', $2, now() - interval '9 days')`, [
    userId,
    `{"results":"${"Autres adresses sans rapport. ".repeat(60)}Kunitoraya, 5 rue Villedo : table à 20 h 15, menu à 38 €."}`,
  ]);
});
afterAll(() => app.stop());

describe("retrouver le passé", () => {
  it("les mots, sans accents ni doublons", () => {
    expect(searchTerms("Le DENTISTE, le dentiste réservé")).toEqual(["le", "dentiste", "reserve"]);
  });

  it("retrouve un vieux message sans accent, avec le fil autour et la date", async () => {
    const out = await searchHistory(app.db, await getUser(app.db, userId), "reserve pink mamma");
    expect(out).toContain("elle : réserve chez Pink Mamma samedi");
    expect(out).toContain("Mell : Réservé chez Pink Mamma samedi à 20 h");
    expect(out).toContain("<untrusted");
  });

  it("ne rend pas ce qui est déjà dans son contexte (les derniers messages)", async () => {
    const out = await searchHistory(app.db, await getUser(app.db, userId), "dentiste");
    expect(out).toContain("Dr Lefèvre");
    expect(out).not.toContain("message récent");
  });

  it("retrouve ce qu'un outil avait rendu, l'extrait centré sur ce qui est cherché", async () => {
    const out = await searchHistory(app.db, await getUser(app.db, userId), "Kunitoraya");
    expect(out).toContain("ton outil web_search");
    expect(out).toContain("Kunitoraya, 5 rue Villedo");
  });

  it("rien trouvé : il le dit, sans inventer", async () => {
    expect(await searchHistory(app.db, await getUser(app.db, userId), "piscine")).toContain("Rien trouvé");
  });
});

describe("sa fiche bornée", () => {
  it("pleine, elle refuse d'ajouter et demande de regrouper, sans rien effacer", async () => {
    const { remember, updateFact, listFacts, MEMORY_BUDGET } = await import("../src/memory.ts");
    const long = "x".repeat(400);
    for (let i = 0; i < Math.floor(MEMORY_BUDGET / 400); i++) expect(await remember(app.db, userId, `${i} ${long}`.slice(0, 400))).toHaveProperty("id");
    expect(await remember(app.db, userId, `reste ${long}`.slice(0, MEMORY_BUDGET % 400 - 20))).toHaveProperty("id");
    const before = (await listFacts(app.db, userId)).length;
    expect(await remember(app.db, userId, "Elle préfère les places côté fenêtre dans le train, toujours.")).toHaveProperty("error");
    expect((await listFacts(app.db, userId)).length).toBe(before);
    const first = (await listFacts(app.db, userId)).at(-1)!;
    expect(await updateFact(app.db, userId, first.id, "Côté fenêtre dans le train.")).toBe(true);
    expect(await remember(app.db, userId, "Elle préfère les places côté fenêtre dans le train, toujours.")).toHaveProperty("id");
  });
});

describe("réagir tout de suite", () => {
  it("pose la réaction sur son message, refuse ce qui n'en est pas une", async () => {
    const { runTool } = await import("../src/tools.ts");
    const user = await getUser(app.db, userId);
    expect(await runTool(app.db, user, "react", JSON.stringify({ reaction: "👀" }), { sourceGuid: "g-123" })).toContain("reacted");
    expect(await runTool(app.db, user, "react", JSON.stringify({ reaction: "je m'en occupe" }), { sourceGuid: "g-123" })).toContain("error");
    const t = (await app.db.query<{ tapback: string; target_guid: string }>(`SELECT tapback, target_guid FROM outbox WHERE user_id = $1 AND kind = 'tapback'`, [userId])).rows;
    expect(t).toEqual([{ tapback: "👀", target_guid: "g-123" }]);
  });
});
