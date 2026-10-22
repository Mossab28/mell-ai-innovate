import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db.ts";
import { getUser } from "../users.ts";
import { APP_COPY, COPY, copyFor, type AppCopy, type Copy } from "./copy.ts";
import type { GoogleService } from "./service.ts";
import { FONT_FAMILY, headTags } from "../web/da.ts";

/**
 * Les deux pages publiques de la connexion Google, sous /connect/ (seul préfixe ouvert avec /v/).
 *   GET /connect/google?t=...        page minuscule, aperçu de lien soigné, puis Google
 *   GET /connect/google/callback     retour de Google : jeton au coffre, bulle dans le fil
 *   GET|POST /connect/gmail?t=...    sa boîte par mot de passe d'application : elle colle le code, on l'essaie chez Google
 * Aucun script, aucune ressource externe ; aucune page ne montre quoi que ce soit de technique.
 */

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // Le retour porte le code de Google dans l'adresse : il ne part chez personne.
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(t: Copy, body: string, head = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(t.title)}</title>${head}${headTags(true)}
<style>body{font:17px/1.45 ${FONT_FAMILY};max-width:26rem;margin:22vh auto 0;padding:0 1.2rem;text-align:center;color:var(--fg);background:var(--bg)}a{color:var(--fg)}small{color:var(--mut)}</style>
</head><body>${body}</body></html>`;
}

const message = (t: Copy, text: string) => page(t, `<p>${esc(text)}</p>`);
/** Sans personne connue (lien inconnu ou périmé) : les deux langues. */
const both = (k: "gone" | "notYet") => page(COPY.fr, `<p>${esc(COPY.fr[k])}</p><p><small>${esc(COPY.en[k])}</small></p>`);

/** Page d'aller : balises d'aperçu pour la carte du fil, puis direction Google sans attendre. */
function goPage(t: Copy, url: string): string {
  const head = `<meta property="og:title" content="${esc(t.title)}"><meta property="og:description" content="${esc(t.preview)}"><meta property="og:site_name" content="Mell"><meta http-equiv="refresh" content="0;url=${esc(url)}">`;
  return page(t, `<p>${esc(t.going)}</p><p><a href="${esc(url)}">${esc(t.go)}</a></p>`, head);
}

/** Comme HEADERS, mais la page envoie son formulaire à elle-même. */
const APP_HEADERS = { ...HEADERS, "content-security-policy": HEADERS["content-security-policy"].replace("form-action 'none'", "form-action 'self'") };

const APP_PASSWORDS_URL = "https://myaccount.google.com/apppasswords";
const TWO_STEP_URL = "https://myaccount.google.com/signinoptions/twosv";

/** La page du code : deux gestes, le formulaire, une phrase de confiance. Sans script ni ressource externe. */
function appPage(t: AppCopy, token: string, p: { email?: string; error?: string } = {}): string {
  const head = `<meta property="og:title" content="${esc(t.title)}"><meta property="og:description" content="${esc(t.preview)}"><meta property="og:site_name" content="Mell">`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(t.title)}</title>${head}${headTags(true)}
<style>
body{font:17px/1.45 ${FONT_FAMILY};max-width:26rem;margin:8vh auto 3rem;padding:0 1.2rem;color:var(--fg);background:var(--bg)}
h1{font-size:1.45rem;line-height:1.2;margin:0 0 1.6rem}
ol{list-style:none;padding:0;margin:0}li{margin:0 0 1.6rem}
.n{display:inline-grid;place-items:center;width:1.6rem;height:1.6rem;border-radius:50%;background:#111;color:#fff;font-size:.85rem;font-weight:600;margin-right:.5rem}
.b{display:block;text-align:center;background:#111;color:#fff;text-decoration:none;font-weight:600;padding:.9rem;border-radius:.8rem;margin:.8rem 0 .5rem;border:0;width:100%;font-size:1rem}
small{display:block;color:#666;font-size:.85rem}small a{color:#666}
label{display:block;font-size:.85rem;color:#444;margin:.8rem 0 .3rem}
input{box-sizing:border-box;width:100%;font:inherit;padding:.75rem .8rem;border:1px solid #ccc;border-radius:.6rem}
input[name=code]{letter-spacing:.12em;font-family:ui-monospace,monospace}
.e{background:#fff1f0;color:#a8071a;padding:.7rem .8rem;border-radius:.6rem;margin:0 0 1rem}
.t{color:#666;font-size:.85rem;margin-top:1.2rem}
@media (prefers-color-scheme:dark){body{background:#000;color:#eee}.n,.b{background:#fff;color:#000}input{background:#111;color:#eee;border-color:#444}label{color:#aaa}.e{background:#2a1215;color:#ffa39e}}
</style></head><body>
<h1>${esc(t.title)}</h1>
<ol>
<li><span class="n">1</span>${esc(t.step1)}<a class="b" href="${APP_PASSWORDS_URL}" target="_blank" rel="noopener noreferrer">${esc(t.open)}</a><small>${esc(t.twosv)} <a href="${TWO_STEP_URL}" target="_blank" rel="noopener noreferrer">${esc(t.twosvLink)}</a></small></li>
<li><span class="n">2</span>${esc(t.step2)}
<form method="post" action="/connect/gmail">${p.error ? `<p class="e">${esc(p.error)}</p>` : ""}
<input type="hidden" name="t" value="${esc(token)}">
<label for="email">${esc(t.email)}</label><input id="email" name="email" type="email" autocomplete="email" autocapitalize="none" required value="${esc(p.email ?? "")}">
<label for="code">${esc(t.code)}</label><input id="code" name="code" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" required placeholder="abcd efgh ijkl mnop">
<button class="b" type="submit">${esc(t.submit)}</button>
</form></li>
</ol>
<p class="t">${esc(t.trust)}</p>
</body></html>`;
}

