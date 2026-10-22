import Anthropic from "@anthropic-ai/sdk";
import { thinkingFor } from "./llm.ts";

/**
 * Recherche web : la recherche serveur de l'API Anthropic, lue par le modèle de Mell qui rend l'essentiel avec ses
 * sources. Sans elle, « 3 restos coréens halal dans le 9e » passait par Google dans le navigateur, se faisait bloquer,
 * et prenait 4 min 30 pour un seul résultat (19/10). Le navigateur reste pour agir sur un site.
 */

export interface WebSearchResult {
  answer: string;
  sources: Array<{ title: string; url: string }>;
}

/** `model` : le modèle de Mell (un seul pour tout). */
export async function webSearch(apiKey: string, model: string, query: string, where: { city?: string | null; timezone?: string }): Promise<WebSearchResult> {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  const res = await client.messages.create(
    {
      model,
      max_tokens: 2000,
      ...(thinkingFor(model) ? { thinking: thinkingFor(model)! } : {}),
      tools: [
        {
          // La variante simple : celle à filtrage dynamique lance du code à chaque recherche (40 s au lieu de 15).
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 4,
          user_location: { type: "approximate", country: "FR", ...(where.city ? { city: where.city } : {}), ...(where.timezone ? { timezone: where.timezone } : {}) },
        },
      ],
      messages: [
        {
          role: "user",
          content: `Nous sommes le ${new Intl.DateTimeFormat("fr-FR", { dateStyle: "full", timeZone: where.timezone ?? "Europe/Paris" }).format(new Date())}. Cherche sur le web et rends ce que tu trouves, factuel et dense : noms, adresses, horaires, prix, dates, notes exactes, avec la source de chaque fait. Ce qui n'est pas trouvé, dis-le en une ligne. Pas de conseil, pas de formule.\n\nRecherche : ${query}`,
        },
      ],
    },
    { signal: AbortSignal.timeout(60_000) },
  );
  // Seulement le texte écrit après la dernière recherche : avant, ce sont ses notes de travail (« je lance plusieurs recherches »).
  const lastResult = res.content.map((b) => b.type).lastIndexOf("web_search_tool_result");
  const answer = res.content.slice(lastResult + 1).map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  const sources: WebSearchResult["sources"] = [];
  for (const b of res.content) {
    if (b.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
    for (const r of b.content) if (r.type === "web_search_result" && sources.length < 8) sources.push({ title: r.title, url: r.url });
  }
  return { answer: answer.slice(0, 4000), sources };
}

/**
 * SearXNG à nous (gratuit, hébergé sur le serveur) : les premiers résultats bruts, titre, site, date et extrait, que le
 * modèle de Mell lit lui-même ; read_url pour le détail d'une page. Rien d'un second modèle.
 */
export async function searxSearch(base: string, query: string, lang = "fr"): Promise<WebSearchResult> {
  const url = new URL("/search", base);
  url.search = new URLSearchParams({ q: query, format: "json", language: lang === "en" ? "en-US" : "fr-FR", safesearch: "0" }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`searxng ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string | null }>;
    answers?: Array<string | { answer?: string }>;
    infoboxes?: Array<{ infobox?: string; content?: string }>;
  };
  const host = (u: string) => {
    try {
      return new URL(u).host.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  const results = (data.results ?? []).filter((r) => r.url && r.title).slice(0, 8);
  const lines = [
    ...(data.answers ?? []).map((a) => (typeof a === "string" ? a : a.answer)).filter(Boolean).map((a) => `Réponse directe : ${a}`),
    ...(data.infoboxes ?? []).slice(0, 1).map((b) => `${b.infobox ?? ""} : ${(b.content ?? "").slice(0, 500)}`),
    ...results.map((r, i) => `${i + 1}. ${r.title} (${host(r.url!)}${r.publishedDate ? `, ${r.publishedDate.slice(0, 10)}` : ""})\n${(r.content ?? "").replace(/\s+/g, " ").slice(0, 400)}\n${r.url}`),
  ];
  return { answer: lines.join("\n\n").slice(0, 6000) || "Aucun résultat.", sources: results.map((r) => ({ title: r.title!, url: r.url! })) };
}
