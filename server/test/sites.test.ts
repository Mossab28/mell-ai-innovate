import { describe, expect, it } from "vitest";
import { headlessContextFix } from "../src/browser/engines.ts";
import { minutesOf, norm, slotLabel } from "../src/browser/sites/common.ts";
import { objectiveFor } from "../src/browser/sites/index.ts";
import { calendarLabel, hourChoice } from "../src/browser/sites/sncf.ts";
import { TOOL_SPECS, toolsFor } from "../src/tools.ts";

describe("parcours enregistrés", () => {
  it("écrit la case du calendrier SNCF comme le site (jour sur deux chiffres)", () => {
    expect(calendarLabel("2026-10-15")).toBe("jeudi 15 octobre 2026");
    expect(calendarLabel("2026-11-01")).toBe("dimanche 01 novembre 2026");
  });

  it("prend l'heure paire juste avant, bornée au menu du site", () => {
    expect(hourChoice("08:30")).toBe("08h");
    expect(hourChoice("09:10")).toBe("08h");
    expect(hourChoice("23:00")).toBe("22h");
    expect(hourChoice("02:00")).toBe("04h");
    expect(hourChoice(undefined)).toBe("06h");
  });

  it("lit les heures et compare les libellés sans accents", () => {
    expect(minutesOf("20h30")).toBe(1230);
    expect(minutesOf("7:05")).toBe(425);
    expect(minutesOf("midi")).toBeUndefined();
    expect(norm("  Dermatologue et Vénérologue ")).toBe("dermatologue et venerologue");
    expect(slotLabel("2026-10-19T14:15:00.000+02:00")).toMatch(/19 oct.*14:15/);
  });

  it("garde une demande en phrase pour la boucle d'agent, en lecture seule", () => {
    const o = objectiveFor("thefork", { date: "2026-10-17", time: "20:00", partySize: 2, area: "Paris 11", cuisine: "italien" });
    expect(o).toContain("2 personnes");
    expect(o).toContain("italien");
    expect(o).toMatch(/ne réserve rien/);
  });

  it("n'expose les parcours qu'au travail de fond", () => {
    expect(TOOL_SPECS.doctolib_search.parameters).toBeTruthy();
    const quick = toolsFor("tool").map((t) => t.name);
    const task = toolsFor("task").map((t) => t.name);
    for (const n of ["doctolib_search", "sncf_search", "thefork_search"]) {
      expect(quick).not.toContain(n);
      expect(task).toContain(n);
    }
  });

  it("enlève « HeadlessChrome » et donne un écran cohérent", () => {
    const fix = headlessContextFix("155.0.8059.80") as { userAgent: string; viewport: { width: number }; screen: { width: number } };
    expect(fix.userAgent).toMatch(/ Chrome\/155\.0\.0\.0 /);
    expect(fix.userAgent).not.toMatch(/Headless/);
    expect(fix.screen.width).toBeGreaterThan(fix.viewport.width);
  });
});
