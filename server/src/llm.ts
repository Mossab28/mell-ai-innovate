import { BedrockRuntimeClient, ConverseCommand, type Message, type ContentBlock, type SystemContentBlock } from "@aws-sdk/client-bedrock-runtime";
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.ts";
import { CACHE_BREAK } from "./prompt.ts";

/** Format de conversation interne (calqué sur les chat completions, converti par chaque fournisseur). */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: ChatImage[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** Capture jointe à un message (navigateur). */
export interface ChatImage {
  format: "jpeg" | "png";
  bytes: Uint8Array;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Jetons lus ou écrits dans le cache du prompt (facturés à part). */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Temps perdu à attendre le quota (refus et attentes) avant la réponse, en ms. */
  queueMs?: number;
}

export interface LlmReply {
  text: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
}

export interface ChatInput {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  /** À quoi sert l'appel (router, quick, tool, task, batch). Sert aux journaux et au modèle factice. */
  purpose?: string;
  /** `any` oblige le modèle à appeler un outil (boucle du navigateur). */
  toolChoice?: "auto" | "any";
  signal?: AbortSignal;
}

/** Le seul point de contact avec un modèle. Changer de fournisseur = une autre implémentation. */
export interface Llm {
  chat(input: ChatInput): Promise<LlmReply>;
}

/**
 * AWS Bedrock, API Converse (tool use). Identifiants : chaîne AWS standard (AWS_PROFILE, rôle...).
 *
 * Le quota par défaut d'un compte est de 10 requêtes par minute et par région pour Haiku 4.5 et
 * Sonnet 4.6 : une seule tâche web en consomme autant. Les appels tournent donc sur plusieurs
 * régions (MELLA_BEDROCK_REGIONS, profils `eu.` : les données restent en Europe) et, si on
 * l'autorise (MELLA_BEDROCK_GLOBAL=1), sur les profils `global.`. Un refus pour quota passe tout
 * de suite à la route suivante ; une route refusée (accès, modèle absent) est mise de côté 10 min.
 */
export class BedrockLlm implements Llm {
  private readonly clients = new Map<string, BedrockRuntimeClient>();
  private readonly regions: string[];
  private readonly dead = new Map<string, number>();
  private turn = 0;

  constructor(
    region: string,
    private readonly opts: { regions?: string[]; global?: boolean } = {},
  ) {
    this.regions = [...new Set([region, ...(opts.regions ?? [])])];
  }

  private client(region: string): BedrockRuntimeClient {
    let c = this.clients.get(region);
    if (!c) {
      c = new BedrockRuntimeClient({ region, maxAttempts: this.regions.length > 1 ? 1 : 6, retryMode: "adaptive" });
      this.clients.set(region, c);
    }
    return c;
  }

  /** Routes possibles pour un modèle : chaque région, avec le profil `global.` en plus si permis. */
  private routes(model: string): Array<{ region: string; model: string }> {
    // Région hors d'Europe (us-*) : seulement si on accepte un traitement hors d'Europe, avec son profil `us.`.
    const all = this.regions.flatMap((region) => {
      const ids = region.startsWith("eu-") ? [model] : this.opts.global && /^eu\./.test(model) ? [model.replace(/^eu\./, "us.")] : [];
      if (this.opts.global && /^eu\./.test(model)) ids.push(model.replace(/^eu\./, "global."));
      return ids.map((m) => ({ region, model: m }));
    });
    const t = Date.now();
    const alive = all.filter((r) => (this.dead.get(`${r.region}|${r.model}`) ?? 0) < t);
    const list = alive.length ? alive : all;
    const start = this.turn++ % list.length;
    return [...list.slice(start), ...list.slice(0, start)];
  }

  async chat(input: ChatInput): Promise<LlmReply> {
    const routes = this.routes(input.model);
    const t0 = Date.now();
    let last: unknown;
    for (let round = 0; round < 6; round++) {
      for (const r of routes) {
        const t = Date.now();
        try {
          const out = await this.send(r.region, { ...input, model: r.model });
          out.usage.queueMs = t - t0;
          return out;
        } catch (e: any) {
          last = e;
          const name = String(e?.name ?? "");
          if (input.signal?.aborted) throw e;
          if (/AccessDenied|ResourceNotFound|ValidationException.*(model|inference profile)/i.test(`${name} ${e?.message ?? ""}`) && routes.length > 1) {
            this.dead.set(`${r.region}|${r.model}`, Date.now() + 10 * 60_000);
            continue;
          }
          if (!/Throttling|TooManyRequests|ServiceUnavailable|ModelNotReady|InternalServer/i.test(name)) throw e;
        }
      }
      // Toutes les routes au quota : on attend un peu, de plus en plus.
      await new Promise((res) => setTimeout(res, Math.min(20_000, 1500 * 2 ** round) + Math.random() * 500));
    }
    throw last;
  }

  private async send(region: string, { model, messages, tools, maxTokens, signal, toolChoice }: ChatInput): Promise<LlmReply> {
    // Partie fixe du prompt (et définitions d'outils) mise en cache chez Bedrock : moins de latence au premier jeton.
    const system: SystemContentBlock[] = [];
    for (const m of messages.filter((m) => m.role === "system")) {
      const [fixed, ...rest] = String(m.content).split(CACHE_BREAK);
      system.push({ text: fixed });
      if (rest.length) system.push({ cachePoint: { type: "default" } }, { text: rest.join("\n\n") });
    }
    const out = await this.client(region).send(
      new ConverseCommand({
        modelId: model,
        system,
        messages: toBedrockMessages(messages),
        inferenceConfig: { maxTokens: maxTokens ?? 1024 },
        toolConfig: tools?.length
          ? {
              tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters as any } } })),
              toolChoice: toolChoice === "any" ? { any: {} } : undefined,
            }
          : undefined,
      }),
      { abortSignal: signal },
    );
    const blocks = out.output?.message?.content ?? [];
    const text = blocks.map((b) => b.text ?? "").join("").trim() || null;
    const toolCalls: ToolCall[] = blocks
      .filter((b) => b.toolUse)
      .map((b) => ({
        id: b.toolUse!.toolUseId!,
        type: "function",
        function: { name: b.toolUse!.name!, arguments: JSON.stringify(b.toolUse!.input ?? {}) },
      }));
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: out.usage?.inputTokens ?? 0,
        outputTokens: out.usage?.outputTokens ?? 0,
        cacheReadTokens: out.usage?.cacheReadInputTokens ?? 0,
        cacheWriteTokens: out.usage?.cacheWriteInputTokens ?? 0,
      },
    };
  }
}

