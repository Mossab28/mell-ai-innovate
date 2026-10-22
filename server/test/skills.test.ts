import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { findOrCreateUser } from "../src/users.ts";
import { setPersonal } from "../src/personal.ts";
import { lessonsForHer, manageSkill, skillsForHost, skillsIndex } from "../src/skills.ts";

let app: App;
let userId = "";

beforeAll(async () => {
  app = await createApp(loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", LOG_LEVEL: "silent" } as any));
  userId = (await findOrCreateUser(app.db, "+33622222222", "l1", undefined)).user.id;
  await setPersonal(app.db, userId, { full_name: "Camille Martin" });
});
afterAll(() => app.stop());

describe("modes d'emploi appris", () => {
  it("un mode d'emploi de site sert tout de suite, au navigateur et dans la liste de l'agent", async () => {
    const body = "Marche à suivre :\n- Choisir la gare dans les suggestions.\nPièges :\n- Choisis la gare, pas un lieu du même nom : la recherche partirait d'un café.";
    expect(await manageSkill(app.db, userId, { action: "create", name: "SNCF Connect", description: "Réserver un train sur SNCF Connect", body, domains: ["https://www.sncf-connect.com/"] }, new Set())).toContain("créé");
    expect((await skillsForHost(app.db, userId, "www.sncf-connect.com")).map((s) => s.name)).toEqual(["SNCF Connect"]);
    expect(await skillsIndex(app.db, userId)).toContain("SNCF Connect : Réserver un train sur SNCF Connect (sncf-connect.com)");
  });

  it("on ne corrige qu'après avoir relu, et à partir d'un passage exact", async () => {
    const viewed = new Set<string>();
    expect(await manageSkill(app.db, userId, { action: "patch", name: "SNCF Connect", old_string: "Choisir la gare", new_string: "Choisir la gare (Paris Gare de l'Est)" }, viewed)).toContain("relis d'abord");
    viewed.add("sncf connect");
    expect(await manageSkill(app.db, userId, { action: "patch", name: "SNCF Connect", old_string: "Choisir la gare dans", new_string: "Choisir la gare (Paris Gare de l'Est) dans" }, viewed)).toContain("version 2");
  });

  it("un mode d'emploi partagé ne contient rien d'une personne ; une leçon de comportement attend l'accord", async () => {
    expect(await manageSkill(app.db, userId, { action: "create", name: "Infos voyageur", description: "Remplir le voyageur", body: "Taper Camille Martin dans le nom." }, new Set())).toContain("refusé");
    expect(await manageSkill(app.db, userId, { action: "create", name: "Parler moins", description: "Une bulle par résultat", body: "Pièges :\n- Ne redis pas ce que tu viens de dire : elle décroche." }, new Set())).toContain("attente d'accord");
    expect(await skillsIndex(app.db, userId)).not.toContain("Parler moins");
  });
});

describe("revue d'une conversation calmée", () => {
  it("relit une conversation calmée une seule fois", async () => {
    const { reviewQuietConversations } = await import("../src/review.ts");
    await app.db.query(`INSERT INTO messages (user_id, direction, text, sent_at, processed_at) VALUES ($1, 'in', 'non pas la carte fluo, ma carte bancaire', now() - interval '20 minutes', now())`, [userId]);
    const cfg = loadConfig({ MELLA_LLM: "fake", LOG_LEVEL: "silent" } as any);
    expect(await reviewQuietConversations(app.db, cfg, app.llm)).toBe(1);
    expect(await reviewQuietConversations(app.db, cfg, app.llm)).toBe(0);
  });
});

describe("le curateur", () => {
  const age = (name: string, days: number) => app.db.query(`UPDATE skills SET created_at = now() - make_interval(days => $2), updated_at = now() - make_interval(days => $2), last_used_at = NULL WHERE name = $1`, [name, days]);
  const status = async (name: string) => (await app.db.query<{ status: string }>(`SELECT status FROM skills WHERE name = $1`, [name])).rows[0]?.status;

  it("périmé après 14 jours sans usage, archivé après 30, jamais supprimé ; une leçon en attente n'est pas touchée", async () => {
    const { applyTransitions } = await import("../src/curator.ts");
    const mk = (name: string, domains: string[] = ["exemple.fr"]) => manageSkill(app.db, null, { action: "create", name, description: `Mener ${name}`, body: "Marche à suivre :\n- Ouvrir la page de réservation.", domains }, new Set());
    await mk("Site vieux");
    await mk("Site oublié");
    await mk("Site frais");
    await mk("Leçon en attente", []);
    await age("Site vieux", 20);
    await age("Site oublié", 40);
    await age("Leçon en attente", 40);
    expect(await applyTransitions(app.db)).toEqual({ stale: 1, archived: 1, reactivated: 0 });
    expect([await status("Site vieux"), await status("Site oublié"), await status("Site frais"), await status("Leçon en attente")]).toEqual(["stale", "archived", "active", "pending"]);
  });

  it("un mode d'emploi périmé sert encore quand le navigateur revient sur son site, et redevient actif", async () => {
    await app.db.query(`UPDATE skills SET domains = '{vieux.fr}' WHERE name = 'Site vieux'`);
    expect((await skillsForHost(app.db, userId, "www.vieux.fr")).map((s) => s.name)).toEqual(["Site vieux"]);
    expect(await status("Site vieux")).toBe("active");
  });

  it("archiver demande d'avoir relu, et jamais une leçon en attente d'accord", async () => {
    expect(await manageSkill(app.db, null, { action: "archive", name: "Site frais" }, new Set())).toContain("relis d'abord");
    expect(await manageSkill(app.db, null, { action: "archive", name: "Site frais" }, new Set(["site frais"]))).toContain("archivé");
    expect(await manageSkill(app.db, null, { action: "archive", name: "Leçon en attente" }, new Set(["leçon en attente"]))).toContain("accord");
    expect(await manageSkill(app.db, null, { action: "create", name: "Perso", description: "x", body: "y", scope: "user" }, new Set())).toContain("bibliothèque partagée");
  });
});

describe("ses leçons à elle", () => {
  it("sont en entier dans le contexte, pas dans la liste, et bornées : plein, il faut regrouper", async () => {
    const body = "Pièges :\n- Une seule question à la fois : elle répond à côté quand il y en a deux.";
    expect(await manageSkill(app.db, userId, { action: "create", name: "sa-facon", description: "Comment lui parler", body, scope: "user" }, new Set())).toContain("créé");
    expect(await lessonsForHer(app.db, userId)).toContain("Une seule question à la fois");
    expect(await skillsIndex(app.db, userId)).not.toContain("sa-facon");
    const long = "- Règle qui prend de la place.\n".repeat(90);
    expect(await manageSkill(app.db, userId, { action: "create", name: "autre-lecon", description: "Encore une", body: long, scope: "user" }, new Set())).toContain("regroupe");
  });
});
