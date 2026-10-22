import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * La DA de Mell, partagée par toutes les pages et images : blanc, noir, formes rondes et pleines (un peu
 * cartoon), le logo « m. » (le point compte), et un cadenas chaque fois qu'on demande un accès, pour que
 * la personne se sente en sécurité. Aucune animation, aucun texte qui ne change pas ce qu'elle fait.
 */

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Couleurs de la DA : crème derrière, encre devant. */
export const CREAM = "#F5F0E6";
export const INK = "#111111";

/**
 * Le logo officiel (server/assets/logo/mell-logo-blanc-fond-noir.svg, viewBox 0 0 420 190) : le m d'un seul trait
 * et le point. La boîte serrée du signe est MARK_BOX ; tout ce qui le place le fait par un <svg> imbriqué avec ce
 * viewBox et « xMidYMid meet », pour qu'il soit centré au pixel dans n'importe quelle case.
 */
const M_PATH = "M 28 151 C 28 99, 39 39, 91 39 C 143 39, 151 94, 151 151 C 151 97, 164 39, 216 39 C 269 39, 280 99, 280 151";
export const MARK_BOX = "13 24 351 142";
const mark = (color: string) =>
  `<path d="${M_PATH}" fill="none" stroke="${color}" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/><circle cx="345" cy="150" r="19" fill="${color}"/>`;

/** Le signe seul, à poser dans une case : centré dedans, au ratio du logo. */
export function markSvg(color: string, x: number, y: number, w: number, h: number): string {
  return `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${MARK_BOX}" preserveAspectRatio="xMidYMid meet">${mark(color)}</svg>`;
}

/** Le logo « m. » en SVG autonome. `fill` = sa couleur. */
export function logoSvg(fill = INK, size = 124): string {
  const h = Math.round((size * 142) / 351);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_BOX}" width="${size}" height="${h}" aria-label="Mell" role="img">${mark(fill)}</svg>`;
}

/** Le logo dans une tuile ronde (crème, m. encre), pour la fiche contact et l'icône. */
export function logoTileSvg(size = 200): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="${size}" height="${size}"><rect width="200" height="200" rx="46" fill="${CREAM}"/>${markSvg(INK, 30, 30, 140, 140)}</svg>`;
}

/** La police : Satoshi (Fontshare, licence ITF, auto-hébergée dans server/assets/fonts). */
export const FONT_DIR = fileURLToPath(new URL("../../assets/fonts/", import.meta.url));
export const FONT_FILES = ["Regular", "Medium", "Bold", "Black"].map((w) => `${FONT_DIR}Satoshi-${w}.otf`);
/** Options de police pour resvg : Satoshi d'abord, rien du système (le serveur n'a pas les mêmes polices que le Mac). */
export const RESVG_FONT = { fontFiles: FONT_FILES, defaultFontFamily: "Satoshi", loadSystemFonts: false };
export const FONT_FAMILY = "Satoshi, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

/** Le cadenas : signe que l'accès est protégé. */
export function lockSvg(size = 28, stroke = INK): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><rect x="4" y="10.5" width="16" height="11" rx="4" fill="none" stroke="${stroke}" stroke-width="2.4"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" fill="none" stroke="${stroke}" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="16" r="1.6" fill="${stroke}"/></svg>`;
}

const FACES =
  [400, 500, 700, 900].map((w, i) => `@font-face{font-family:Satoshi;font-weight:${w};font-display:swap;src:url(/fonts/Satoshi-${["Regular", "Medium", "Bold", "Black"][i]}.woff2) format("woff2")}`).join("") +
  `@font-face{font-family:Caveat;font-weight:400 700;font-display:swap;src:url(/fonts/Caveat.ttf) format("truetype")}`;