/**
 * Bedrock veut des tours alternés user/assistant : les résultats d'outils consécutifs sont
 * regroupés dans un seul tour user, et deux tours user de suite sont fusionnés.
 */
export function toBedrockMessages(messages: ChatMessage[], edges: { start?: boolean; end?: boolean } = {}): Message[] {
  const out: Message[] = [];
  const push = (role: "user" | "assistant", blocks: ContentBlock[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content!.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      const blocks: ContentBlock[] = (m.images ?? []).map((img) => ({ image: { format: img.format, source: { bytes: img.bytes } } }) as ContentBlock);
      push("user", [...blocks, { text: m.content || " " }]);
    }
    else if (m.role === "tool") push("user", [{ toolResult: { toolUseId: m.tool_call_id, content: [{ text: m.content }] } }]);
    else if (m.role === "assistant") {
      const blocks: ContentBlock[] = [];
      if (m.content) blocks.push({ text: m.content });
      for (const c of m.tool_calls ?? []) {
        blocks.push({ toolUse: { toolUseId: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || "{}") } });
      }
      push("assistant", blocks.length ? blocks : [{ text: " " }]);
    }
  }
  // La conversation doit commencer par l'utilisateur.
  if (edges.start !== false && out[0]?.role === "assistant") out.unshift({ role: "user", content: [{ text: "(début de conversation)" }] });
  // Et elle doit finir par lui : les modèles récents refusent une conversation qui finit par l'assistant
  // (refus du 16/10 à 16 h 35, qui a retardé un « appelle-moi » de trois minutes).
  if (edges.end !== false && out[out.length - 1]?.role === "assistant") out.push({ role: "user", content: [{ text: "(à toi de répondre)" }] });
  return out;
}

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

