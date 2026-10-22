/** Toute la configuration passe par l'environnement. Aucune clé dans le code. */

export type RouteClass = "react" | "quick" | "tool" | "task";

export interface ModelPrice {
  /** Dollars par million de jetons. */
  input: number;
  output: number;
}

export interface Config {
  port: number;
  logLevel: string;
  databaseUrl?: string;
  /** Jeton des routes d'admin (création de lignes, résultat 3-D Secure en dev). */
  adminToken?: string;
  /** Numéros dont la session web ouvre /admin (MELLA_ADMIN_HANDLES=+336...,+337...). */
  adminHandles: string[];
  /** Lignes à créer au démarrage : `id|handle|secret;id2|handle2|secret2`. */
  seedLines?: string;
  /**
   * `bedrock` : Bedrock, ou l'API Anthropic pour un ID nu (`claude-...`) ; `openai` : tout serveur compatible
   * OpenAI (vLLM pour un modèle ouvert) ; `fake` pour le simulateur et les tests sans réseau.
   */
  llm: "bedrock" | "openai" | "fake";
  /** Serveur compatible OpenAI (MELLA_LLM=openai) : adresse en /v1, clé facultative, réflexion du modèle. */
  openai: { base: string; key?: string; thinking: boolean; effort?: string };
  /**
   * Réaction d'accusé quand une demande part en travail de fond. Instinct pose 👀 ; BlueBubbles ne pose
   * que les six réactions classiques tant qu'il n'est pas modifié : 👍 par défaut, 👀 une fois l'emoji ouvert.
   */
  ackTapback: string;
  /** Adresse publique des pages en direct (connexion en direct) : flux d'images, sans tampon entre deux. */
  liveUrl: string;
  /** Tri des messages par l'API Decisions d'OpenAI quand la clé est là ; repli sur `models.router` sinon. */
  decisions: { key?: string; model: string; base: string; timeoutMs: number };
  /** Transcription des vocaux sur notre machine (whisper.cpp). Sans modèle, Mell dit qu'il n'a pas pu écouter. */
  whisper: { bin: string; model?: string };
  bedrockRegion: string;
  /** Régions en plus pour répartir les appels (quota par région). */
  bedrockRegions: string[];
  /** Autoriser les profils `global.` (traitement possible hors d'Europe). Banc d'essai seulement. */
  bedrockGlobal: boolean;
  /** Clé de l'API Anthropic : seulement si un MELLA_MODEL_* vaut un ID nu (`claude-haiku-5-5`). */
  anthropicApiKey?: string;
  /**
   * Moteur de web_search : « anthropic » (la recherche serveur de l'API, lue par un modèle Claude) ou « searxng » (notre
   * SearXNG, MELLA_SEARXNG_URL : des résultats bruts que le modèle de Mell lit lui-même, sans second modèle ; pour le
   * modèle ouvert). Par défaut anthropic quand une clé existe, sinon searxng quand l'adresse est donnée. `model`
   * (MELLA_SEARCH_MODEL) : le Claude qui fait la recherche anthropic ; par défaut celui de Mell s'il est un Claude, sinon
   * Haiku : avec le modèle ouvert, un peu de crédit Anthropic sert seulement à chercher (décision du 20/10).
   */
  search: { provider?: "anthropic" | "searxng"; searxngUrl?: string; model?: string };
  models: {
    router: string;
    quick: string;
    tool: string;
    task: string;
    /** Pour les travaux lourds, à brancher quand le routeur saura les distinguer. */
    heavy: string;
    batch: string;
    /** La veille (pulse.ts) : décider seul s'il faut écrire en premier. Un jugement, donc Sonnet. */
    pulse: string;
    /** Navigateur : le plan et les reprises après échec (Sonnet), puis chaque étape (Haiku). */
    browserPlan: string;
    browserStep: string;
  };
  /** Prix indicatifs pour estimer le coût de chaque décision. À recaler sur la grille Bedrock. */
  prices: Record<string, ModelPrice>;
  router: {
    /** Sous ce seuil de confiance, on monte d'un cran (quick -> tool, react -> quick). */
    minConfidence: number;
    timeoutMs: number;
  };
  /** Délai avant l'accusé de réception (tapback) quand une réponse synchrone tarde. */
  ackAfterMs: number;
  /** Attente après le dernier message reçu avant de répondre : les gens écrivent en plusieurs bulles. */
  debounceMs: number;
  /** Durée de validité d'une autorisation de tâche. */
  taskAuthorizationHours: number;
  /** Accès sur invitation : sans code valable dans le premier message, la personne attend sur la liste. */
  invites: { only: boolean; perUser: number };
  /** Avance avec laquelle un brief est préparé avant son heure d'envoi. */
  briefPrepareMinutes: number;
  /** Un rappel ponctuel est rédigé par le modèle en avance, avec le fil depuis sa création, et part à l'heure pile. */
  reminderPrepareMinutes: number;
  /** La veille trois fois par jour (pulse.ts). MELLA_PULSE=0 la coupe. */
  pulse: boolean;
  /** Adresse publique du serveur : base des liens envoyés dans le fil (saisie au coffre). */
  publicUrl: string;
  /** Coffre : OpenBao (MELLA_VAULT_ADDR + MELLA_VAULT_TOKEN), ou mémoire pour les tests et le simulateur. */
  vault: { backend: "openbao" | "memory"; addr?: string; token?: string };
  /** Navigateur des tâches : plafonds par tâche et clé de chiffrement des profils (32 octets en base64). */
  browser: { enabled: boolean; maxSteps: number; maxMs: number; maxCostUsd: number; idleMs: number; profileKey?: string };
  /**
   * Client OAuth Google (Gmail + Agenda). Sans identifiant ni secret ici, le serveur les cherche au
   * coffre (mella-kv/data/server/google-oauth) ; sans rien nulle part, la connexion est simplement
   * indisponible. `endpoints` : adresses de Google, remplacées par un faux Google dans les tests.
   */
  google: { clientId?: string; clientSecret?: string; endpoints: GoogleEndpoints; redirectBase?: string };
  /**
   * Adresse mail propre à chaque personne (copie, transfert, boîte qui fait suivre). `domains` : le premier
   * est celui qu'on donne, les suivants restent acceptés (ancien domaine). Sans domaine, rien n'est proposé ;
   * `port` 0 : pas de serveur de réception (tests, simulateur).
   */
  mail: { domains: string[]; port: number; hostname: string; from?: string; azureConnectionString?: string };
  /** Clé du projet Composio (connecteurs d'applications). Absente : les connecteurs sont indisponibles. */
  composioApiKey?: string;
}