const STYLE = `${FACES}*{box-sizing:border-box}html{color-scheme:light;-webkit-text-size-adjust:100%}body{margin:0;min-height:100vh;min-height:100svh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:${CREAM};color:${INK};font:17px/1.45 ${FONT_FAMILY};padding:24px 20px calc(24px + env(safe-area-inset-bottom))}main{display:flex;flex-direction:column;align-items:center;text-align:center;max-width:22rem;width:100%}.logo{display:block;width:112px;height:auto;margin-bottom:32px}.logo.big{width:150px;margin-bottom:28px}h1{font-size:26px;line-height:1.15;letter-spacing:-.4px;margin:0 0 10px;font-weight:700}p{margin:0 0 28px;color:#5a564f;font-size:16px}.tag{font-size:18px;color:${INK};margin:0 0 36px;letter-spacing:-.2px}.lock{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:#7a766f;margin:18px 0 0}.lock.big{margin:0 0 14px;line-height:0}.loop{display:block;color:${INK};text-decoration:none;margin:-8px 0 0 -10px;transition:transform 160ms cubic-bezier(.2,.8,.2,1)}.loop svg{display:block;overflow:visible}.loop:active{transform:scale(.98)}.btn{font-family:${FONT_FAMILY};display:inline-flex;align-items:center;justify-content:center;min-height:56px;padding:0 32px;border-radius:999px;background:${INK};color:${CREAM};text-decoration:none;font-weight:700;font-size:17px;border:0;cursor:pointer;transition:transform 160ms cubic-bezier(.2,.8,.2,1)}.btn:active{transform:scale(.98)}.btn.ghost{background:transparent;color:${INK};border:2px solid ${INK}}.row{display:flex;gap:12px;flex-wrap:wrap;justify-content:center}.corner{position:fixed;top:calc(18px + env(safe-area-inset-top));font-size:13px;color:#7a766f;letter-spacing:.2px}.corner.l{left:22px}.corner.r{right:22px}.corner .m{width:34px;height:auto;display:block}.foot{position:fixed;left:0;right:0;bottom:calc(16px + env(safe-area-inset-bottom));text-align:center;font-size:12px;color:#9a958c;letter-spacing:.3px}
/* L'accueil : le bloc (logo + boucle) épinglé au centre glisse à gauche au défilement, lissé ; le texte calme monte à droite, ligne par ligne. Sur téléphone, le bloc monte et le texte vient dessous. */
body.stage{display:block;padding:0;overscroll-behavior-y:none}body.docpage{display:block;padding:0}body.docpage .corner{position:absolute}body.docpage main{max-width:none;display:block;text-align:left;width:100%}main.stage{max-width:none;display:flex;flex-direction:column;width:100%;min-height:100vh;min-height:100svh}.scroller{height:auto;flex:1;display:flex;flex-direction:column}.pin{flex:1;display:flex;align-items:center;justify-content:center;gap:clamp(48px,7vw,110px);padding:80px 48px 60px}.hero{display:flex;flex-direction:column;align-items:center;text-align:center;width:min(24rem,100%);flex:none;color:${INK}}.hero .logo.big{width:200px;margin-bottom:30px}.hero .loop{margin-left:-14px}.side{width:min(30rem,100%);text-align:left;flex:none}.calm p{margin:0 0 20px;font-size:18px;line-height:1.5;color:#3a3732}.calm .lead{font-size:25px;line-height:1.3;letter-spacing:-.3px;color:${INK};margin-bottom:24px}.calm .lead strong,.calm strong{font-weight:700;color:${INK}}.dd{vertical-align:-3px;margin:0 2px 0 4px;color:${INK}}.corner.l a{display:block;line-height:0;color:${INK}}.more{position:absolute;left:50%;bottom:calc(36px + env(safe-area-inset-bottom));transform:translateX(-50%);width:44px;height:44px;border-radius:12px;border:0;background:transparent;color:#9a958c;font-size:22px;cursor:pointer}.bottom{max-width:38rem;margin:0 auto;padding:12px 24px calc(32px + env(safe-area-inset-bottom));font-size:13px;color:#8a857c;text-align:center}.bottom a{color:inherit;text-decoration:none;border-bottom:1px solid #cfc9bd}.doc{max-width:34rem;text-align:left;padding:calc(96px + env(safe-area-inset-top)) 24px calc(60px + env(safe-area-inset-bottom));margin:0 auto}.doc h1{margin-bottom:18px}.doc p{color:#3a3732;font-size:16px}.doc a{color:${INK}}
/* Formulaires (coffre) : champs ronds et pleins, un seul bouton, la promesse en tête. */
.doc.form{padding-top:calc(96px + env(safe-area-inset-top))}.form .lock{margin-bottom:16px;line-height:0}.form h1{font-size:28px;margin-bottom:10px}.form .safe{font-size:15px;color:${INK};margin:0 0 26px;padding:12px 14px;border:1.5px solid ${INK};border-radius:14px}.form p{font-size:15px;color:#3a3732;margin:0 0 18px}.form label{display:block;font-size:14px;font-weight:700;margin:18px 0 8px;color:${INK}}.form input{display:block;width:100%;min-height:52px;border:1.5px solid #cfc9bd;border-radius:14px;background:#fff;color:${INK};padding:13px 14px;font:400 16px/1.4 ${FONT_FAMILY}}.form input:focus{outline:none;border-color:${INK}}.form input::placeholder{color:#9a958c;opacity:1}.form .hint{font-size:13px;line-height:1.45;margin:8px 0 0;color:#7a766f}.form .domain{margin:0 0 6px}.form .two-fields{display:grid;grid-template-columns:1fr 1fr;gap:14px}.form details{margin-top:22px;border-top:1px solid #e3ddd0;padding-top:16px}.form summary{cursor:pointer;min-height:30px;font-size:14px;font-weight:700;list-style:none;display:flex;align-items:center;gap:10px}.form summary::-webkit-details-marker{display:none}.form summary::after{content:"+";font-size:22px;font-weight:400;margin-left:auto;color:#7a766f}.form details[open]>summary::after{content:"-"}.form summary span{font-size:12px;font-weight:400;color:#7a766f}.form .apple p{font-size:14px;margin:12px 0 0}.form .submit,.form .action{width:100%;min-height:56px;display:flex;justify-content:center;align-items:center;margin-top:26px;border:0;border-radius:999px;background:${INK};color:${CREAM};font:700 17px/1.3 ${FONT_FAMILY};text-decoration:none;cursor:pointer}.form .assurance{margin:18px 0 0;font-size:13px;line-height:1.5;color:#7a766f}.form .error{border:1.5px solid #c0392b;border-radius:12px;color:#8e2a1f;padding:12px 14px;font-size:14px;margin:0 0 18px}.form .status .footnote{margin-top:20px;font-size:13px;color:#7a766f}
/* Numéro : le pays (drapeau, indicatif) à gauche, le numéro à droite. Bascule numéro <-> e-mail : un volet glisse, l'autre arrive. */
.form .phone{display:flex;gap:10px}.form .phone select{flex:none;width:6.6rem;min-height:52px;border:1.5px solid #cfc9bd;border-radius:14px;background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5l5 5 5-5' fill='none' stroke='%23111' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 12px center;color:${INK};padding:0 30px 0 12px;font:400 16px/1.4 ${FONT_FAMILY};appearance:none;-webkit-appearance:none;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.form .phone select:focus{outline:none;border-color:${INK}}.form .phone input{flex:1;min-width:0}.form .pane{transition:opacity 200ms ease,transform 200ms cubic-bezier(.2,.8,.2,1)}.form .pane.out{opacity:0;transform:translateX(-28px)}.form .pane.in{opacity:0;transform:translateX(28px)}.form .alt{display:block;width:100%;margin:14px 0 0;min-height:40px;background:none;border:0;color:#5a564f;font:500 14px/1.3 ${FONT_FAMILY};cursor:pointer;text-decoration:underline;text-underline-offset:3px}
/* Admin : les demandes, deux boutons par ligne. */
.form.admin{max-width:40rem}.adminnav{margin:0 0 18px!important;font-size:14px}.adminnav a{color:#111;font-weight:600}.form.admin h1{margin-bottom:6px}.list li small{display:block;color:#7a766f;font-size:13px;margin-top:2px}.list .acts{display:flex;gap:8px;flex:none}
/* Son espace : des lignes, pas des puces ; un petit bouton à droite de chaque ligne. */
.form h2{font-size:17px;margin:30px 0 6px;letter-spacing:-.2px}.share{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:6px 0 0}.share a{color:#111;font-size:16px;min-width:0;overflow-wrap:anywhere}.share .btn{flex:none}.list{list-style:none;padding:0;margin:0}.list li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #e3ddd0;font-size:15px}.list li span{min-width:0;overflow-wrap:anywhere}.list form{margin:0;flex:none}.list li:has(details){align-items:flex-start}.list details{min-width:0;flex:1;margin:0;border:0;padding:0}.list summary{font-size:15px;font-weight:400;min-height:34px;overflow-wrap:anywhere}.list .lesson{white-space:pre-line;color:#5f5a52;font-size:14px;line-height:1.45;margin:10px 0 0}.btn.small{min-height:34px;padding:0 14px;font-size:14px;font-weight:600}.row.left{justify-content:flex-start;margin-top:34px;gap:10px}.row.left form{margin:0}
@media (max-width:720px){main.stage{display:block;min-height:0}.scroller{display:block}.pin{display:block;min-height:0;padding:0}.hero{margin:18vh auto 14vh;width:calc(100% - 40px)}.hero .logo.big{width:150px}.hero .loop{margin-left:0}.hero .loop svg{width:min(300px,calc(100vw - 48px));height:auto}.side{width:auto;margin:0 20px;padding-bottom:24px}.calm p{font-size:17px;margin-bottom:16px;line-height:1.45}.calm .lead{font-size:23px;margin-bottom:18px}.calm .ex .dd{width:16px;height:16px}}`;