/**
 * Modèle factice, sans réseau, pour le simulateur et les tests sans accès Bedrock.
 * Il comprend quelques tournures (rappel, mémoire, achat, brief) et sert à faire tourner
 * la plomberie de bout en bout. Il ne juge rien : ce n'est pas un modèle.
 */
export class FakeLlm implements Llm {
  private seq = 0;

  async chat({ messages, purpose }: ChatInput): Promise<LlmReply> {
    const last = messages[messages.length - 1];
    const userText = String([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
    const text = userText.split("\n").filter((l) => l.trim()).pop() ?? "";

    if (purpose === "router") return { text: JSON.stringify(fakeRoute(text)), toolCalls: [], usage: NO_USAGE };
    // Navigateur factice : ouvre l'adresse citée, lit le titre, rend la main.
    if (purpose === "browser_plan") {
      const url = /https?:\/\/\S+/.exec(userText)?.[0] ?? "https://example.com";
      return { text: JSON.stringify({ start_url: url, plan: ["Ouvrir la page", "Lire son titre"], answer: "le titre de la page" }), toolCalls: [], usage: NO_USAGE };
    }
    if (purpose === "browser_replan") return { text: JSON.stringify({ decision: "stop", reason: "le modèle factice ne sait pas repartir" }), toolCalls: [], usage: NO_USAGE };
    if (purpose === "browser_step") {
      const title = /Titre : (.*)/.exec(userText)?.[1]?.trim();
      return title ? this.call("done", { answer: `La page s'appelle « ${title} ».` }) : this.call("stuck", { reason: "page sans titre" });
    }
    if (purpose === "batch") return { text: "Bonjour ☀️ Rien d'urgent ce matin.\n\nOn regarde ta journée ensemble ?", toolCalls: [], usage: NO_USAGE };
    if (last.role === "tool") {
      // Une tâche qu'il vient de valider sur son oui : l'agent l'exécute dans la foulée.
      const authorized = /"authorized":\{"id":"([0-9a-f-]{36})"/.exec(String(last.content));
      if (authorized) return this.call("perform_step", { task_id: authorized[1], action: "pay", amount_cents: 1999, detail: "paiement simulé" });
      return { text: summarizeTool(last.content), toolCalls: [], usage: NO_USAGE };
    }
    // Un merci : l'agent répond par une réaction seule.
    if (/^(merci|thanks|thank you|thx)\b/i.test(text)) return { text: "[react:love]", toolCalls: [], usage: NO_USAGE };
    // Un oui à la tâche proposée (lue dans le contexte) : il la valide en citant ses mots.
    if (/^(oui|ouais|ok|yes|vas-y|vazy|go)\b/i.test(text)) {
      const system = messages[0]?.role === "system" ? String(messages[0].content) : "";
      const proposed = /([0-9a-f-]{36}): [^\n]* - proposed/.exec(system)?.[1];
      if (proposed) return this.call("authorize_task", { task_id: proposed, her_words: text });
    }

    // Mails : le lien de connexion tant que Google n'est pas connecté (lu dans le contexte), puis la recherche.
    if (MAIL.test(text)) {
      const system = messages[0]?.role === "system" ? messages[0].content : "";
      return /^Gmail connecté( :|\.| \()/m.test(system) ? this.call("gmail_search", { query: "is:unread newer_than:7d" }) : this.call("google_connect_link", { service: "gmail" });
    }

    let m = text.match(/(?:rappelle[- ]moi|remind me)\s+(?:dans|in)\s+(\d+)\s*(?:min|minutes?)\s+(?:de |d'|to )?(.+)/i);
    if (m) {
      const at = new Date(Date.now() + Number(m[1]) * 60_000).toISOString();
      return this.call("set_reminder", { at, message: `Rappel : ${m[2].trim()}` });
    }
    m = text.match(/(?:ajoute|enregistre|add)\s+(?:mon|my)\s+(?:compte|account)\s+(\S+)/i);
    if (m) return this.call("vault_request_link", { kind: "login", site: m[1].replace(/[.!?]$/, "") });
    m = text.match(/(?:retiens que|souviens-toi que|remember that)\s+(.+)/i);
    if (m) return this.call("remember", { fact: m[1].trim() });
    m = text.match(/(?:ach[eè]te|commande|buy)\s+(.+?)(?:\s+(?:pour|max|under)\s+(\d+)\s*(?:€|eur|euros?))?$/i);
    if (m) {
      return this.call("propose_task", {
        title: `Acheter ${m[1].trim()}`,
        actions: ["search_web", "buy", "pay"],
        spend_cap_cents: Number(m[2] ?? 50) * 100,
      });
    }
    // L'agent synchrone passe la main au travail de fond pour ce qui demande un site (chercher, réserver).
    if (purpose === "tool" && /cherche|trouve|regarde|réserve|book/i.test(text)) return this.call("continue_in_background", { request: text });
    const asked = /c'est toi le travail de fond lancé pour cette demande\) : ([\s\S]+)/.exec(userText)?.[1];
    if (purpose === "task" && asked && /(regarde|cherche|trouve|ouvre|look|check)/i.test(asked)) {
      return this.call("browse", { objective: asked.trim(), start_url: /https?:\/\/\S+/.exec(asked)?.[0] });
    }
    const authorized = userText.match(/\[système\] La tâche ([0-9a-f-]{36}) vient d'être autorisée/);
    if (authorized) return this.call("perform_step", { task_id: authorized[1], action: "pay", amount_cents: 1999, detail: "paiement simulé" });
    return { text: "Bien reçu.\n\nAutre chose ?", toolCalls: [], usage: NO_USAGE };
  }

  private call(name: string, args: Record<string, unknown>): LlmReply {
    return { text: null, toolCalls: [{ id: `fake_${++this.seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } }], usage: NO_USAGE };
  }
}

const MAIL = /\b(mails?|inbox|bo[iî]te mail)\b/i;

function fakeRoute(text: string) {
  if (/^(merci|thanks|ok merci|top|parfait)\b/i.test(text)) return { class: "react", tapback: "love", confidence: 0.9 };
  if (MAIL.test(text)) return { class: "tool", confidence: 0.9 };
  if (/ach[eè]te|commande|buy|réserve|book|cherche|trouve|regarde/i.test(text)) return { class: "task", confidence: 0.8 };
  if (/rappel|remind|retiens|souviens|remember|oublie|ajoute mon compte|add my account/i.test(text)) return { class: "tool", confidence: 0.9 };
  return { class: "quick", confidence: 0.7 };
}

function summarizeTool(content: string): string {
  try {
    const r = JSON.parse(content);
    if (r.error) return `Pas pu le faire : ${r.error}`;
    if (r.browse) return r.answer ? `${r.answer}\n\nAutre chose ?` : `J'ai bloqué : ${r.blocked_on ?? "sans raison claire"}.`;
    if (r.reminder) return `C'est noté, je te le rappelle ${r.reminder.when}.`;
    if (r.remembered) return "Noté 👍";
    if (r.connect_link_sent) return "Touche le lien, dis oui à Google, et je regarde ta boîte.";
    if (r.results && typeof r.count === "number") return r.count ? `Tu as ${r.count} mail${r.count > 1 ? "s" : ""} récent${r.count > 1 ? "s" : ""} non lu${r.count > 1 ? "s" : ""}.` : "Rien de neuf dans ta boîte.";
    if (r.link_sent) return "Je m'en sers dès que c'est rangé.";
    if (r.proposed) return `${r.proposed.summary}\n\nJe m'en occupe ?`;
    if (r.decision === "awaiting_bank") return "Paiement lancé. Valide-le dans l'appli de ta banque et je finis.";
    if (r.decision === "needs_approval") return `Ça sort de ce que tu m'as autorisé (${r.reason}). Je continue quand même ?`;
  } catch {}
  return "C'est fait.";
}

/**
 * API Anthropic directe, pour les modèles pas encore ouverts au compte sur Bedrock (Haiku 5.5).
 * Choisie par l'identifiant : un ID nu (`claude-haiku-5-5`) passe ici, un profil Bedrock
 * (`eu.anthropic...`, `global.anthropic...`) reste sur Bedrock. Attention : l'inférence n'a
 * alors plus lieu en Europe chez AWS, mais chez Anthropic.
 */
export class AnthropicLlm implements Llm {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 4 });
  }

  async chat(input: ChatInput): Promise<LlmReply> {
    // Même découpe que Bedrock : la partie fixe (outils compris) est mise en cache.
    // Le prompt système en tête ; une consigne système posée plus loin dans le fil y reste (midSystemOk), sinon elle le rejoint.
    const mid = midSystemOk(input.model);
    const lead = input.messages.findIndex((m) => m.role !== "system");
    const system: Anthropic.TextBlockParam[] = [];
    for (const m of input.messages.filter((m, i) => m.role === "system" && (!mid || lead < 0 || i < lead))) {
      const [fixed, ...rest] = String(m.content).split(CACHE_BREAK);
      system.push(rest.length ? { type: "text", text: fixed, cache_control: { type: "ephemeral" } } : { type: "text", text: fixed });
      if (rest.length) system.push({ type: "text", text: rest.join("\n\n") });
    }
    const tools = input.tools?.length
      ? input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema }))
      : undefined;
    const thinking = thinkingFor(input.model, input.purpose);
    const effort = effortFor(input.model, input.purpose);
    const res = await this.client.messages.create(
      {
        model: input.model,
        max_tokens: input.maxTokens ?? 1024,
        messages: toAnthropicMessages(input.messages, mid),
        ...(system.length ? { system } : {}),
        ...(tools ? { tools, ...(input.toolChoice === "any" && forcedToolChoiceOk(input.model) ? { tool_choice: { type: "any" as const } } : {}) } : {}),
        ...(thinking ? { thinking } : {}),
        ...(effort ? { output_config: { effort } } : {}),
      },
      { signal: input.signal },
    );
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim() || null;
    const toolCalls: ToolCall[] = res.content.flatMap((b) =>
      b.type === "tool_use" ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : [],
    );
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

/** Un ID de modèle nu (`claude-...`) se sert par l'API Anthropic ; un profil Bedrock garde son préfixe. */
export function isAnthropicModel(model: string): boolean {
  return /^claude-/.test(model);
}

/**
 * Réflexion de la famille 5 : active par défaut, elle consomme max_tokens (le JSON du routeur sortait
 * tronqué le 15/10, le juge du banc rendait vide le 17/10). Haiku 5.5 la coupe avec `disabled` ;
 * Sonnet 5.5 refuse `disabled` (400) et la coupe avec `between_tools` ; Opus 5.5 ne la coupe pas.
 * Sonnet 5.5 réfléchit pour l'agent (tours et travaux de fond) : coupée, sa réflexion passait dans la bulle. Rejoué sur
 * ses vrais tours le 21/10 (server/bench/replay.ts), réflexion adaptative à effort réglé + manière d'écrire après le fil :
 * 245 caractères par réponse au lieu de 329, moitié moins de questions. Les autres usages gardent `between_tools`.
 * MELLA_THINKING le change pour un banc.
 */
export function thinkingFor(model: string, purpose?: string): Anthropic.ThinkingConfigParam | undefined {
  if (/^claude-haiku-5/.test(model)) return { type: "disabled" };
  if (/^claude-sonnet-5-5/.test(model)) {
    const mode = process.env.MELLA_THINKING ?? (purpose && Object.hasOwn(AGENT_EFFORT, purpose) ? "adaptive" : "between_tools");
    return mode === "adaptive" ? { type: "adaptive" } : { type: "between_tools" };
  }
  return undefined;
}

/**
 * Effort de Sonnet 5.5 pour l'agent : bas en conversation (la doc d'Anthropic le conseille pour le chat), moyen pour le
 * travail de fond, qui doit aller au bout de plusieurs étapes. MELLA_EFFORT le change pour un banc.
 */
const AGENT_EFFORT: Record<string, Anthropic.OutputConfig["effort"]> = { tool: "low", task: "medium" };
export function effortFor(model: string, purpose?: string): Anthropic.OutputConfig["effort"] | undefined {
  if (process.env.MELLA_EFFORT && /^claude-(haiku|sonnet|opus)-5/.test(model)) return process.env.MELLA_EFFORT as Anthropic.OutputConfig["effort"];
  return /^claude-sonnet-5-5/.test(model) && purpose && Object.hasOwn(AGENT_EFFORT, purpose) ? AGENT_EFFORT[purpose] : undefined;
}

/** Sonnet 5.5 et Opus 5.5 refusent le choix d'outil forcé (400) : on passe en auto, la consigne demande déjà un outil. */
export function forcedToolChoiceOk(model: string): boolean {
  return !/^claude-(sonnet-5-5|opus-5-5|fable)/.test(model);
}

/** Modèles qui lisent une consigne système au milieu du fil (pas Sonnet 5, d'après la doc d'Anthropic). */
export function midSystemOk(model: string): boolean {
  return /^claude-(sonnet-5-5|opus-5|haiku-5-5|fable)/.test(model);
}

/**
 * Messages au format de l'API Anthropic, à partir de la même alternance que Bedrock. `mid` : une consigne système après le
 * premier message garde sa place dans le fil ; sinon elle n'y figure pas (elle a rejoint le prompt système).
 */
export function toAnthropicMessages(messages: ChatMessage[], mid = false): Anthropic.MessageParam[] {
  const lead = messages.findIndex((m) => m.role !== "system");
  const out: Anthropic.MessageParam[] = [];
  let chunk: ChatMessage[] = [];
  const flush = (end: boolean) => {
    if (chunk.length) out.push(...anthropicChunk(chunk, { start: !out.length, end }));
    chunk = [];
  };
  messages.forEach((m, i) => {
    if (m.role !== "system") chunk.push(m);
    else if (mid && lead >= 0 && i > lead) {
      flush(false);
      out.push({ role: "system", content: String(m.content) });
    }
  });
  flush(true);
  return out;
}

function anthropicChunk(messages: ChatMessage[], edges: { start: boolean; end: boolean }): Anthropic.MessageParam[] {
  return toBedrockMessages(messages, edges).map((m) => ({
    role: m.role as "user" | "assistant",
    content: (m.content ?? []).map((b): Anthropic.ContentBlockParam => {
      if (b.image) {
        const bytes = b.image.source?.bytes ?? new Uint8Array();
        return { type: "image", source: { type: "base64", media_type: `image/${b.image.format}` as "image/png" | "image/jpeg", data: Buffer.from(bytes).toString("base64") } };
      }
      if (b.toolUse) return { type: "tool_use", id: b.toolUse.toolUseId!, name: b.toolUse.name!, input: b.toolUse.input ?? {} };
      if (b.toolResult) {
        return { type: "tool_result", tool_use_id: b.toolResult.toolUseId!, content: (b.toolResult.content ?? []).map((c) => ({ type: "text" as const, text: c.text ?? "" })) };
      }
      return { type: "text", text: b.text || " " };
    }),
  }));
}

/**
 * Tout serveur compatible OpenAI (`/v1/chat/completions`) : vLLM qui sert le modèle ouvert de la session d'entraînement,
 * ou un autre fournisseur. Même contrat que les autres : la prod et les bancs partagent ce code. vLLM lancé avec
 * `--enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser qwen3` : la pensée revient à part
 * (`reasoning_content`) et n'entre jamais dans l'historique ; le choix d'outil forcé (`required`) y fonctionne.
 */
export class OpenAiLlm implements Llm {
  constructor(private readonly cfg: Config["openai"]) {}

  async chat(input: ChatInput): Promise<LlmReply> {
    const res = await fetch(`${this.cfg.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.cfg.key ? { authorization: `Bearer ${this.cfg.key}` } : {}) },
      body: JSON.stringify(openAiBody(input, this.cfg)),
      signal: input.signal,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`modèle ${input.model} : ${res.status} ${String(data?.error?.message ?? "").slice(0, 200)}`);
    return parseOpenAi(data);
  }
}

/** ChatInput vers le corps de `/v1/chat/completions` (repris de l'adaptateur du banc d'entraînement). */
export function openAiBody(input: ChatInput, cfg: Pick<Config["openai"], "thinking" | "effort"> & { base?: string }) {
  // Le réglage de pensée du gabarit (Qwen sous vLLM) et max_tokens : l'API officielle d'OpenAI refuse le premier et veut
  // max_completion_tokens à la place du second. vLLM garde exactement le corps des bancs et de l'entraînement.
  const templated = !/^https:\/\/api\.openai\.com\b/.test(cfg.base ?? "");
  return {
    model: input.model,
    ...(templated ? { max_tokens: input.maxTokens ?? 1024 } : { max_completion_tokens: input.maxTokens ?? 1024 }),
    stream: false,
    ...(cfg.effort ? { reasoning_effort: cfg.effort } : {}),
    ...(templated ? { chat_template_kwargs: { enable_thinking: cfg.thinking } } : {}),
    // Le repère de cache sert aux fournisseurs qui le comprennent ; ici le système part d'un seul bloc, en tête (une consigne
    // posée plus loin dans le fil le rejoint : le modèle ouvert garde la forme de ses données d'entraînement).
    messages: [
      ...(input.messages.some((m) => m.role === "system")
        ? [{ role: "system", content: input.messages.filter((m) => m.role === "system").map((m) => String(m.content).split(CACHE_BREAK).join("\n\n")).join("\n\n") }]
        : []),
      ...input.messages.filter((m) => m.role !== "system").map((m) => {
      if (m.role === "user" && m.images?.length) {
        return { role: "user", content: [{ type: "text", text: m.content }, ...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:image/${i.format};base64,${Buffer.from(i.bytes).toString("base64")}` } }))] };
      }
      if (m.role === "assistant") return { role: "assistant", content: m.content, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) };
      if (m.role === "tool") return { role: "tool", content: m.content, tool_call_id: m.tool_call_id };
      return { role: m.role, content: m.content };
    }),
    ],
    ...(input.tools?.length ? { tools: input.tools.map((t) => ({ type: "function", function: t })), tool_choice: input.toolChoice === "any" ? "required" : "auto" } : {}),
  };
}