export interface GoogleEndpoints {
  auth: string;
  token: string;
  revoke: string;
  gmail: string;
  calendar: string;
}

/** MELLA_GOOGLE_ENDPOINTS=http://127.0.0.1:port : tout Google servi par un seul faux serveur (tests). */
function googleEndpoints(base?: string): GoogleEndpoints {
  if (base) {
    const b = base.replace(/\/+$/, "");
    return { auth: `${b}/o/oauth2/v2/auth`, token: `${b}/token`, revoke: `${b}/revoke`, gmail: `${b}/gmail/v1`, calendar: `${b}/calendar/v3` };
  }
  return {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    revoke: "https://oauth2.googleapis.com/revoke",
    gmail: "https://gmail.googleapis.com/gmail/v1",
    calendar: "https://www.googleapis.com/calendar/v3",
  };
}

/**
 * Modèles par défaut : ceux réellement ouverts au compte AWS le 14/10/2026 (profils d'inférence UE).
 * Les Claude 5 et 5.5 répondent « not available for this account » tant que l'accès n'est pas
 * accordé dans Bedrock ; il suffira alors de les passer par MELLA_MODEL_* :
 *   global.anthropic.claude-haiku-5-5, eu.anthropic.claude-sonnet-5-5, global.anthropic.claude-opus-5-5
 * En attendant, un ID nu passe par l'API Anthropic directe (ANTHROPIC_API_KEY), réflexion coupée
 * pour Haiku 5.5 : MELLA_MODEL_QUICK=claude-haiku-5-5. Banc de voix : infra/voice/RESULTATS.md.
 */