/**
 * Le bouton de Mell : pas un rectangle, un trait. Une boucle dessinée d'un seul geste autour du mot, et le trait
 * qui file en queue vers la droite et finit en flèche : la queue EST la flèche. Rien ne brille.
 * Le lien entoure tout le dessin ; la boucle est la zone qu'on touche.
 */
export function loopButton(label: string, href: string): string {
  return `<a class="loop" href="${esc(href)}" aria-label="${esc(label)}"><svg viewBox="0 0 760 300" width="380" height="150" aria-hidden="true">
<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
<path d="M 548 128 C 522 64, 362 46, 222 61 C 98 75, 60 149, 141 191 C 238 237, 470 222, 552 151 C 567 177, 600 232, 700 252"/>
<path d="M 678 236 L 700 252 L 676 264"/>
</g>
<text x="300" y="138" font-family="Satoshi, -apple-system, sans-serif" font-weight="500" font-size="30" letter-spacing="2" fill="currentColor" text-anchor="middle">${esc(label)}</text>
</svg></a>`;
}

/**
 * L'en-tête commun aux pages qui gardent leur propre mise en page (carte, Google, navigateur en direct) :
 * favicon et icône d'écran d'accueil, les polices, le schéma clair, et les variables de couleur de la DA.
 */
/**
 * La langue du site, une seule règle pour toutes les pages : ?lang= (pour tester), sinon la première langue du
 * navigateur. Jamais la langue du compte Mell : c'est elle qui faisait passer la page du code en anglais.
 */
