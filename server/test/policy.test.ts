import { describe, expect, it } from "vitest";
import { decideStep, isApprovalText, normalizeEmail, type Task } from "../src/tasks.ts";
import { parseRoute, bump } from "../src/router.ts";
import { zonedToUtc } from "../src/time.ts";
import { render } from "../src/style.ts";

const task = (over: Partial<Task> = {}): Task => ({
  id: "t",
  user_id: "u",
  title: "Acheter des piles",
  actions: ["search_web", "buy", "pay"],
  spend_cap_cents: 3000,
  currency: "EUR",
  spent_cents: 0,
  status: "authorized",
  authorized_at: new Date(),
  expires_at: new Date(Date.now() + 3_600_000),
  ...over,
});

describe("autorisation par tâche", () => {
  it("laisse passer les étapes du périmètre sans redemander", () => {
    expect(decideStep(task(), "search_web", 0).decision).toBe("allowed");
    expect(decideStep(task(), "buy", 1500).decision).toBe("allowed");
  });
  it("met le paiement en attente de la banque", () => {
    expect(decideStep(task(), "pay", 1999).decision).toBe("awaiting_bank");
  });
  it("redemande hors périmètre, au-delà du plafond, avant validation ou après expiration", () => {
    expect(decideStep(task(), "send_email", 0).decision).toBe("needs_approval");
    expect(decideStep(task({ spent_cents: 2500 }), "pay", 1000).decision).toBe("needs_approval");
    expect(decideStep(task({ status: "proposed" }), "search_web", 0).decision).toBe("needs_approval");
    expect(decideStep(task({ expires_at: new Date(Date.now() - 1) }), "search_web", 0).decision).toBe("needs_approval");
  });
  it("n'écrit qu'aux destinataires validés", () => {
    const mail = task({ actions: ["send_email"], recipients: ["paul@exemple.fr"] });
    expect(decideStep(mail, "send_email", 0, new Date(), [normalizeEmail("Paul <PAUL@exemple.fr>")]).decision).toBe("allowed");
    expect(decideStep(mail, "send_email", 0, new Date(), ["paul@exemple.fr", "pirate@evil.com"]).decision).toBe("needs_approval");
    expect(decideStep(task({ actions: ["send_email"] }), "send_email", 0, new Date(), ["paul@exemple.fr"]).decision).toBe("needs_approval");
  });
  it("ne prend pour un oui que des messages qui ne disent rien d'autre", () => {
    for (const t of ["ok", "Oui vas-y !", "go", "c'est bon", "👍", "yes do it"]) expect(isApprovalText(t), t).toBe(true);
    for (const t of ["ok mais pas plus de 10 €", "non", "achète aussi du pain", ""]) expect(isApprovalText(t), t).toBe(false);
  });
});

describe("routeur", () => {
  it("lit le JSON même entouré de balises de code", () => {
    expect(parseRoute('```json\n{"class":"react","tapback":"love","confidence":0.9}\n```')).toEqual({ class: "react", tapback: "love", confidence: 0.9 });
    expect(parseRoute("n'importe quoi")).toBeUndefined();
  });
  it("monte d'un cran sans dépasser task", () => {
    expect(bump("quick")).toBe("tool");
    expect(bump("task")).toBe("task");
  });
});

describe("heures et style", () => {
  it("convertit une heure locale de Paris, été comme hiver", () => {
    expect(zonedToUtc("2026-10-15T09:00", "Europe/Paris").toISOString()).toBe("2026-10-15T07:00:00.000Z");
    expect(zonedToUtc("2026-12-15T09:00", "Europe/Paris").toISOString()).toBe("2026-12-15T08:00:00.000Z");
  });
  it("découpe en bulles, extrait la réaction, chasse les tirets longs", () => {
    expect(render("[react:love]")).toEqual({ bubbles: [], react: "love" });
    expect(render("Fait \u2014 réservé.\n\nJe confirme jeudi ?").bubbles).toEqual(["Fait - réservé.", "Je confirme jeudi ?"]);
  });
  it("retire le remplissage, plafonne à trois bulles, met un lien final dans sa propre bulle", () => {
    expect(render("Fait \u2014 réservé.\n\nAutre chose ?").bubbles).toEqual(["Fait - réservé."]);
    expect(render("Done. Let me know if you need anything else!").bubbles).toEqual(["Done."]);
    expect(render("Autre chose ?").bubbles).toEqual(["Autre chose ?"]);
    expect(render("a\n\nb\n\nc\n\nd").bubbles).toEqual(["a", "b", "c\n\nd"]);
    expect(render("Move now: https://tickets.example.com/x.").bubbles).toEqual(["Move now:", "https://tickets.example.com/x"]);
  });
});

describe("réactions et petits signes", () => {
  it("lit une réaction d'après la bulle visée", async () => {
    const { meaningOf } = await import("../src/reactions.ts");
    const q = { text: "Deux tables ce soir : Le Servan à 20 h 30. Je le prends ?", ref: null };
    expect(meaningOf("like", q)).toEqual({ kind: "answer", text: expect.stringContaining("(= oui)") });
    expect(meaningOf("dislike", q)).toEqual({ kind: "answer", text: expect.stringContaining("(= non)") });
    expect(meaningOf("question", { text: "C'est noté.", ref: null })).toEqual({ kind: "answer", text: expect.stringContaining("je ne comprends pas") });
    expect(meaningOf("love", { text: "C'est noté.", ref: null })).toEqual({ kind: "none" });
    expect(meaningOf("like", { text: "Appelle le garagiste.", ref: "reminder:x" })).toEqual({ kind: "seen" });
    expect(meaningOf("🫡", { text: "C'est noté.", ref: null }).kind).toBe("answer");
    expect(meaningOf("like", undefined)).toEqual({ kind: "none" });
  });

  it("se tait sur [rien], pose les confettis sur une bonne nouvelle", async () => {
    const { render } = await import("../src/style.ts");
    expect(render("[rien]")).toEqual({ bubbles: [] });
    expect(render("Je m'en occupe.\n\n[rien]").bubbles).toEqual(["Je m'en occupe."]);
    expect(render("[react:👍] Compris, je fais plus court.")).toMatchObject({ bubbles: ["Compris, je fais plus court."], react: "👍" });
    expect(render("[react:🚆] « Je regarde les horaires. »").react).toBe("🚆");
    expect(render("[effet:confetti] Réservé : Le Servan, 20 h 30, pour 4.")).toEqual({ bubbles: ["Réservé : Le Servan, 20 h 30, pour 4."], react: undefined, effect: "confetti" });
  });
});
