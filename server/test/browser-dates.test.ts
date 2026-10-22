import { describe, expect, it } from "vitest";
import { dateLike, dayLabels } from "../src/browser/playwright.ts";

describe("Dates du navigateur", () => {
  it("écrit la date comme l'exemple du champ", () => {
    expect(dateLike("JJ/MM/AAAA", "2026-10-19")).toBe("19/10/2026");
    expect(dateLike("MM/DD/YYYY", "2026-10-19")).toBe("10/19/2026");
    expect(dateLike("2026-01-31", "2026-10-19")).toBe("2026-10-19");
    expect(dateLike("jj.mm.aa", "2026-10-19")).toBe("19.10.26");
    expect(dateLike("", "2026-10-19")).toBe("19/10/2026");
  });
  it("connaît les libellés des cases de calendrier", () => {
    expect(dayLabels("2026-10-19")).toEqual(expect.arrayContaining(["lundi 19 octobre 2026", "October 19, 2026", "Monday, October 19, 2026"]));
  });
});