export function siteLang(req: { headers: Record<string, unknown>; query?: unknown }): "fr" | "en" {
  const q = (req.query as { lang?: string } | undefined)?.lang;
  if (q === "fr" || q === "en") return q;
  const first = String(req.headers["accept-language"] ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("fr") ? "fr" : "en";
}

/**
 * Les icônes de toutes les pages : SVG pour les navigateurs qui le lisent, PNG 32 px pour l'onglet de Safari et des
 * moteurs de recherche, 180 px pour l'écran d'accueil de l'iPhone, manifeste pour Android. Le cadenas sur les pages
 * sensibles (coffre, connexion, code), le m. ailleurs.
 */
export function iconTags(lock = false): string {
  return `<link rel="icon" href="${lock ? "/lock.svg" : "/logo.svg"}" type="image/svg+xml"><link rel="icon" href="${lock ? "/lock-32.png" : "/favicon-32.png"}" sizes="32x32" type="image/png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><meta name="theme-color" content="${CREAM}">`;
}

export function headTags(lock = false): string {
  return `<meta name="color-scheme" content="light">${iconTags(lock)}<style>${FACES}:root{--bg:${CREAM};--fg:${INK};--mut:#7a766f;--line:#e3ddd0;--card:#fff;--btn:${INK};--btnfg:${CREAM}}</style>`;
}

export interface PageOpts {
  lang: "fr" | "en";
  title: string;
  /** Texte d'aperçu (og:description) : ce que voit celui qui reçoit le lien. */
  preview?: string;
  body: string;
  /** Image d'aperçu du lien, sinon le logo. */
  image?: string;
  noindex?: boolean;
  /** Accueil en deux temps (bloc central + description au geste), sans défilement. */
  stage?: boolean;
  /** Page sensible (coffre, connexion) : le cadenas en favicon, comme Instinct. C'est lui qui rassure, pas une phrase. */
  lock?: boolean;
}

export function page(o: PageOpts): string {
  return `<!doctype html><html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light">${o.noindex === false ? "" : '<meta name="robots" content="noindex">'}<meta name="referrer" content="no-referrer">
<title>${esc(o.title)}</title><meta property="og:title" content="${esc(o.title)}"><meta property="og:site_name" content="Mell">${o.preview ? `<meta name="description" content="${esc(o.preview)}"><meta property="og:description" content="${esc(o.preview)}">` : ""}${o.image ? `<meta property="og:image" content="${esc(o.image)}">` : ""}
${iconTags(o.lock)}<style>${STYLE}</style></head><body class="${o.stage ? "stage" : o.body.includes('class="doc') ? "docpage" : ""}"><main class="${o.stage ? "stage" : ""}">${o.body}</main></body></html>`;
}

let tilePng: Buffer | undefined;
/** L'icône (tuile crème, m. encre) en PNG, rendue une fois : fiche contact, icône d'écran d'accueil. */
export function logoTilePng(): Buffer {
  tilePng ??= Buffer.from(new Resvg(logoTileSvg(512), { fitTo: { mode: "width", value: 512 }, font: RESVG_FONT }).render().asPng());
  return tilePng;
}

/** Le cadenas dans la même tuile que le logo : l'icône des pages sensibles. */
export function lockTileSvg(size = 200): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="${size}" height="${size}"><rect width="200" height="200" rx="46" fill="${CREAM}"/><g transform="translate(40 36) scale(5)"><rect x="4" y="10.5" width="16" height="11" rx="4" fill="none" stroke="${INK}" stroke-width="2.4"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="16" r="1.6" fill="${INK}"/></g></svg>`;
}

const pngCache = new Map<string, Buffer>();
/** Une tuile (logo ou cadenas) rendue en PNG à la taille voulue, une fois. */
export function tilePngAt(kind: "logo" | "lock", size: number): Buffer {
  const key = `${kind}:${size}`;
  let png = pngCache.get(key);
  if (!png) {
    const svg = kind === "logo" ? logoTileSvg(size) : lockTileSvg(size);
    png = Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: size }, font: RESVG_FONT }).render().asPng());
    pngCache.set(key, png);
  }
  return png;
}

export async function registerBrandRoutes(http: FastifyInstance): Promise<void> {
  const cache = { "cache-control": "public, max-age=86400" };
  http.get("/logo.svg", async (_req, reply) => reply.code(200).headers({ ...cache, "content-type": "image/svg+xml" }).send(logoSvg()));
  http.get("/lock.svg", async (_req, reply) => reply.code(200).headers({ ...cache, "content-type": "image/svg+xml" }).send(lockSvg(64, INK).replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ')));
  http.get("/logo.png", async (_req, reply) => reply.code(200).headers({ ...cache, "content-type": "image/png" }).send(logoTilePng()));
  const png = (kind: "logo" | "lock", size: number) => async (_req: unknown, reply: FastifyReply) => reply.code(200).headers({ ...cache, "content-type": "image/png" }).send(tilePngAt(kind, size));
  http.get("/favicon.ico", png("logo", 32));
  http.get("/favicon-32.png", png("logo", 32));
  http.get("/lock-32.png", png("lock", 32));
  http.get("/apple-touch-icon.png", png("logo", 180));
  http.get("/apple-touch-icon-precomposed.png", png("logo", 180));
  http.get("/icon-192.png", png("logo", 192));
  http.get("/icon-512.png", png("logo", 512));
  http.get("/site.webmanifest", async (_req, reply) =>
    reply
      .code(200)
      .headers({ ...cache, "content-type": "application/manifest+json" })
      .send({ name: "Mell", short_name: "Mell", start_url: "/", display: "browser", background_color: CREAM, theme_color: CREAM, icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png" }] }),
  );
  http.get("/fonts/:file", async (req, reply) => {
    const file = String((req.params as { file: string }).file ?? "");
    if (!/^(Satoshi-(Regular|Medium|Bold|Black)\.woff2|Caveat\.ttf)$/.test(file)) return reply.code(404).send();
    return reply.code(200).headers({ "cache-control": "public, max-age=31536000, immutable", "content-type": file.endsWith(".ttf") ? "font/ttf" : "font/woff2" }).send(await readFile(`${FONT_DIR}${file}`));
  });
}
