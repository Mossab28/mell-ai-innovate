import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { LINE_HEADER, SIGNATURE_HEADER, sign, TAPBACK_EMOJI, type OutboxResponse, type Tapback } from "@mella/shared";
import { createApp, loadConfig } from "@mella/server";

/**
 * Simulateur : joue le rôle du relais et du téléphone de l'utilisateur, sans iMessage.
 * Par défaut il démarre un serveur Mell en processus (base PGlite en mémoire, modèle factice).
 *   pnpm sim                      modèle factice, rien ne sort de la machine
 *   MELLA_LLM=bedrock pnpm sim    vrais modèles Bedrock (profil AWS courant)
 *   MELLA_SIM_URL=http://... MELLA_LINE_ID=... MELLA_LINE_SECRET=... pnpm sim   serveur existant
 */

const env = process.env;
const external = env.MELLA_SIM_URL;
const LINE = env.MELLA_LINE_ID ?? "sim";
const SECRET = env.MELLA_LINE_SECRET ?? "sim-secret";
const ADMIN = env.MELLA_ADMIN_TOKEN ?? "sim-admin";
let me = env.MELLA_SIM_FROM ?? "+33600000001";

let base = external?.replace(/\/+$/, "") ?? "";
let app: Awaited<ReturnType<typeof createApp>> | undefined;
if (!external) {
  const cfg = loadConfig({
    ...env,
    MELLA_LLM: env.MELLA_LLM ?? "fake",
    PORT: env.PORT ?? "8788",
    MELLA_ADMIN_TOKEN: ADMIN,
    MELLA_SEED_LINES: `${LINE}|+33100000000|${SECRET}`,
    MELLA_DEBOUNCE_MS: env.MELLA_DEBOUNCE_MS ?? "800",
    LOG_LEVEL: env.LOG_LEVEL ?? "warn",
  });
  app = await createApp(cfg);
  base = (await app.start()).replace("0.0.0.0", "127.0.0.1");
  console.log(`Serveur Mell en processus sur ${base} (modèle ${cfg.llm === "fake" ? "factice" : "Bedrock"}).`);
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, admin = false): Promise<T> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (admin) headers.authorization = `Bearer ${ADMIN}`;
  else Object.assign(headers, { [LINE_HEADER]: LINE, [SIGNATURE_HEADER]: sign(SECRET, method === "GET" ? path : raw) });
  const res = await fetch(base + path, { method, headers, body: method === "POST" ? raw : undefined });
  if (!res.ok) throw new Error(`${method} ${path} : ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

let lastMellaGuid: string | undefined;
let running = true;

async function outbound(): Promise<void> {
  while (running) {
    try {
      const { messages } = await call<OutboxResponse>("GET", `/relay/outbox?wait=5000`);
      for (const m of messages) {
        lastMellaGuid = `out-${m.id}`;
        const shown = m.kind === "tapback" ? `[réagit ${TAPBACK_EMOJI[m.tapback as Tapback] ?? m.tapback}]` : m.text;
        console.log(`\x1b[36mMella${m.to !== me ? ` -> ${m.to}` : ""}${m.effect ? ` (${m.effect})` : ""} :\x1b[0m ${shown}`);
      }
      if (messages.length) await call("POST", "/relay/ack", { lineId: LINE, results: messages.map((m) => ({ id: m.id, ok: true })) });
    } catch (e) {
      if (running) console.error("[sim]", (e as Error).message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function say(text: string, tapback?: string): Promise<void> {
  await call("POST", "/relay/inbound", {
    lineId: LINE,
    messages: [
      tapback
        ? { guid: randomUUID(), from: me, sentAt: new Date().toISOString(), tapback: { kind: tapback, targetGuid: lastMellaGuid } }
        : { guid: randomUUID(), from: me, sentAt: new Date().toISOString(), text },
    ],
  });
}

console.log(`Tu écris en tant que ${me}. Commandes : :like :love (réaction), :bank ok|ko (3-D Secure), :as <numéro>, :quit`);
console.log(`Astuce : commence par « Salut Mell ! (k7q2) » comme le ferait le bouton de la page.`);
void outbound();
const rl = createInterface({ input: process.stdin, output: process.stdout });
for await (const line of rl) {
  const t = line.trim();
  if (!t) continue;
  try {
    if (t === ":quit") break;
    else if (t.startsWith(":as ")) {
      me = t.slice(4).trim();
      console.log(`Tu es maintenant ${me}.`);
    } else if (t.startsWith(":bank")) {
      if (!app) {
        console.log("Disponible seulement avec le serveur en processus.");
        continue;
      }
      const task = (await app.db.query(`SELECT id FROM tasks WHERE status = 'awaiting_bank' ORDER BY created_at DESC LIMIT 1`)).rows[0];
      if (!task) console.log("Aucun paiement en attente de la banque.");
      else await call("POST", `/admin/tasks/${task.id}/bank`, { approved: !/ko|non|refus/i.test(t) }, true);
    } else if (/^:(like|love|laugh|dislike|emphasize|question)$/.test(t)) {
      await say("", t.slice(1));
    } else {
      await say(t);
    }
  } catch (e) {
    console.error("[sim]", (e as Error).message);
  }
}
running = false;
rl.close();
if (env.MELLA_SIM_DEBUG && app) {
  const { rows } = await app.db.query(
    `SELECT class, raw_class, confidence, tapback, source, latency_ms, cost_usd, left(text, 50) AS text FROM router_decisions ORDER BY id`,
  );
  console.table(rows);
}
const t0 = Date.now();
await app?.stop();
if (env.MELLA_SIM_DEBUG) console.log("arrêt en", Date.now() - t0, "ms");
process.exit(0);
