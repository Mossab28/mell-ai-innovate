import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, migrate, type Db } from "../src/db.ts";
import { seedLines } from "../src/lines.ts";
import { findOrCreateUser, getUser } from "../src/users.ts";
import { getPersonal, setPersonal, personalLine } from "../src/personal.ts";
import { runTool, toolsFor } from "../src/tools.ts";
import { userContext } from "../src/prompt.ts";

describe("infos perso en mémoire", () => {
  let db: Db;
  beforeAll(async () => {
    db = await openDb(undefined);
    await migrate(db);
    await seedLines(db, "l1|mell@line.test|s1");
  });
  afterAll(async () => db.close());

  it("le modèle les retient par l'outil, les voit dans son contexte, et en oublie une sur null", async () => {
    const { user } = await findOrCreateUser(db, "+33600000001", "l1", "Salut");
    expect(toolsFor("tool").some((t) => t.name === "personal_info")).toBe(true);
    const r = JSON.parse(await runTool(db, await getUser(db, user.id), "personal_info", JSON.stringify({ full_name: "Moss Test", birthdate: "2007-03-28", email: "m@test.fr" })));
    expect(r.saved).toEqual(["full_name", "email", "birthdate"]);
    expect(await getPersonal(db, user.id)).toEqual({ full_name: "Moss Test", email: "m@test.fr", birthdate: "2007-03-28" });
    const ctx = await userContext(db, await getUser(db, user.id), new Date());
    expect(ctx).toContain("full_name = Moss Test");
    expect(ctx).toContain("birthdate = 2007-03-28");
    await setPersonal(db, user.id, { email: null });
    expect(personalLine(await getPersonal(db, user.id))).not.toContain("m@test.fr");
  });

  it("le lien du coffre ne propose plus que les vrais secrets", () => {
    const spec = toolsFor("tool").find((t) => t.name === "vault_request_link") as any;
    expect(spec.parameters.properties.kind.enum).toEqual(["login", "totp", "card"]);
  });
});
