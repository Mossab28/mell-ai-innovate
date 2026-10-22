import { createHmac, createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Config } from "./config.ts";
import { CREAM, INK, RESVG_FONT, lockSvg, markSvg } from "./web/da.ts";

/**
 * Aperçu de lien en image. iMessage n'affiche pas d'office l'aperçu d'un lien nu (« Toucher pour
 * charger »), mais une photo s'affiche toujours. Pour les liens sans photo (connexion d'une app,
 * coffre, carte sans image), on génère une petite carte de marque en PNG, envoyée en photo, avec le
 * lien dans la ligne du dessous. Rendu par resvg (SVG -> PNG), sans navigateur.
 */

export interface PreviewSpec {
  title: string;
  subtitle?: string;
  host?: string;
  /** Photo réelle de l'option (hôtel, resto, produit) : l'aperçu ressemble alors à la carte native. */
  image?: string;
  /** Carte de connexion : fond blanc, « Mell × App » avec le logo de l'app (lien de connexion d'une app). */
  logo?: string;
  /** Lien sensible (coffre) : un cadenas seul sur la crème, rien d'autre. Le titre de la carte vient du lien. */
  lock?: boolean;
}

const W = 1200;
const H = 630;
const PHOTO_H = 392; // la photo occupe le haut, une barre titre · site en dessous (comme un lien enrichi natif).
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Coupe un texte en lignes qui tiennent dans la largeur (estimation par caractère). */
function wrap(text: string, perLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > perLine && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else cur = (cur + " " + w).trim();
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, perLine - 1)}…`;
  return lines.length ? lines : [""];
}

/** Carte avec la vraie photo en haut (comme un lien enrichi natif) : photo + barre titre · site. */
function svgWithPhoto(spec: PreviewSpec, dataUri: string): string {
  const titleLines = wrap(spec.title.slice(0, 80), 30, 1);
  const line = [spec.subtitle, spec.host?.replace(/^www\./, "")].filter(Boolean).join("  ·  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Satoshi">
  <rect width="${W}" height="${H}" fill="#0b0d10"/>
  <defs><clipPath id="ph"><rect x="0" y="0" width="${W}" height="${PHOTO_H}"/></clipPath></defs>
  <image x="0" y="0" width="${W}" height="${PHOTO_H}" href="${dataUri}" preserveAspectRatio="xMidYMid slice" clip-path="url(#ph)"/>
  <text x="56" y="${PHOTO_H + 110}" font-size="60" font-weight="700" fill="#ffffff">${esc(titleLines[0])}</text>
  ${line ? `<text x="56" y="${PHOTO_H + 176}" font-size="40" fill="#9aa0aa">${esc(line.slice(0, 54))}</text>` : ""}
</svg>`;
}

/** Carte sans photo (coffre, connexion, pages à nous) : crème, le m. en coin, le cadenas, le titre, une ligne. */
function svgText(spec: PreviewSpec): string {
  const titleLines = wrap(spec.title.slice(0, 120), 22, 2);
  const ty = titleLines.length === 1 ? 330 : 290;
  const title = titleLines.map((l, i) => `<text x="90" y="${ty + i * 84}" font-size="72" font-weight="700" letter-spacing="-1.5" fill="${INK}">${esc(l)}</text>`).join("");
  const subtitle = spec.subtitle ? `<text x="90" y="${ty + titleLines.length * 84 + 16}" font-size="38" fill="#7a766f">${esc(spec.subtitle.slice(0, 48))}</text>` : "";
  const host = spec.host ? `<text x="90" y="556" font-size="30" fill="#9a958c">${esc(spec.host.replace(/^www\./, "").slice(0, 40))}</text>` : "";
  const lock = lockSvg(56, INK).replace(/<svg [^>]*>|<\/svg>/g, "").replace(/<(rect|path|circle)/g, '<$1 transform="scale(2.3333)"');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Satoshi">
  <rect width="${W}" height="${H}" fill="${CREAM}"/>
  ${markSvg(INK, 90, 84, 110, 56)}
  <g transform="translate(${W - 90 - 56} 84)">${lock}</g>
  ${title}${subtitle}${host}
</svg>`;
}

/**
 * Carte de connexion : « m. × App ». Deux cases de 200 × 200 sur la même ligne, à égale distance du centre,
 * chaque signe centré dans sa case (le m. dans une case plus large, à 260, pour le même poids visuel ; le logo de l'app par « meet ») ; la croix au centre
 * exact ; le titre centré dessous ; le cadenas en haut à droite, à la même marge que les cases.
 */
function svgConnect(spec: PreviewSpec, logoDataUri?: string): string {
  const cw = 1200;
  const ch = 600;
  const box = 200;
  const y = 140;
  const markW = 260; // le m. est large et bas : une case plus large pour le même poids visuel que le logo carré
  const left = cw / 2 - 100 - markW; // 240
  const right = cw / 2 + 100; // 700
  const mid = y + box / 2; // 240
  const app = logoDataUri
    ? `<image x="${right}" y="${y}" width="${box}" height="${box}" href="${logoDataUri}" preserveAspectRatio="xMidYMid meet"/>`
    : `<rect x="${right}" y="${y}" width="${box}" height="${box}" rx="44" fill="#e9e3d7"/>`;
  const cross = `<g stroke="#c9c3b7" stroke-width="12" stroke-linecap="round"><line x1="${cw / 2 - 22}" y1="${mid - 22}" x2="${cw / 2 + 22}" y2="${mid + 22}"/><line x1="${cw / 2 + 22}" y1="${mid - 22}" x2="${cw / 2 - 22}" y2="${mid + 22}"/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}" font-family="Satoshi">
  <rect width="${cw}" height="${ch}" fill="${CREAM}"/>
  ${markSvg(INK, left, y, markW, box)}
  ${cross}
  ${app}
  <g transform="translate(${cw - 48 - 56} 48)">${lockSvg(56, INK).replace(/<svg [^>]*>|<\/svg>/g, "").replace(/<(rect|path|circle)/g, '<$1 transform="scale(2.3333)"')}</g>
  <text x="${cw / 2}" y="${y + box + 110}" font-size="46" font-weight="700" fill="${INK}" text-anchor="middle">${esc(spec.title.slice(0, 48))}</text>
