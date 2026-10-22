import { describe, expect, it } from "vitest";
import { coerceArgs, parseArgs, resolveToolName } from "../src/tool-args.ts";
import { TOOL_SPECS } from "../src/tools.ts";

describe("appels d'outils écrits de travers (modèles ouverts)", () => {
  it("lit le JSON dans des ```, avec une virgule en trop, encodé deux fois, ou entouré de texte", () => {
    expect(parseArgs('```json\n{"query": "dentiste",}\n```')).toEqual({ query: "dentiste" });
    expect(parseArgs(JSON.stringify(JSON.stringify({ query: "x" })))).toEqual({ query: "x" });
    expect(parseArgs('Voici : {"fact": "aime le thé"} merci')).toEqual({ fact: "aime le thé" });
    expect(parseArgs("")).toEqual({});
    expect(parseArgs("pas du tout du json")).toBeUndefined();
  });

  it("ramène chaque argument au type de son schéma, sans toucher à ce qui est déjà juste", () => {
    expect(coerceArgs(TOOL_SPECS.update_memory, { id: "12", fact: "x" })).toEqual({ id: 12, fact: "x" });
    expect(coerceArgs(TOOL_SPECS.propose_task, { actions: '["book", "pay"]', spend_cap_cents: "4500", title: "Resto" })).toMatchObject({ actions: ["book", "pay"], spend_cap_cents: 4500 });
    expect(coerceArgs(TOOL_SPECS.propose_task, { actions: "book" })).toMatchObject({ actions: ["book"] });
    expect(coerceArgs(TOOL_SPECS.personal_info, { email: "null" })).toEqual({ email: null });
    expect(coerceArgs(TOOL_SPECS.web_search, { query: 2026 })).toEqual({ query: "2026" });
    expect(coerceArgs(TOOL_SPECS.update_memory, { id: "douze" })).toEqual({ id: "douze" });
  });

  it("retrouve le nom d'outil voulu, seulement s'il est univoque", () => {
    const known = Object.keys(TOOL_SPECS);
    expect(resolveToolName("functions.remember", known)).toBe("remember");
    expect(resolveToolName("Web-Search", known)).toBe("web_search");
    expect(resolveToolName("teleporter", known)).toBeUndefined();
  });
});
