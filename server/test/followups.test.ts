import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createJob, runAgentLoop } from "../src/agent.ts";
import { runDue } from "../src/schedules.ts";
import { runTool } from "../src/tools.ts";
import { findOrCreateUser, getUser } from "../src/users.ts";
import { authorizeNow, getTask, recordStep } from "../src/tasks.ts";
import type { Llm } from "../src/llm.ts";

let app: App;
let userId = "";
const cfg = () => loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", MELLA_DEBOUNCE_MS: "0", LOG_LEVEL: "silent" } as any);

beforeAll(async () => {
  app = await createApp(cfg());
  userId = (await findOrCreateUser(app.db, "+33633333333", "l1", undefined)).user.id;
});
afterAll(() => app.stop());

describe("un travail de fond et ce qui arrive pendant", () => {
  it("une demande sur le travail en cours le rejoint, une autre a son propre travail", async () => {
    expect(await createJob(app.db, cfg(), userId, "Réserve le train de 11h42")).toBe(false);
    expect(await createJob(app.db, cfg(), userId, "attends, mets ma carte de réduction")).toBe(true);
    expect(await createJob(app.db, cfg(), userId, "trouve-moi un resto ce soir", null, { separate: true })).toBe(false);
    const rows = (await app.db.query<{ request: string; followups: string[] }>(`SELECT request, followups FROM jobs WHERE user_id = $1 ORDER BY created_at`, [userId])).rows;
    expect(rows.map((r) => r.request)).toEqual(["Réserve le train de 11h42", "trouve-moi un resto ce soir"]);
    expect(rows[0].followups).toEqual(["attends, mets ma carte de réduction"]);
    await app.db.query(`DELETE FROM jobs WHERE user_id = $1`, [userId]);
  });

  it("ce qu'elle écrit pendant un outil arrive au modèle avant sa réponse", async () => {
    const seen: string[] = [];
    let incoming = ["attends, mets ma carte de réduction"];
    const llm: Llm = {
      chat: async (p) => {
        seen.push(String(p.messages.at(-1)?.content ?? ""));
        const usedTool = p.messages.some((m) => m.role === "tool");
        return usedTool
          ? { text: "C'est noté, je l'applique.", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } as any }
          : { text: null, toolCalls: [{ id: "c1", type: "function", function: { name: "remember", arguments: JSON.stringify({ fact: "train de 11h42" }) } }], usage: { inputTokens: 0, outputTokens: 0 } as any };
      },
    } as Llm;
    const out = await runAgentLoop(app.db, llm, await getUser(app.db, userId), {
      mode: "task",
      model: "fake",
      system: "",
      history: [{ role: "user", content: "Réserve le train de 11h42" }],
      deadline: Date.now() + 30_000,
      incoming: async () => {
        const fresh = incoming;
        incoming = [];
        return fresh;
      },
    });
    expect(out).toBe("C'est noté, je l'applique.");
    expect(seen.at(-1)).toContain("« attends, mets ma carte de réduction »");
  });
});

describe("le retour que Mell se fixe", () => {
  it("à l'heure dite, un travail de fond relit le fil, et peut se taire", async () => {
    const user = await getUser(app.db, userId);
    const at = new Date(Date.now() + 10 * 60_000);
    const local = new Intl.DateTimeFormat("sv-SE", { timeZone: user.timezone, dateStyle: "short", timeStyle: "short" }).format(at).replace(" ", "T");
    const r = JSON.parse(await runTool(app.db, user, "check_back", JSON.stringify({ at: local, why: "le prix de 17,40 € tombe à 23h53, elle n'a pas encore dit oui" })));
    expect(r.check_back?.id).toBeTruthy();
    expect(await runDue(app.db, cfg(), new Date(at.getTime() + 61_000))).toBeGreaterThan(0);
    const job = (await app.db.query<{ request: string; quiet_ok: boolean }>(`SELECT request, quiet_ok FROM jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0];
    expect(job.quiet_ok).toBe(true);
    expect(job.request).toContain("le prix de 17,40 € tombe à 23h53");
  });
});

describe("une dépense comptée une seule fois", () => {
  it("l'étape annoncée vérifie le plafond, le clic sur le site dépense", async () => {
    const t = await authorizeNow(app.db, userId, { title: "Livre test", actions: ["buy"], spendCapCents: 2000 }, 2);
    expect((await recordStep(app.db, t, { action: "buy", amountCents: 1400 }, { count: false })).decision).toBe("allowed");
    const fresh = (await getTask(app.db, userId, t.id))!;
    expect(fresh.spent_cents).toBe(0);
    expect((await recordStep(app.db, fresh, { action: "buy", amountCents: 1400 })).decision).toBe("allowed");
    expect((await getTask(app.db, userId, t.id))!.spent_cents).toBe(1400);
  });
});

describe("un passage silencieux par défaut (veille, retour fixé)", () => {
  it("son texte final reste une note, il écrit par send_message", async () => {
    const user = await getUser(app.db, userId);
    await app.db.query(`DELETE FROM outbox WHERE user_id = $1`, [userId]);
    let tools: string[] = [];
    const llm: Llm = {
      chat: async (p) => {
        tools = (p.tools ?? []).map((t) => t.name);
        const sent = p.messages.some((m) => m.role === "tool");
        return sent
          ? { text: "Elle a déjà l'info, je ne la dérange pas plus.", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } as any }
          : { text: null, toolCalls: [{ id: "s1", type: "function", function: { name: "send_message", arguments: JSON.stringify({ text: "Le prix de 17,40 € tombe à 23h53." }) } }], usage: { inputTokens: 0, outputTokens: 0 } as any };
      },
    } as Llm;
    const out = await runAgentLoop(app.db, llm, user, { mode: "task", model: "fake", system: "", history: [{ role: "user", content: "[système] retour fixé" }], deadline: Date.now() + 30_000, allowSilence: true });
    expect(tools).toContain("send_message");
    expect(out).toBeNull();
    const texts = (await app.db.query<{ text: string }>(`SELECT text FROM outbox WHERE user_id = $1 AND kind = 'text' ORDER BY id`, [userId])).rows.map((r) => r.text);
    expect(texts).toEqual(["Le prix de 17,40 € tombe à 23h53."]);
  });
});
