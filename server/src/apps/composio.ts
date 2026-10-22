import { toolkitFor, type AppService } from "./catalog.ts";

/**
 * Lien avec Composio (plan d'authentification). La clé du projet et les identifiants Google ne
 * touchent jamais le modèle : les outils ne lui rendent que des données. Repris du connecteur de
 * Murmell Bots (déjà durci), allégé pour Mell.
 *
 * Deux usages :
 *  - l'écran de connexion Composio (déjà validé par Google) : aucun avertissement « appli non vérifiée » ;
 *  - un proxy pour les appels Google REST (gmail, agenda, drive) et un exécuteur d'outils pour le reste.
 */

const API = "https://backend.composio.dev/api/v3.1";
const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const externalId = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(v);
const toolSlug = (v: unknown): v is string => typeof v === "string" && /^[A-Z][A-Z0-9_]{1,199}$/.test(v);
const toolVersion = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(v) && v !== "latest";
const boundedText = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max) : "");
const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

export class ComposioError extends Error {
  constructor(message: string, readonly status?: number, readonly terminal = false) {
    super(message);
    this.name = "ComposioError";
  }
}

/** Seuls les liens de connexion de Composio sont ouverts dans le fil. */
export function isComposioConnectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://connect.composio.dev" && /^\/link\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

async function boundedBody(response: Response, limit = 1_000_000): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit) throw new ComposioError("réponse trop volumineuse");
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) throw new ComposioError("réponse trop volumineuse");
      chunks.push(part.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[tronqué]";
  if (Array.isArray(value)) return value.slice(0, 1000).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 1000)
        .map(([k, v]) => (/authorization|api[_-]?key|token|secret|password|credential/i.test(k) ? [k, "[masqué]"] : [k, redact(v, depth + 1)])),
    );
  return typeof value === "string" ? (value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value) : value;
}

export interface ManagedTool {
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  version: string;
}

export interface ManagedAccount {
  accountId: string;
  authConfigId: string;
  status: "pending" | "active" | "dead";
  scopes: string[];
}

export class Composio {
  readonly #configs = new Map<AppService, Promise<string>>();
  constructor(
    private readonly apiKey: string,
    private readonly http: typeof fetch = fetch,
    private readonly base = API,
  ) {}

  static fromKey(key: string | undefined, http: typeof fetch = fetch, base = API): Composio | undefined {
    const k = key?.trim();
    return k ? new Composio(k, http, base) : undefined;
  }