/** Réponse de `/v1/chat/completions` vers LlmReply. Une pensée restée dans le texte (<think>) est retirée. */
export function parseOpenAi(data: any): LlmReply {
  const m = data?.choices?.[0]?.message;
  if (!m) throw new Error("réponse du modèle illisible");
  const toolCalls: ToolCall[] = (Array.isArray(m.tool_calls) ? m.tool_calls : []).map((c: any) => ({
    id: String(c.id),
    type: "function" as const,
    function: { name: String(c.function?.name ?? ""), arguments: typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}) },
  }));
  const text = typeof m.content === "string" ? m.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || null : null;
  return {
    text,
    toolCalls,
    usage: { inputTokens: Number(data.usage?.prompt_tokens ?? 0), outputTokens: Number(data.usage?.completion_tokens ?? 0), cacheReadTokens: Number(data.usage?.prompt_tokens_details?.cached_tokens ?? 0) },
  };
}

/** Choisit le fournisseur à chaque appel, selon l'identifiant du modèle. */
class RoutedLlm implements Llm {
  constructor(
    private readonly bedrock: Llm,
    private readonly anthropic: Llm | undefined,
  ) {}

  chat(input: ChatInput): Promise<LlmReply> {
    if (!isAnthropicModel(input.model)) return this.bedrock.chat(input);
    if (!this.anthropic) return Promise.reject(new Error(`ANTHROPIC_API_KEY manquante pour ${input.model}`));
    return this.anthropic.chat(input);
  }
}

export function makeLlm(cfg: Config): Llm {
  if (cfg.llm === "openai") return new OpenAiLlm(cfg.openai);
  if (cfg.llm !== "bedrock") return new FakeLlm();
  const bedrock = new BedrockLlm(cfg.bedrockRegion, { regions: cfg.bedrockRegions, global: cfg.bedrockGlobal });
  return new RoutedLlm(bedrock, cfg.anthropicApiKey ? new AnthropicLlm(cfg.anthropicApiKey) : undefined);
}
