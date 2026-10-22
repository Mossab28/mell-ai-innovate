import type { Db } from "./db.ts";
import type { Llm } from "./llm.ts";
import { costUsd, type Config, type RouteClass } from "./config.ts";
import { ROUTER_SYSTEM } from "./prompt.ts";
import { GOOGLE_ROUTER_HINT } from "./google/prompt.ts";
import { TAPBACKS } from "@mella/shared";
import { decideRoute } from "./decisions.ts";

/**
 * Le routeur décide, pour chaque message, du chemin le moins cher qui suffit :
 *   react : une réaction, sans modèle de réponse
 *   quick : réponse directe d'un petit modèle
 *   tool  : modèle moyen avec outils, synchrone
 *   task  : accusé immédiat, puis travail de fond
 * Chaque décision est journalisée (router_decisions) pour entraîner un classifieur plus tard.
 */

export interface RouteDecision {
  class: RouteClass;
  tapback?: string;
  confidence?: number;
  source: "model" | "rule" | "fallback";
  /** Langue du message, jugée par le modèle de tri (pas une liste de mots). */
  lang?: "fr" | "en";
}

const ORDER: RouteClass[] = ["react", "quick", "tool", "task"];

export function bump(c: RouteClass): RouteClass {
  return ORDER[Math.min(ORDER.indexOf(c) + 1, ORDER.length - 1)];
}

export function parseRoute(text: string | null): { class: RouteClass; tapback?: string; confidence: number } | undefined {
  const json = text?.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return undefined;
  try {
    const r = JSON.parse(json);
    if (!ORDER.includes(r.class)) return undefined;
    const tapback = (TAPBACKS as readonly string[]).includes(r.tapback) ? r.tapback : undefined;
    const confidence = Math.max(0, Math.min(1, Number(r.confidence ?? 0.5)));
    return { class: r.class, tapback, confidence };
  } catch {
    return undefined;
  }
}

export async function route(
  db: Pick<Db, "query">,
  cfg: Config,
  llm: Llm,
  userId: string,
  text: string,
  recent: string,
  forced?: RouteClass,
): Promise<RouteDecision> {
  const started = Date.now();
  let decision: RouteDecision;
  let raw: { class?: string; confidence?: number } = {};
  let usage = { inputTokens: 0, outputTokens: 0 };
  let model: string | null = null;

  // Le plus rapide d'abord : l'API Decisions (≈ 0,27 s). Au moindre souci, le modèle de génération.
  let fast: Awaited<ReturnType<typeof decideRoute>> | undefined;
  if (!forced && cfg.decisions.key) fast = await decideRoute(cfg, text, recent).catch(() => undefined);

  if (forced) {
    decision = { class: forced, source: "rule" };
  } else if (fast) {
    model = cfg.decisions.model;
    raw = { class: fast.class, confidence: fast.confidence };
    usage = { inputTokens: fast.inputTokens, outputTokens: 0 };
    // Pas de « dans le doute, plus lourd » ici : sur le banc, son premier choix est le meilleur (58/60),
    // et sa confiance n'est pas calibrée comme celle d'un modèle de génération.
    let cls = fast.class;
    if (cls === "react" && !fast.tapback) cls = "quick";
    // Sauf pour une réaction seule : un « Yes » hésitant (0,33) après « Je te réserve ? » est resté un 👍 et rien n'a été
    // fait (18/10). Hésitant, il passe en quick, où le juge envoie vers les outils si une action est attendue.
    if (cls === "react" && fast.confidence < 0.5) cls = "quick";
    decision = { class: cls, tapback: fast.tapback, confidence: fast.confidence, source: "model", lang: fast.lang };
  } else {
    model = cfg.models.router;
    try {
      const reply = await llm.chat({
        model,
        purpose: "router",
        maxTokens: 60,
        messages: [
          { role: "system", content: `${ROUTER_SYSTEM}\n${GOOGLE_ROUTER_HINT}` },
          { role: "user", content: `${recent ? `Derniers échanges :\n${recent}\n\n` : ""}Nouveau message :\n${text}` },
        ],
        signal: AbortSignal.timeout(cfg.router.timeoutMs),
      });
      usage = reply.usage;
      const r = parseRoute(reply.text);
      if (!r) throw new Error("réponse du routeur illisible");
      raw = r;
      let cls = r.class;
      if (r.confidence < cfg.router.minConfidence) cls = bump(cls);
      if (cls === "react" && !r.tapback) cls = "quick";
      decision = { class: cls, tapback: r.tapback, confidence: r.confidence, source: "model" };
    } catch {
      // Routeur en panne ou trop lent : on prend le chemin sûr, avec outils.
      decision = { class: "tool", source: "fallback" };
    }
  }

  await db.query(
    `INSERT INTO router_decisions (user_id, text, class, raw_class, confidence, tapback, source, model, latency_ms, input_tokens, output_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      userId,
      text.slice(0, 2000),
      decision.class,
      raw.class ?? null,
      decision.confidence ?? null,
      decision.tapback ?? null,
      decision.source,
      model,
      Date.now() - started,
      usage.inputTokens,
      usage.outputTokens,
      model ? costUsd(cfg, model, usage.inputTokens, usage.outputTokens) : 0,
    ],
  );
  return decision;
}