export async function registerGoogleRoutes(http: FastifyInstance, deps: { db: Db; google: GoogleService }): Promise<void> {
  const { db, google } = deps;
  const send = (reply: FastifyReply, code: number, html: string) => reply.code(code).headers(HEADERS).send(html);
  const copyOf = async (userId: string) => copyFor((await getUser(db, userId))?.lang);

  http.get("/connect/google", async (req, reply) => {
    const r = await google.begin(db, String((req.query as { t?: string }).t ?? ""));
    if (r.status === "unavailable") return send(reply, 503, both("notYet"));
    if (r.status === "gone") return send(reply, 410, both("gone"));
    return send(reply, 200, goPage(await copyOf(r.userId), r.url));
  });

  http.get("/connect/google/callback", async (req, reply) => {
    const p = req.query as { code?: string; state?: string; error?: string };
    const r = await google.finish(db, { code: p.code, state: p.state, error: p.error });
    if (r.status === "unavailable") return send(reply, 503, both("notYet"));
    if (r.status === "invalid") return send(reply, 400, both("gone"));
    const t = await copyOf(r.userId);
    const [code, text] = ({ connected: [200, t.done], nothing: [200, t.nothing], denied: [200, t.denied], failed: [502, t.failed], gone: [410, t.gone] } as const)[r.status];
    return send(reply, code, message(t, text));
  });

  // Mot de passe d'application : la page, puis le code collé, essayé chez Google avant de répondre.
  await http.register(async (scope) => {
    await scope.register(formbody, { bodyLimit: 2048 });
    const appCopy = async (userId: string) => ((await getUser(db, userId))?.lang === "en" ? APP_COPY.en : APP_COPY.fr);

    scope.get("/connect/gmail", async (req, reply) => {
      const token = String((req.query as { t?: string }).t ?? "");
      const link = await google.appLink(db, token);
      if (!link) return send(reply, 410, both("gone"));
      return reply.code(200).headers(APP_HEADERS).send(appPage(await appCopy(link.userId), token, { email: link.email }));
    });

    scope.post("/connect/gmail", async (req, reply) => {
      const b = req.body as { t?: string; email?: string; code?: string };
      const token = String(b.t ?? "");
      const r = await google.connectApp(db, token, String(b.email ?? ""), String(b.code ?? ""));
      if (r.status === "gone") return send(reply, 410, both("gone"));
      const t = await appCopy(r.userId);
      if (r.status === "connected") return send(reply, 200, message(await copyOf(r.userId), (await copyOf(r.userId)).done));
      return reply.code(200).headers(APP_HEADERS).send(appPage(t, token, { email: String(b.email ?? ""), error: t[r.status] }));
    });
  });
}
