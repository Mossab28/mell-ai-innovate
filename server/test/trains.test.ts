import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { trainTimes } from "../src/trains/gtfs.ts";

// Deux mini fichiers au format des vrais : le national (TER) et le Transilien, où Montparnasse s'appelle « Gare Montparnasse ».
const dir = mkdtempSync(join(tmpdir(), "gtfs-"));
const feed = (name: string, files: Record<string, string>) => {
  writeFileSync(join(dir, `${name}.zip`), ""); // présent et du jour : pas de téléchargement
  mkdirSync(join(dir, name), { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, name, f), body);
};
feed("sncf", {
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nSA:1,Dreux,48.73,1.37,1,\nStopPoint:OCETrain TER-1,Dreux,48.73,1.37,0,SA:1\nSA:2,Paris Montparnasse Hall 1 - 2,48.84,2.32,1,\nStopPoint:OCETrain TER-2,Paris Montparnasse Hall 1 - 2,48.84,2.32,0,SA:2\n",
  "routes.txt": "route_id,route_short_name,route_long_name,route_type\nR1,,Dreux - Paris,2\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign\nR1,S1,T1,3402\nR1,S1,T2,3404\n",
  "calendar_dates.txt": "service_id,date,exception_type\nS1,20261020,1\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,07:18:00,07:18:00,StopPoint:OCETrain TER-1,0\nT1,08:16:00,08:16:00,StopPoint:OCETrain TER-2,1\nT2,06:55:00,06:55:00,StopPoint:OCETrain TER-1,0\nT2,08:02:00,08:02:00,StopPoint:OCETrain TER-2,1\n",
});
feed("transilien", {
  "stops.txt": "stop_id,stop_name,stop_lon,stop_lat,location_type,parent_station\nI:1,Dreux,1.37,48.73,1,\nI:q1,Dreux,1.37,48.73,0,I:1\nI:2,Gare Montparnasse,2.32,48.84,1,\nI:q2,Gare Montparnasse,2.32,48.84,0,I:2\n",
  "routes.txt": "route_id,route_short_name,route_long_name,route_type\nN,N,Ligne N,2\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign,trip_short_name\nN,W,N1,PADO,165001\nN,W,N2,PADO,165003\n",
  "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nW,1,1,1,1,1,0,0,20261019,20261030\n",
  "calendar_dates.txt": "service_id,date,exception_type\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nN1,06:25:00,06:25:00,I:q1,1\nN1,07:32:00,07:32:00,I:q2,22\nN2,06:55:00,06:55:00,I:q1,1\nN2,08:02:00,08:02:00,I:q2,22\n",
});

describe("Horaires officiels SNCF", () => {
  it("trouve TER et Transilien vers « Paris », sans doublon, à partir de l'heure demandée", async () => {
    const trains = await trainTimes({ from: "Dreux", to: "Paris", date: "2026-10-20", after: "06:00" }, dir);
    expect(trains.map((t) => `${t.departure} ${t.line} ${t.to}`)).toEqual([
      "06:25 Transilien N Gare Montparnasse",
      expect.stringMatching(/^06:55 /), // le même train dans les deux fichiers : une seule ligne
      "07:18 Train TER Paris Montparnasse Hall 1 - 2",
    ]);
    expect(await trainTimes({ from: "Dreux", to: "Montparnasse", date: "2026-10-24" }, dir)).toEqual([]); // samedi : ni le TER du 20 ni la semaine N
  });
});
