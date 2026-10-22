import type { ToolSpec } from "./llm.ts";

/**
 * Les appels d'outils tels qu'un modèle les écrit vraiment, réparés d'après le schéma de l'outil (repris de
 * tools/arg_coercion.py de Hermes Agent). Les modèles ouverts écrivent « 42 » pour un entier, « true » pour un booléen,
 * une liste encodée en texte, un JSON dans des ```, une virgule en trop, « functions.remember » pour « remember » :
 * l'appel entier était refusé. La réparation reste prudente : sans lecture univoque, la valeur d'origine est gardée.
 */

/** L'objet d'arguments, ou undefined s'il n'y a vraiment rien de lisible. */
export function parseArgs(raw: string | null | undefined): Record<string, unknown> | undefined {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  const tries = [text];
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) tries.push(fenced[1]);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) tries.push(text.slice(start, end + 1));
  // Une virgule avant la fermeture : JSON la refuse, le modèle voulait dire la même chose.
  for (const t of [...tries]) tries.push(t.replace(/,\s*([}\]])/g, "$1"));
  for (const t of tries) {
    try {
      let v: unknown = JSON.parse(t);
      // Encodé deux fois : « "{\"query\": \"...\"}" ».
      if (typeof v === "string") v = JSON.parse(v);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // essai suivant
    }
  }
  return undefined;
}

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; items?: Schema; enum?: unknown[] };

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);

function fits(v: unknown, types: string[]): boolean {
  const t = typeOf(v);
  return types.includes(t) || (t === "integer" && types.includes("number"));
}

function coerceValue(v: unknown, p: Schema): unknown {
  const types = (Array.isArray(p.type) ? p.type : p.type ? [p.type] : []).filter(Boolean);
  // « null » écrit en texte pour un champ qui accepte null : c'est null (personal_info { email: "null" } pour l'oublier).
  if (typeof v === "string" && types.includes("null") && /^(null|none)$/i.test(v.trim())) return null;
  if (!types.length || v === undefined || fits(v, types)) return v;
  if (typeof v === "string") {
    const s = v.trim();
    if ((types.includes("integer") || types.includes("number")) && /^-?\d+(?:[.,]\d+)?$/.test(s)) {
      const n = Number(s.replace(",", "."));
      if (types.includes("number") || Number.isInteger(n)) return n;
    }
    if (types.includes("boolean") && /^(true|false)$/i.test(s)) return s.toLowerCase() === "true";
    if (types.includes("array") || types.includes("object")) {
      try {
        const j = JSON.parse(s);
        if (fits(j, types)) return types.includes("array") && Array.isArray(j) && p.items ? j.map((x) => coerceValue(x, p.items!)) : j;
      } catch {
        // pas du JSON
      }
    }
    if (types.includes("array")) return [p.items ? coerceValue(v, p.items) : v];
    return v;
  }
  if (types.includes("array") && !Array.isArray(v)) return [v];
  if (types.includes("string") && (typeof v === "number" || typeof v === "boolean")) return String(v);
  return v;
}

/** Chaque argument ramené au type de son schéma quand la lecture est univoque. */
export function coerceArgs(spec: Pick<ToolSpec, "parameters"> | undefined, args: Record<string, unknown>): Record<string, unknown> {
  const props = (spec?.parameters as Schema | undefined)?.properties;
  if (!props) return args;
  const out: Record<string, unknown> = { ...args };
  for (const [k, v] of Object.entries(out)) if (props[k]) out[k] = coerceValue(v, props[k]);
  return out;
}

/** « functions.remember », « Remember », « web-search » : le nom d'outil connu qu'il voulait dire, s'il n'y en a qu'un. */
export function resolveToolName(name: string, known: readonly string[]): string | undefined {
  if (known.includes(name)) return name;
  const norm = (s: string) => s.trim().toLowerCase().replace(/^(?:functions?|tools?)[.:]/, "").replace(/[-\s.]+/g, "_");
  const hits = known.filter((k) => norm(k) === norm(name));
  return hits.length === 1 ? hits[0] : undefined;
}
