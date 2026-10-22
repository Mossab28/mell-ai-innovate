import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db.ts";
import type { Config } from "../config.ts";
import { enqueue } from "../outbox.ts";
import { getUser } from "../users.ts";
import { createJob } from "../agent.ts";
import { browserRuntime, type SessionManager } from "./index.ts";
import { assertPublicUrl } from "./loop.ts";
import { FONT_FAMILY, headTags } from "../web/da.ts";

/**
 * Connexion en direct. Pour un site qui demande un compte, Mell envoie
 * un lien qui montre, sur le téléphone, la vraie page du site ouverte dans son navigateur. La personne
 * s'y connecte elle-même (mot de passe, code, « Continuer avec Google »), touche « C'est bon », et Mell
 * garde la session (cookies chiffrés dans son profil). Le site peut ensuite la faire expirer.
 *
 * Les images de la page partent en flux (Server-Sent Events, rien à installer), les touchers et la
 * frappe reviennent par de simples requêtes. La saisie traverse le serveur vers le navigateur,
 * sans être transmise au modèle ni au fil. Aucun corps de requête n'est journalisé ici.
 */

interface Live {
  token: string;
  userId: string;
  site: string;
  taskId?: string;
  page: any;
  cdp: any;
  clients: Set<FastifyReply>;
  lastFrame?: string;
  width: number;
  height: number;
  expires: number;
  timer: NodeJS.Timeout;
  sessions: SessionManager;
  finishing?: boolean;
}

const SESSIONS = new Map<string, Live>();
const LIVE_MINUTES = 15;
const VIEW = { width: 412, height: 780 };

function hostOf(u: string): string {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return u;
  }
}

/** Ouvre la page de connexion dans le navigateur de la personne et rend le lien à lui envoyer. */
export async function startLive(db: Pick<Db, "query">, cfg: Pick<Config, "liveUrl">, userId: string, p: { site: string; startUrl: string; taskId?: string }): Promise<string> {
  const startUrl = assertPublicUrl(p.startUrl).href;
  const rt = browserRuntime();
  if (!rt) throw new Error("navigateur non branché sur ce serveur");
  for (const l of SESSIONS.values()) if (l.userId === userId) await endLive(l.token, false);
  const driver = await rt.sessions.takeOver(userId);
  let cdp: any;
  let live: Live | undefined;
  try {
    const page = (await driver.playwright!()) as any;
    await page.setViewportSize(VIEW).catch(() => {});
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 40_000 });
    cdp = await page.context().newCDPSession(page);
    const token = randomBytes(24).toString("base64url");
    live = {
      token,
      userId,
      site: p.site,
      taskId: p.taskId,
      page,
      cdp,
      clients: new Set(),
      width: VIEW.width,
      height: VIEW.height,
      expires: Date.now() + LIVE_MINUTES * 60_000,
      timer: setTimeout(() => endLive(token, false).catch(() => {}), LIVE_MINUTES * 60_000),
      sessions: rt.sessions,
    };
    const session = live;
    cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { deviceWidth?: number; deviceHeight?: number } }) => {
      session.lastFrame = f.data;
      if (f.metadata?.deviceWidth) session.width = f.metadata.deviceWidth;
      if (f.metadata?.deviceHeight) session.height = f.metadata.deviceHeight;
      for (const c of session.clients) c.raw.write(`data: ${f.data}\n\n`);
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: VIEW.width * 2, maxHeight: VIEW.height * 2 });
    SESSIONS.set(token, live);
    return `${cfg.liveUrl.replace(/\/+$/, "")}/l/${token}`;
  } catch (e) {
    if (live) clearTimeout(live.timer);
    await cdp?.detach().catch(() => {});
    await rt.sessions.finishTakeover(userId, false);
    throw e;
  }
}