  async #request(path: string, body?: unknown, signal?: AbortSignal, method?: "DELETE"): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.http(`${this.base}${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        redirect: "error",
        headers: { "x-api-key": this.apiKey, accept: "application/json", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
      });
    } catch {
      throw new ComposioError("service injoignable, réessaie");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new ComposioError(
        response.status === 429 ? "service occupé, réessaie plus tard" : "connexion non vérifiée, reconnecte ou réessaie",
        response.status,
        response.status >= 400 && response.status < 500 && response.status !== 429,
      );
    }
    try {
      return rec(JSON.parse((await boundedBody(response)).toString("utf8")));
    } catch (e) {
      if (e instanceof ComposioError) throw e;
      throw new ComposioError("réponse invalide du service");
    }
  }

  /** Delete only this toolkit connection, without revoking a shared Google grant. */
  async disconnect(accountId: string): Promise<void> {
    if (!externalId(accountId)) throw new ComposioError("compte invalide", undefined, true);
    try {
      const result = await this.#request(`/connected_accounts/${encodeURIComponent(accountId)}`, undefined, undefined, "DELETE");
      if (result.success !== true) throw new ComposioError("suppression du compte non confirmée");
    } catch (e) {
      if (e instanceof ComposioError && e.status === 404) return;
      throw e;
    }
  }

  /** Plan d'authentification géré par Composio, sans scope custom (on garde les droits validés de l'appli Composio). */
  async #config(service: AppService): Promise<string> {
    const found = this.#configs.get(service);
    if (found) return found;
    const pending = (async () => {
      const slug = toolkitFor(service);
      const name = `Mell managed ${slug}`;
      const list = await this.#request(`/auth_configs?toolkit_slug=${slug}&is_composio_managed=true&search=${encodeURIComponent(name)}&limit=50`);
      const existing = (Array.isArray(list.items) ? list.items : [])
        .map(rec)
        .find((it) => it.name === name && it.status === "ENABLED" && it.is_composio_managed === true && rec(it.toolkit).slug === slug);
      if (existing && externalId(existing.id)) return existing.id;
      const created = await this.#request("/auth_configs", { toolkit: { slug }, auth_config: { type: "use_composio_managed_auth", name } });
      const config = rec(created.auth_config);
      if (rec(created.toolkit).slug !== slug || config.is_composio_managed !== true || !externalId(config.id)) throw new ComposioError("connexion gérée indisponible pour cette app");
      return config.id;
    })().catch((e: unknown) => {
      this.#configs.delete(service);
      throw e;
    });
    this.#configs.set(service, pending);
    return pending;
  }

  /** Lien de connexion (écran Composio, déjà validé Google) + l'id du compte à suivre. */
  async authorize(userId: string, service: AppService, callbackUrl?: string): Promise<{ url: string; accountId: string; authConfigId: string; expiresAt: number }> {
    const authConfigId = await this.#config(service);
    // callback_url : où Composio ramène la personne une fois l'autorisation donnée (notre page, puis Messages).
    const link = await this.#request("/connected_accounts/link", { auth_config_id: authConfigId, user_id: userId, ...(callbackUrl ? { callback_url: callbackUrl } : {}) });
    const expiresAt = typeof link.expires_at === "string" ? Date.parse(link.expires_at) : NaN;
    if (!externalId(link.connected_account_id) || typeof link.redirect_url !== "string" || !isComposioConnectUrl(link.redirect_url) || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
      throw new ComposioError("lien de connexion impossible, réessaie");
    return { url: link.redirect_url, accountId: link.connected_account_id, authConfigId, expiresAt: Math.min(expiresAt, Date.now() + 10 * 60_000) };
  }

  /** État d'un compte connecté. `scopes` = droits accordés (jamais demandés : un consentement partiel ne devient pas une écriture). */
  async account(userId: string, service: AppService, accountId: string, authConfigId: string): Promise<ManagedAccount> {
    if (!externalId(accountId) || !externalId(authConfigId)) throw new ComposioError("compte invalide", undefined, true);
    const data = await this.#request(`/connected_accounts/${accountId}`);
    const config = rec(data.auth_config);
    if (data.id !== accountId || data.user_id !== userId || rec(data.toolkit).slug !== toolkitFor(service) || config.id !== authConfigId || config.is_composio_managed !== true)
      throw new ComposioError("le compte ne correspond pas", undefined, true);
    const dead = ["FAILED", "EXPIRED", "REVOKED"].includes(String(data.status)) || data.is_disabled === true || config.is_disabled === true;
    const granted = rec(rec(data.state).val).scope ?? rec(data.data).scope;
    const scopes = typeof granted === "string" ? granted.split(/[\s,]+/).filter(Boolean) : Array.isArray(granted) && granted.every((v) => typeof v === "string") ? (granted as string[]) : [];
    return { accountId, authConfigId, status: dead ? "dead" : data.status === "ACTIVE" ? "active" : "pending", scopes };
  }

  /** Identité du compte (adresse mail pour Google), pour la dire à la personne. */
  async login(accountId: string, service: AppService): Promise<string> {
    if (service !== "gmail" && service !== "calendar" && service !== "drive" && service !== "sheets") return `${service} · ${accountId.slice(-8)}`;
    const endpoint =
      service === "gmail"
        ? "https://gmail.googleapis.com/gmail/v1/users/me/profile"
        : service === "calendar"
          ? "https://www.googleapis.com/calendar/v3/calendars/primary"
          : "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)";
    const res = await this.transport(accountId, service)(endpoint);
    if (!res.ok) throw new ComposioError("compte non vérifiable", res.status, res.status >= 400 && res.status < 500 && res.status !== 429);
    const data = rec(await res.json());
    const login = service === "gmail" ? data.emailAddress : service === "calendar" ? data.id : rec(data.user).emailAddress;
    if (typeof login !== "string" || !login || login.length > 254 || /[\x00-\x1f]/.test(login)) throw new ComposioError("identité invalide", undefined, true);
    return login;
  }

  #managedTool(value: unknown, service: AppService, requestedVersion?: string): ManagedTool {
    const raw = rec(value);
    const toolkit = rec(raw.toolkit);
    const tags = Array.isArray(raw.tags) ? raw.tags : [];
    const schema = rec(raw.input_parameters);
    if (!toolSlug(raw.slug) || toolkit.slug !== toolkitFor(service) || !toolVersion(raw.version) || (requestedVersion !== undefined && raw.version !== requestedVersion))
      throw new ComposioError("outil indisponible pour ce service", undefined, true);
    if (jsonBytes(schema) > 128_000) throw new ComposioError("définition d'outil trop grande", undefined, true);
    if (tags.includes("destructiveHint")) throw new ComposioError("outil destructeur indisponible", undefined, true);
    return { slug: raw.slug, version: raw.version as string, name: boundedText(raw.name, 200) || (raw.slug as string), description: boundedText(raw.description, 2_000), inputSchema: schema, readOnly: tags.includes("readOnlyHint") };
  }

  /** Les outils d'un service (catalogue public), au plus 8, filtrés par `query`. */
  async tools(service: AppService, query?: string): Promise<ManagedTool[]> {
    const params = new URLSearchParams({ toolkit_slug: toolkitFor(service), limit: "8" });
    if (query?.trim()) params.set("search", query.trim().slice(0, 200));
    const result = await this.#request(`/tools?${params}`);
    const items = Array.isArray(result.items) ? result.items : [];
    const tools: ManagedTool[] = [];
    for (const item of items.slice(0, 8)) {
      try {
        const t = this.#managedTool(item, service);
        if (jsonBytes([...tools, t]) > 24_000) break;
        tools.push(t);
      } catch {
        /* entrée incompatible : non exposée */
      }
    }
    return tools;
  }

  async tool(service: AppService, slug: string, version?: string): Promise<ManagedTool> {
    if (!toolSlug(slug) || (version !== undefined && !toolVersion(version))) throw new ComposioError("demande d'outil invalide", undefined, true);
    const suffix = version === undefined ? "" : `?version=${encodeURIComponent(version)}`;
    const found = this.#managedTool(await this.#request(`/tools/${encodeURIComponent(slug)}${suffix}`), service, version);
    if (found.slug !== slug) throw new ComposioError("outil indisponible pour ce service", undefined, true);
    return found;
  }

  /** Exécute un outil. Une écriture exige `writeApproved` (une tâche validée). */
  async executeTool(accountId: string, service: AppService, slug: string, args: Record<string, unknown>, options: { writeApproved?: boolean } = {}): Promise<string> {
    if (!externalId(accountId) || !toolSlug(slug)) throw new ComposioError("appel d'outil invalide", undefined, true);
    const tool = await this.tool(service, slug);
    if (!tool.readOnly && options.writeApproved !== true) throw new ComposioError("cet outil écrit : il faut l'accord de la personne (une tâche validée)", undefined, true);
    if (jsonBytes(args) > 256_000) throw new ComposioError("arguments trop grands", undefined, true);
    const result = await this.#request(`/tools/execute/${encodeURIComponent(tool.slug)}`, { connected_account_id: accountId, arguments: args, version: tool.version });
    // Composio rend un 200 même sur échec d'outil : une écriture n'est actée que si le service confirme le succès.
    if (result.successful !== true || (typeof result.error === "string" && result.error.trim() !== "")) throw new ComposioError("le service n'a pas pu faire cette action");
    let output: string;
    try {
      output = JSON.stringify(redact(result.data ?? result));
    } catch {
      throw new ComposioError("réponse invalide du service");
    }
    return output.length <= 10_000 ? output : `${output.slice(0, 9_970)}…[tronqué]`;
  }

  /** Proxy pour les appels Google REST (gmail, agenda, drive, sheets) : même URL que l'API, passée par Composio. */
  transport(accountId: string, service: AppService): typeof fetch {
    return async (input, init) => {
      if (service !== "gmail" && service !== "calendar" && service !== "drive" && service !== "sheets") throw new ComposioError("proxy réservé aux services Google", undefined, true);
      if (input instanceof Request) throw new ComposioError("Request non supporté");
      const url = new URL(String(input));
      const host = url.host;
      const okHost =
        service === "gmail"
          ? host === "gmail.googleapis.com"
          : host === "www.googleapis.com" || host === "sheets.googleapis.com" || host === "calendar.googleapis.com";
      const method = init?.method ?? "GET";
      if (url.protocol !== "https:" || url.username || url.password || url.hash || !okHost || !["GET", "POST", "PATCH", "PUT"].includes(method) || !externalId(accountId))
        throw new ComposioError("requête applicative invalide");
      const headers = new Headers(init?.headers);
      const parameters = [...headers].filter(([n]) => ["accept", "content-type", "if-match", "range"].includes(n)).map(([name, value]) => ({ name, value, type: "header" }));
      const payload: Record<string, unknown> = { connected_account_id: accountId, endpoint: url.href, method, parameters };
      if (init?.body !== undefined) {
        if (typeof init.body !== "string") throw new ComposioError("corps de requête invalide");
        payload.body = JSON.parse(init.body);
      }
      const result = await this.#request("/tools/execute/proxy", payload, (init?.signal as AbortSignal | undefined) ?? undefined);
      const status = Number(result.status);
      if (!Number.isInteger(status) || status < 200 || status > 599) throw new ComposioError("réponse de service non supportée");
      const responseHeaders = new Headers();
      for (const [k, v] of Object.entries(rec(result.headers))) if (["content-type", "etag"].includes(k.toLowerCase()) && typeof v === "string") responseHeaders.set(k, v);
      const bodyOut = [204, 205, 304].includes(status) ? null : typeof result.data === "string" ? result.data : JSON.stringify(result.data ?? {});
      return new Response(bodyOut, { status, headers: responseHeaders });
    };
  }
}