const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const SONNET = "eu.anthropic.claude-sonnet-4-6";
const OPUS = "eu.anthropic.claude-opus-4-5-20251101-v1:0";
/** Validé le 16/10 : Haiku 5.5 partout sauf le travail de fond (banc de voix), 0,70 $ par personne et par mois au lieu de 3,50 $. */
const HAIKU55 = "claude-haiku-5-5";
/** Derniers modèles (17/10, sa demande « utilise les derniers modèles ») : par l'API Anthropic, Bedrock ne les ouvre pas au compte. */
const SONNET55 = "claude-sonnet-5-5";
const OPUS55 = "claude-opus-5-5";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Haiku 5.5 passe par l'API Anthropic tant que Bedrock ne l'ouvre pas au compte : sans clé, on reste sur Bedrock.
  const strong = env.ANTHROPIC_API_KEY ? SONNET55 : SONNET;
  // Un seul modèle pour tout Mell (sa décision du 19/10) : l'agent, la bulle d'avancement, les rappels, la veille et le
  // navigateur. Des modèles différents ne se parlent pas, et leurs réponses se contredisaient dans le fil. Chaque rôle
  // reste réglable par MELLA_MODEL_* pour un banc.
  const one = env.MELLA_MODEL ?? strong;
  const models = {
    router: env.MELLA_MODEL_ROUTER ?? one,
    quick: env.MELLA_MODEL_QUICK ?? one,
    tool: env.MELLA_MODEL_TOOL ?? one,
    task: env.MELLA_MODEL_TASK ?? one,
    heavy: env.MELLA_MODEL_HEAVY ?? one,
    batch: env.MELLA_MODEL_BATCH ?? one,
    pulse: env.MELLA_MODEL_PULSE ?? one,
    browserPlan: env.MELLA_MODEL_BROWSER_PLAN ?? one,
    browserStep: env.MELLA_MODEL_BROWSER_STEP ?? one,
  };

  const prices: Record<string, ModelPrice> = {
    [HAIKU]: { input: 1, output: 5 },
    [SONNET]: { input: 3, output: 15 },
    [OPUS]: { input: 5, output: 25 },
    "global.anthropic.claude-haiku-5-5": { input: 1, output: 5 },
    "eu.anthropic.claude-sonnet-5-5": { input: 3, output: 15 },
    "global.anthropic.claude-opus-5-5": { input: 5, output: 25 },
    "gpt-6-luna": { input: 0.1, output: 0 },
    // API Anthropic directe (prompts de moins de 100 000 jetons).
    "claude-haiku-5-5": { input: 0.1, output: 0.5 },
    [SONNET55]: { input: 2, output: 10 },
    [OPUS55]: { input: 4, output: 20 },
    ...(env.MELLA_PRICES ? JSON.parse(env.MELLA_PRICES) : {}),
  };
  return {
    port: Number(env.PORT ?? 8787),
    logLevel: env.LOG_LEVEL ?? "info",
    databaseUrl: env.DATABASE_URL,
    adminToken: env.MELLA_ADMIN_TOKEN,
    adminHandles: (env.MELLA_ADMIN_HANDLES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    seedLines: env.MELLA_SEED_LINES,
    llm: env.MELLA_LLM === "fake" ? "fake" : env.MELLA_LLM === "openai" ? "openai" : "bedrock",
    openai: {
      base: (env.MELLA_OPENAI_BASE ?? "http://127.0.0.1:8000/v1").replace(/\/+$/, ""),
      key: env.MELLA_OPENAI_KEY || undefined,
      thinking: env.MELLA_OPENAI_THINKING === "1",
      effort: env.MELLA_OPENAI_EFFORT || undefined,
    },
    whisper: { bin: env.MELLA_WHISPER_BIN ?? "whisper-cli", model: env.MELLA_WHISPER_MODEL || undefined },
    ackTapback: env.MELLA_ACK_TAPBACK ?? "like",
    liveUrl: env.MELLA_LIVE_URL ?? env.MELLA_PUBLIC_URL ?? "http://localhost:8787",
    decisions: {
      key: env.MELLA_DECISIONS === "off" ? undefined : env.OPENAI_API_KEY || undefined,
      model: env.MELLA_DECISIONS_MODEL ?? "gpt-6-luna",
      base: env.MELLA_DECISIONS_BASE ?? "https://api.openai.com/v1",
      timeoutMs: Number(env.MELLA_DECISIONS_TIMEOUT_MS ?? 1500),
    },
    bedrockRegion: env.MELLA_BEDROCK_REGION ?? "eu-west-3",
    bedrockRegions: (env.MELLA_BEDROCK_REGIONS ?? "eu-west-3,eu-west-1").split(",").map((r) => r.trim()).filter(Boolean),
    bedrockGlobal: env.MELLA_BEDROCK_GLOBAL === "1",
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    search: {
      provider: env.MELLA_SEARCH === "searxng" || env.MELLA_SEARCH === "anthropic" ? env.MELLA_SEARCH : env.ANTHROPIC_API_KEY ? "anthropic" : env.MELLA_SEARXNG_URL ? "searxng" : undefined,
      searxngUrl: env.MELLA_SEARXNG_URL || undefined,
      model: env.MELLA_SEARCH_MODEL || undefined,
    },
    models,
    prices,
    router: {
      minConfidence: Number(env.MELLA_ROUTER_MIN_CONFIDENCE ?? 0.6),
      timeoutMs: Number(env.MELLA_ROUTER_TIMEOUT_MS ?? 4000),
    },
    ackAfterMs: Number(env.MELLA_ACK_AFTER_MS ?? 6000),
    debounceMs: Number(env.MELLA_DEBOUNCE_MS ?? 500),
    taskAuthorizationHours: Number(env.MELLA_TASK_AUTH_HOURS ?? 24),
    invites: { only: env.MELLA_INVITE_ONLY === "1", perUser: Number(env.MELLA_INVITES_PER_USER ?? 5) },
    briefPrepareMinutes: Number(env.MELLA_BRIEF_PREPARE_MINUTES ?? 30),
    reminderPrepareMinutes: Number(env.MELLA_REMINDER_PREPARE_MINUTES ?? 10),
    pulse: env.MELLA_PULSE !== "0",
    publicUrl: env.MELLA_PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8787}`,
    vault: {
      backend: (env.MELLA_VAULT ?? (env.MELLA_VAULT_ADDR ? "openbao" : "memory")) === "openbao" ? "openbao" : "memory",
      addr: env.MELLA_VAULT_ADDR,
      token: env.MELLA_VAULT_TOKEN,
    },
    browser: {
      enabled: env.MELLA_BROWSER !== "0",
      maxSteps: Number(env.MELLA_BROWSER_MAX_STEPS ?? 40),
      maxMs: Number(env.MELLA_BROWSER_MAX_MS ?? 6 * 60_000),
      maxCostUsd: Number(env.MELLA_BROWSER_MAX_COST_USD ?? 0.6),
      idleMs: Number(env.MELLA_BROWSER_IDLE_MS ?? 10 * 60_000),
      profileKey: env.MELLA_BROWSER_KEY,
    },
    google: {
      clientId: env.MELLA_GOOGLE_CLIENT_ID || undefined,
      clientSecret: env.MELLA_GOOGLE_CLIENT_SECRET || undefined,
      endpoints: googleEndpoints(env.MELLA_GOOGLE_ENDPOINTS),
      redirectBase: env.MELLA_GOOGLE_REDIRECT_BASE || undefined,
    },
    composioApiKey: env.MELLA_COMPOSIO_API_KEY || env.COMPOSIO_API_KEY || undefined,
    mail: {
      domains: (env.MELLA_MAIL_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean),
      port: Number(env.MELLA_MAIL_PORT ?? 0),
      hostname: env.MELLA_MAIL_HOSTNAME || (env.MELLA_MAIL_DOMAINS ?? "").split(",")[0]?.trim() || "localhost",
      from: env.MELLA_MAIL_FROM?.trim() || undefined,
      azureConnectionString: env.MELLA_AZURE_EMAIL_CONNECTION_STRING || undefined,
    },
  };
}

/** Coût d'un appel avec le cache du prompt : lecture à 10 % du prix d'entrée, écriture à 125 %. */
export function usageCostUsd(
  cfg: Pick<Config, "prices">,
  model: string,
  u: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): number {
  const p = cfg.prices[model];
  if (!p) return 0;
  return (u.inputTokens * p.input + u.outputTokens * p.output + (u.cacheReadTokens ?? 0) * p.input * 0.1 + (u.cacheWriteTokens ?? 0) * p.input * 1.25) / 1_000_000;
}

export function costUsd(cfg: Config, model: string, inputTokens: number, outputTokens: number): number {
  const p = cfg.prices[model];
  if (!p) return 0;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