/** Sauvegarde explicite ou abandon du contexte, sans effacer le dernier profil conservé. */
async function endLive(token: string, saved: boolean): Promise<Live | undefined> {
  const l = SESSIONS.get(token);
  if (!l || l.finishing) return undefined;
  l.finishing = true;
  try {
    await l.sessions.finishTakeover(l.userId, saved);
  } catch (e) {
    l.finishing = false;
    throw e;
  }
  SESSIONS.delete(token);
  clearTimeout(l.timer);
  for (const c of l.clients) c.raw.end();
  await l.cdp.send("Page.stopScreencast").catch(() => {});
  await l.cdp.detach().catch(() => {});
  return l;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const PAGE = (site: string, token: string, en: boolean) => `<!doctype html><html lang="${en ? "en" : "fr"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta name="robots" content="noindex"><title>Mell · ${esc(site)}</title>${headTags(true)}
<style>*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 ${FONT_FAMILY}}
header{padding:10px 16px;color:var(--mut);font-size:13px}#screen{display:block;width:100%;border-top:1px solid var(--line);border-bottom:1px solid var(--line);touch-action:none;background:#eee}
.bar{display:flex;gap:8px;padding:10px 16px}#kb{flex:1;font-size:16px;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--fg);-webkit-text-security:disc}
.k{padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font-size:15px}
.done{display:block;margin:6px 16px 20px;padding:15px;border-radius:999px;border:0;width:calc(100% - 32px);font-weight:600;font-size:17px;background:var(--btn);color:var(--btnfg)}
p{margin:0 16px 14px;color:var(--mut);font-size:13px}</style></head><body>
<header>${en ? `The real ${esc(site)} page, opened in Mell's browser. Sign in here. What you type does not pass through the conversation.` : `La vraie page ${esc(site)}, ouverte dans le navigateur de Mell. Connecte-toi ici. Ta saisie ne passe pas dans la conversation.`}</header>
<img id="screen" alt="">
<div class="bar"><input id="kb" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="${en ? "Tap a field above, then type here" : "Touche un champ au-dessus, puis tape ici"}"><button class="k" id="enter">↵</button></div>
<button class="done" id="ok">${en ? "Done, save session" : "Terminer et garder la session"}</button>
<button class="k" id="no" style="display:block;margin:0 16px 14px;width:calc(100% - 32px)">${en ? "Cancel" : "Annuler"}</button>
<p id="status" role="status" aria-live="polite"></p>
<p>${en ? "This page works once and closes after 15 minutes." : "Cette page ne sert qu'une fois et se ferme au bout de 15 minutes."}</p>
<script>
const T=${JSON.stringify(token)};const img=document.getElementById("screen");const kb=document.getElementById("kb");
const status=document.getElementById("status");const ok=document.getElementById("ok");const no=document.getElementById("no");
let inputs=Promise.resolve();let closing=false;
const send=(e)=>{
  if(closing)return;
  inputs=inputs.then(async()=>{const r=await fetch("/l/"+T+"/input",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(e)});if(!r.ok)throw new Error("input")});
  inputs.catch(()=>{status.textContent=${JSON.stringify(en ? "Your input could not be sent. Reload this page to retry." : "La saisie n'a pas pu être transmise. Recharge cette page pour réessayer.")}});
  return inputs;
};
const es=new EventSource("/l/"+T+"/frames");es.onmessage=(m)=>{img.src="data:image/jpeg;base64,"+m.data};es.addEventListener("end",()=>{es.close();location.reload()});
img.addEventListener("click",(ev)=>{const r=img.getBoundingClientRect();send({type:"tap",x:(ev.clientX-r.left)/r.width,y:(ev.clientY-r.top)/r.height});kb.focus()});
let y0=null;img.addEventListener("touchstart",(e)=>{y0=e.touches[0].clientY},{passive:true});img.addEventListener("touchend",(e)=>{if(y0===null)return;const dy=y0-e.changedTouches[0].clientY;if(Math.abs(dy)>25)send({type:"scroll",dy:dy*2});y0=null},{passive:true});
kb.addEventListener("input",(e)=>{if(e.isComposing)return;const text=kb.value||e.data;if(e.inputType==="deleteContentBackward")send({type:"key",key:"Backspace"});else if(text)send({type:"text",text});kb.value=""});
kb.addEventListener("keydown",(e)=>{if(e.key==="Enter"){e.preventDefault();send({type:"key",key:"Enter"})}});
document.getElementById("enter").onclick=()=>send({type:"key",key:"Enter"});
const finish=async(action)=>{
  if(closing)return;
  closing=true;ok.disabled=true;no.disabled=true;kb.disabled=true;status.textContent="";
  try {
    if(action==="done")await inputs;
    const r=await fetch("/l/"+T+"/"+action,{method:"POST"});
    if(!r.ok)throw new Error("save");
    es.close();
    document.body.textContent=action==="done"?${JSON.stringify(en ? "The browser session is saved. You can go back to Messages." : "La session du navigateur est enregistrée. Tu peux revenir dans Messages.")}:${JSON.stringify(en ? "Closed without saving this session." : "Fermé sans enregistrer cette session.")};
  } catch {
    status.textContent=${JSON.stringify(en ? "Could not finish. Please retry, or cancel." : "Impossible de terminer. Réessaie ou annule.")};
  } finally {
    closing=false;ok.disabled=false;no.disabled=false;kb.disabled=false;
  }
};
no.onclick=()=>finish("cancel");ok.onclick=()=>finish("done");
</script></body></html>`;

export async function registerLiveRoutes(http: FastifyInstance, deps: { db: Db; cfg: Pick<Config, "models"> }): Promise<void> {
  const { db } = deps;
  const html = (reply: FastifyReply, code: number, body: string) =>
    reply.code(code).headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY" }).send(body);
  const get = (t: string) => {
    const l = SESSIONS.get(t);
    return l && !l.finishing && l.expires > Date.now() ? l : undefined;
  };

  http.get("/l/:token", async (req, reply) => {
    const l = get((req.params as { token: string }).token);
    if (!l) return html(reply, 410, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${headTags(true)}<p style="font:16px ${FONT_FAMILY};padding:24px;color:var(--fg);background:var(--bg)">Ce lien a déjà servi ou a expiré. Demande-en un autre à Mell.</p>`);
    const en = (await getUser(db, l.userId))?.lang === "en";
    return html(reply, 200, PAGE(l.site, l.token, en));
  });

  http.get("/l/:token/frames", async (req, reply) => {
    const l = get((req.params as { token: string }).token);
    if (!l) return reply.code(410).send();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    if (l.lastFrame) reply.raw.write(`data: ${l.lastFrame}\n\n`);
    l.clients.add(reply);
    req.raw.on("close", () => l.clients.delete(reply));
    return reply;
  });

  http.post("/l/:token/input", async (req, reply) => {
    const l = get((req.params as { token: string }).token);
    if (!l) return reply.code(410).send({ error: "expiré" });
    const e = req.body as { type?: string; x?: number; y?: number; text?: string; key?: string; dy?: number };
    try {
      if (e.type === "tap" && typeof e.x === "number" && typeof e.y === "number") await l.page.mouse.click(Math.round(e.x * VIEW.width), Math.round(e.y * VIEW.height));
      else if (e.type === "text" && e.text) await l.page.keyboard.insertText(String(e.text).slice(0, 200));
      else if (e.type === "key" && ["Enter", "Backspace", "Tab", "Escape"].includes(String(e.key))) await l.page.keyboard.press(String(e.key));
      else if (e.type === "scroll" && typeof e.dy === "number") await l.page.mouse.wheel(0, Math.max(-2000, Math.min(2000, e.dy)));
    } catch {
      return reply.code(503).send({ error: "La saisie n'a pas pu être transmise." });
    }
    return { ok: true };
  });

  http.post("/l/:token/cancel", async (req, reply) => {
    const l = await endLive((req.params as { token: string }).token, false);
    return l ? { ok: true } : reply.code(410).send({ error: "expiré" });
  });

  http.post("/l/:token/done", async (req, reply) => {
    const token = (req.params as { token: string }).token;
    if (!get(token)) return reply.code(410).send({ error: "expiré" });
    let l: Live | undefined;
    try {
      l = await endLive(token, true);
    } catch {
      return reply.code(503).send({ error: "La session n'a pas pu être enregistrée. Réessaie." });
    }
    if (!l) return reply.code(410).send({ error: "expiré" });
    const user = await getUser(db, l.userId);
    await enqueue(db, [{ userId: l.userId, kind: "text", text: user.lang === "en" ? `The browser session for ${l.site} is saved.` : `La session du navigateur pour ${l.site} est enregistrée.` }]);
    // Une tâche attendait cette connexion : elle reprend là où elle s'était arrêtée.
    if (l.taskId) await createJob(db, deps.cfg as Config, l.userId, `[système] Elle a terminé la prise en main pour ${l.site}. La session du navigateur est enregistrée, mais l'état connecté n'a pas été vérifié. Vérifie-le avant de reprendre la tâche ${l.taskId}.`);
    return { ok: true };
  });
}

export { hostOf as liveHostOf };
