import { describe, expect, it } from "vitest";
import { bestPlace, doorToDoor } from "../src/browser/sites/sncf.ts";

// Forme de la réponse de SNCF Connect pour Dreux -> Paris (TER et Transilien), relevée le 17/10/2026.
const leg = (label: string, type: string, line: string | undefined, arrival: string) => ({ label, mode: "TRANSIT", type, line: line ? { name: line } : {}, stopSemanticLabel: `Arrivée à ${arrival} à 07:35. {2}.` });
const it1 = {
  feasible: true, departureTimeLabel: "06:25", arrivalTimeLabel: "07:35", durationLabel: "1h10", connectionsLabel: "1 correspondance",
  origin: { label: "Dreux" }, destination: { label: "Paris" },
  legs: [leg("Transilien", "RAPID_TRANSIT", "N", "Versailles Chantiers"), { label: "Attente", mode: "TRANSIT", type: "WAITING" }, leg("Train", "TER", undefined, "Paris - Montparnasse - Hall 1 & 2")],
  disruptions: { messages: [{ title: "Travaux en journée entre Chartres et Le Mans." }] },
};
const data = { doorToDoor: { results: { doorToDoorItineraries: [{ itineraries: [it1, { ...it1, departureTimeLabel: "06:51", arrivalTimeLabel: "07:50" }] }, { itineraries: [it1] }] } } };

describe("SNCF Connect, trajets régionaux", () => {
  it("lit horaires, lignes, gare d'arrivée et travaux, sans doublon ni prix inventé", () => {
    const trains = doorToDoor(data, 8);
    expect(trains).toHaveLength(2);
    expect(trains[0]).toMatchObject({ departure: "06:25", arrival: "07:35", from: "Dreux", to: "Paris - Montparnasse - Hall 1 & 2", summary: "Transilien N puis TER", connections: "1 correspondance", alerts: ["Travaux en journée entre Chartres et Le Mans."] });
    expect(trains[0].price).toBeUndefined();
    expect(trains[1].departure).toBe("06:51");
  });
});

describe("SNCF Connect, choix du lieu", () => {
  it("prend la gare que le site propose, jamais le café qui commence par les mêmes mots", () => {
    // Suggestions pour « Paris Est », relevées le 19/10/2026.
    const r = (label: string, placeType: string) => ({ id: label, label, type: { placeType } });
    const suggestions = { places: [{ results: [r("Paris Gare de l’Est", "STATION")] }, { results: [r("Les Adrets Logis de Paris (Côté Est)", "BUS")] }, { results: [r("Paris est toujours Paris, Passage Jouffroy, Paris", "POI")] }] };
    expect(bestPlace(suggestions)).toBe("Paris Gare de l’Est");
    expect(bestPlace({ places: [{ results: [r("Paris est toujours Paris", "POI")] }] })).toBeUndefined();
  });
});