</svg>`;
}

/** Récupère la vraie photo (bornée) et la met en data URI ; undefined si indisponible. */
async function fetchImageDataUri(url: string): Promise<string | undefined> {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    const res = await fetch(u, { signal: AbortSignal.timeout(8000), headers: { "user-agent": "Mozilla/5.0 (Macintosh) Mell" } });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/")) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return undefined;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/**
 * La photo d'une carte, recadrée selon le nombre de cartes envoyées ensemble : iMessage dimensionne la carte
 * d'après l'image, donc seule = 3:2 pleine largeur, deux = bandeau 2:1, trois ou plus = bandeau 3:1 pour que la
 * série tienne à l'écran. Rend undefined si la photo est illisible.
 */
export async function cardPhoto(imageUrl: string, count: number): Promise<Buffer | undefined> {
  const dataUri = await fetchImageDataUri(imageUrl);
  if (!dataUri) return undefined;
  const ratio = count <= 1 ? 1.5 : count === 2 ? 2 : 3; // seule : 3:2, pleine largeur et haute (le carré rétrécit la carte)
  const bw = 1200;
  const bh = Math.round(bw / ratio);
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${bw}" height="${bh}" viewBox="0 0 ${bw} ${bh}">
  <image x="0" y="0" width="${bw}" height="${bh}" href="${dataUri}" preserveAspectRatio="xMidYMid slice"/>
</svg>`;
  const r = new Resvg(markup, { fitTo: { mode: "width", value: bw } });
  return Buffer.from(r.render().asPng());
}

export async function renderPreview(spec: PreviewSpec): Promise<Buffer> {
  if (spec.lock) {
    const lock = lockSvg(56, INK).replace(/<svg [^>]*>|<\/svg>/g, "").replace(/<(rect|path|circle)/g, '<$1 transform="scale(7.5)"');
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${CREAM}"/><g transform="translate(${W / 2 - 90} ${H / 2 - 90})">${lock}</g></svg>`;
    return Buffer.from(new Resvg(markup, { background: CREAM, fitTo: { mode: "width", value: W } }).render().asPng());
  }
  if (spec.logo) {
    const logo = await fetchImageDataUri(spec.logo);
    return Buffer.from(new Resvg(svgConnect(spec, logo), { background: CREAM, fitTo: { mode: "width", value: W }, font: RESVG_FONT }).render().asPng());
  }
  const dataUri = spec.image ? await fetchImageDataUri(spec.image) : undefined;
  const markup = dataUri ? svgWithPhoto(spec, dataUri) : svgText(spec);
  const r = new Resvg(markup, { background: CREAM, fitTo: { mode: "width", value: W }, font: RESVG_FONT });
  return Buffer.from(r.render().asPng());
}

// ---- Lien signé vers l'image, sans rien stocker -------------------------------------------------

// Posé une fois au démarrage (app.ts) : la clé de signature et l'adresse publique, pour que n'importe
// quel endroit qui envoie un lien puisse construire l'URL de son aperçu sans trimbaler la config.
let state: { key: Buffer; base: string } | undefined;

export function installPreview(cfg: Pick<Config, "adminToken" | "publicUrl">): void {
  state = { key: createHash("sha256").update(`mell/preview/v1\0${cfg.adminToken ?? cfg.publicUrl}`).digest(), base: cfg.publicUrl.replace(/\/+$/, "") };
}

/** L'hôte public de Mell (askmell.com), tel que les cartes le montrent sous leur titre. */
export function publicHost(): string {
  try {
    return state ? new URL(state.base).host : "askmell.com";
  } catch {
    return "askmell.com";
  }
}

/** L'URL /pv/<données>.png signée pour un aperçu : la personne ne peut pas faire rendre un texte arbitraire. */
export function previewUrl(spec: PreviewSpec): string | undefined {
  if (!state) return undefined;
  const data = Buffer.from(JSON.stringify(spec)).toString("base64url");
  const sig = createHmac("sha256", state.key).update(data).digest("base64url").slice(0, 16);
  return `${state.base}/pv/${data}.${sig}.png`;
}

export function registerPreviewRoute(http: FastifyInstance): void {
  http.get("/pv/:token.png", async (req, reply: FastifyReply) => {
    if (!state) return reply.code(404).send();
    const token = String((req.params as { token: string }).token ?? "");
    const [data, sig] = token.split(".");
    if (!data || !sig) return reply.code(400).send();
    const good = createHmac("sha256", state.key).update(data).digest("base64url").slice(0, 16);
    if (sig !== good) return reply.code(403).send();
    let spec: PreviewSpec;
    try {
      spec = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
      if (!spec || typeof spec.title !== "string") throw new Error("spec");
    } catch {
      return reply.code(400).send();
    }
    try {
      return reply.code(200).headers({ "content-type": "image/png", "cache-control": "public, max-age=86400" }).send(await renderPreview(spec));
    } catch {
      return reply.code(500).send();
    }
  });
}
