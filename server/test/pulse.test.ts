import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LINE_HEADER, SIGNATURE_HEADER, sign } from "@mella/shared";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { planPulses } from "../src/pulse.ts";
import { runBatch } from "../src/batch.ts";
import { zonedToUtc } from "../src/time.ts";

let app: App;
const ME = "+33644444444";
let n = 0;

async function say(text: string) {
  const raw = JSON.stringify({ lineId: "l1", messages: [{ guid: `p${++n}`, from: ME, sentAt: new Date().toISOString(), text }] });
  await app.http.inject({ method: "POST", url: "/relay/inbound", payload: raw, headers: { "content-type": "application/json", [LINE_HEADER]: "l1", [SIGNATURE_HEADER]: sign("s1", raw) } });
  await app.tick();
}
const cfg = () => loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", MELLA_DEBOUNCE_MS: "0", LOG_LEVEL: "silent" } as any);
const jobs = async () => (await app.db.query<{ kind: string; payload: string; deliver_at: Date }>(`SELECT kind, payload, deliver_at FROM batch_jobs WHERE kind = 'pulse' ORDER BY created_at`)).rows;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());

beforeAll(async () => {
  app = await createApp(cfg());
  await say("Salut Mell !");
  await say("Je fête mes 30 ans samedi");
});
afterAll(() => app.stop());

describe("La veille de Mell", () => {
  it("prépare le brief du matin à l'avance, une seule fois, avec ce qui a déjà été dit", async () => {
    const at = zonedToUtc(`${today()}T07:20`, "Europe/Paris");
    expect(await planPulses(app.db, cfg(), at)).toBe(1);
    expect(await planPulses(app.db, cfg(), at)).toBe(0);
    const [job] = await jobs();
    expect(job.deliver_at.toISOString()).toBe(zonedToUtc(`${today()}T07:45`, "Europe/Paris").toISOString());
    expect(job.payload).toContain("Passage du matin");
    expect(job.payload).toContain("Elle : Je fête mes 30 ans samedi");
    expect(job.payload).toContain("Ce que tu lui as écrit de toi-même ces trois derniers jours : rien.");
  });

  it("attend la fin d'une conversation à midi, puis passe une fois", async () => {
    const noon = zonedToUtc(`${today()}T12:35`, "Europe/Paris");
    await say("tu peux me rappeler le resto ?");
    expect(await planPulses(app.db, cfg(), noon)).toBe(0); // elle vient d'écrire
    await app.db.query(`UPDATE messages SET sent_at = sent_at - interval '1 hour'`);
    expect(await planPulses(app.db, cfg(), noon)).toBe(1);
    expect((await jobs()).map((j) => j.payload.split("\n")[0])).toEqual([expect.stringContaining("matin"), expect.stringContaining("midi")]);
  });

  it("se tait hors des heures de passage et quand elle a demandé le silence", async () => {
    expect(await planPulses(app.db, cfg(), zonedToUtc(`${today()}T15:30`, "Europe/Paris"))).toBe(0);
    await app.db.query(`UPDATE users SET quiet_until = now() + interval '2 days'`);
    expect(await planPulses(app.db, cfg(), zonedToUtc(`${today()}T18:40`, "Europe/Paris"))).toBe(0);
    await app.db.query(`UPDATE users SET quiet_until = NULL`);
  });

  it("à son heure, le passage est confié à l'agent, et ce qu'il a rassemblé reste visible comme résultat d'outil", async () => {
    await app.db.query(`UPDATE batch_jobs SET deliver_at = now() WHERE kind = 'pulse'`);
    await runBatch(app.db, cfg(), app.llm);
    const job = (await app.db.query<{ request: string; quiet_ok: boolean }>(`SELECT request, quiet_ok FROM jobs ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(job.quiet_ok).toBe(true);
    expect(job.request).toContain("passages de veille");
    expect((await app.db.query(`SELECT 1 FROM tool_calls WHERE name = 'veille'`)).rows.length).toBeGreaterThan(0);
  });
});
