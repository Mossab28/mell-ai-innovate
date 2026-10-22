import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.ts";
import { sessionUser } from "./web/account.ts";
import { INK, esc, lockSvg, logoSvg, loopButton, page, siteLang } from "./web/da.ts";

/**
 * L'accueil, dans la langue du navigateur comme tout le site : le logo, « Request access » dessiné à la main, la description.
 * Grand écran : le bloc (logo + boucle) à gauche et la description à droite, visibles d'emblée, sans défilement
 * (décidé le 18/10 : « laisse les trucs à droite affichés de base »). Téléphone : le bloc, puis la description dessous.
 * Toucher le bouton ouvre le fil iMessage de Mell. Avec un code d'invitation valable (/i/<code>, le levier
 * de lancement d'Instinct : rareté, invitations, créateurs), la page dit « You're in » et le code part dans
 * le premier message (« Hi Mell! (k7q2) »), qui sert aussi d'attribution.
 */
/** Petits dessins au trait, un par exemple, comme les griffonnages d'Instinct. */
const D = {
  cancel: `<rect x="2" y="4" width="12" height="8.5" rx="1.8"/><path d="M2 7h12M4.5 10.5h3"/><path d="M10.5 1.5l4 4M14.5 1.5l-4 4"/>`,
  support: `<path d="M3 9.5V8a5 5 0 0 1 10 0v1.5"/><rect x="2" y="9" width="3" height="4" rx="1.2"/><rect x="11" y="9" width="3" height="4" rx="1.2"/><path d="M12.5 13c0 1.5-1.5 2-4 2"/>`,
  train: `<rect x="3.5" y="2.5" width="9" height="9" rx="2"/><path d="M3.5 7h9M6 14l-1 1.5M10 14l1 1.5M6.5 11v1.5M9.5 11v1.5"/>`,
  trip: `<path d="M2 13.5l3-10 3 6 2.5-3.5L14 13.5z"/><circle cx="11" cy="3.5" r="1.3"/>`,
  appointment: `<rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5 1.5v3M11 1.5v3"/><path d="M5.5 10.5l1.8 1.8L10.8 9"/>`,
};
const doodle = (k: keyof typeof D) =>
  `<svg class="dd" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${D[k]}</svg>`;

/** Défilement lié et lissé (grand écran) : le bloc (logo + boucle) reste épinglé et glisse à gauche ; le texte, à droite, monte ligne par ligne. Sur téléphone, la page défile normalement : le bloc, puis le texte dessous. */
const SCRIPT = `(function(){var hero=document.querySelector(".hero"),side=document.querySelector(".side"),lines=side.querySelectorAll("p"),more=document.querySelector(".more"),mob=matchMedia("(max-width:720px)");
var cur=0,tgt=0,raf=null;function span(){return innerHeight*1.2}
function paint(){if(mob.matches)return;var p=Math.max(0,Math.min(1,cur/span()));var e=1-Math.pow(1-p,3);
{hero.style.transform="translate("+(-50-e*58)+"%,-50%)";side.style.transform="translate("+(14-e*10)+"%,-50%)"}
side.style.opacity=Math.max(0,(p-.12)/.4);more.style.opacity=1-Math.min(1,p*3);
for(var i=0;i<lines.length;i++){var q=Math.max(0,Math.min(1,(p-.22-i*.07)/.2));lines[i].style.opacity=q;lines[i].style.transform="translateY("+((1-q)*14)+"px)"}}
function tick(){cur+=(tgt-cur)*.12;paint();if(Math.abs(tgt-cur)>.3)raf=requestAnimationFrame(tick);else{cur=tgt;paint();raf=null}}
function onScroll(){tgt=scrollY;if(!raf)raf=requestAnimationFrame(tick)}
addEventListener("scroll",onScroll,{passive:true});addEventListener("resize",function(){cur=tgt=scrollY;paint()});
more.addEventListener("click",function(){scrollTo({top:mob.matches?side.offsetTop-24:span(),behavior:"smooth"})});paint()})();`;

/** L'accueil dans la langue du site (celle du navigateur), comme toutes les autres pages. */
const HOME = {
  en: {
    request: "Request access", space: "Your space", inTitle: "You're in", inCta: "Get access",
    usedUp: "This invite has been used up. You can still request access.", preview: "A personal assistant that does things for you, by text.",
    privacy: "Privacy", legal: "Legal",
    side: `<p class="lead"><strong>Mell is a personal assistant that does things for you, by text.</strong></p>
<p>There is no app to install and nothing to learn. You text it, or call it, the way you would a friend who happens to be very organised. It can use the web and the accounts you choose to connect, the same way you do.</p>
<p class="ex">It can cancel a subscription ${doodle("cancel")}, deal with customer service for you ${doodle("support")}, find the right train ${doodle("train")}, plan a whole trip ${doodle("trip")}, or move a doctor's appointment ${doodle("appointment")}.</p>
<p>Mell runs on servers in Paris. Your data stays in <strong>Europe</strong>, encrypted, and is never used to train anything. Your passwords and cards live in a vault Mell can use but never see.</p>`,
  },
  fr: {
    request: "Demander l'accès", space: "Ton espace", inTitle: "Tu es dedans", inCta: "Entrer",
    usedUp: "Cette invitation est épuisée. Tu peux quand même demander l'accès.", preview: "Un assistant personnel qui fait les choses pour toi, par message.",
    privacy: "Confidentialité", legal: "Mentions légales",
    side: `<p class="lead"><strong>Mell est un assistant personnel qui fait les choses pour toi, par message.</strong></p>
<p>Pas d'app à installer, rien à apprendre. Tu lui écris, ou tu l'appelles, comme à un ami très organisé. Il se sert du web et des comptes que tu choisis de connecter, comme toi.</p>
<p class="ex">Il peut résilier un abonnement ${doodle("cancel")}, gérer le service client à ta place ${doodle("support")}, trouver le bon train ${doodle("train")}, organiser tout un voyage ${doodle("trip")}, ou déplacer un rendez-vous chez le médecin ${doodle("appointment")}.</p>
<p>Mell tourne sur des serveurs à Paris. Tes données restent en <strong>Europe</strong>, chiffrées, et ne servent jamais à entraîner quoi que ce soit. Tes mots de passe et tes cartes vivent dans un coffre que Mell utilise sans jamais les voir.</p>`,
  },
};

/** Les seules pages publiques à indexer (les autres portent noindex : légal, liens privés, invitations). */
const INDEXED = ["/", "/bot"];

export async function registerInviteRoutes(http: FastifyInstance, deps: { db: Db; publicUrl: string }): Promise<void> {
  const html = (reply: FastifyReply, code: number, body: string) =>
    reply.code(code).headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" }).send(body);

  const render = async (req: { headers: Record<string, unknown>; query?: unknown }, reply: FastifyReply, code?: string) => {
    const valid = !!code && /^[a-z0-9]{4,8}$/.test(code) && (await deps.db.query(`SELECT 1 FROM invites WHERE code = $1 AND uses_left > 0`, [code])).rows.length > 0;
    // Le compte, c'est le numéro : la boucle mène à la demande d'accès (ou à son espace si le navigateur est déjà connecté).
    const me = await sessionUser(deps.db, req as FastifyRequest);
    const sms = me ? "/me" : `/access${valid ? `?i=${code}` : ""}`;
    const lang = siteLang(req);
    const C = HOME[lang];
    const t = valid ? { title: C.inTitle, cta: C.inCta } : { title: "Mell", cta: me ? C.space : C.request };
    const note = code && !valid ? C.usedUp : "";
    return html(
      reply,
      200,
      page({
        lang,
        title: t.title,
        preview: C.preview,
        noindex: !!code,
        stage: true,
        body: `<span class="corner l"><a href="/" aria-label="Mell">${logoSvg(INK, 30).replace("<svg ", '<svg class="m" ')}</a></span>
<div class="scroller"><div class="pin">
<div class="hero">${logoSvg(INK, 200).replace("<svg ", '<svg class="logo big" ')}${valid ? `<h1>${esc(t.title)}</h1>` : ""}${note ? `<p>${esc(note)}</p>` : ""}${sms ? loopButton(t.cta, sms) : ""}</div>
<aside class="side calm">${C.side}</aside>
</div></div>
<footer class="bottom">© 2026 Mell · <a href="/privacy">${C.privacy}</a> · <a href="/legal">${C.legal}</a> · hello[at]askmell[dot]com</footer>
`,
      }),
    );
  };

  http.get("/", async (req, reply) => render(req, reply));
  // Ce que la loi demande à une page qui collecte des données (RGPD, LCEN) : court, à notre nom, sans le nom du fondateur.
  http.get("/privacy", async (_req, reply) =>
    html(reply, 200, page({ lang: "en", title: "Privacy", body: `<a class="corner l" href="/">${logoSvg("currentColor", 30).replace("<svg ", '<svg class="m" ')}</a><div class="doc"><h1>Privacy</h1>
<p>Mell is operated by the company behind askmell.com (details on the <a href="/legal">legal page</a>). We process the data needed to do what you ask: your phone number or iMessage address, your messages to Mell, and the accounts you choose to connect (mail, calendar, apps). Nothing else.</p>
<p>Your data is stored on servers in Paris (France), encrypted at rest. It is never sold, never shared for advertising, and never used to train any model. Secrets (passwords, cards) live in an encrypted vault Mell can use but never read.</p>
<p>Connected accounts can be disconnected at any time by telling Mell. You can ask Mell to delete your data; it is erased within 30 days. Legal basis: performance of the service you request (GDPR art. 6.1.b) and your consent for connected accounts (art. 6.1.a).</p>
<p>Questions or requests: <a href="mailto:privacy@askmell.com">privacy@askmell.com</a>.</p></div>` })));
  http.get("/legal", async (_req, reply) =>
    html(reply, 200, page({ lang: "en", title: "Legal", body: `<a class="corner l" href="/">${logoSvg("currentColor", 30).replace("<svg ", '<svg class="m" ')}</a><div class="doc"><h1>Legal</h1>
<p>askmell.com is published by [COMPANY], [legal form], registered in France under [RCS number], [registered address]. Contact: <a href="mailto:hello@askmell.com">hello@askmell.com</a>.</p>
<p>Hosting: Amazon Web Services EMEA SARL, 38 avenue John F. Kennedy, L-1855 Luxembourg (servers in Paris, eu-west-3).</p>
<p>Mell is an invite-only service in early access. Using it means you agree that Mell acts on your instructions, only within what you approve, and that you remain responsible for the accounts you connect.</p></div>` })));
  // La page publique du bot (annuaire Cloudflare, propriétaires de sites) : ce que Mell fait sur le web et comment il se signe.
  http.get("/bot", async (_req, reply) =>
    html(reply, 200, page({ lang: "en", title: "Mell on the web", noindex: false, preview: "How Mell visits websites on behalf of the people it assists, and how it identifies itself.", body: `<a class="corner l" href="/">${logoSvg("currentColor", 30).replace("<svg ", '<svg class="m" ')}</a><div class="doc"><h1>Mell on the web</h1>
<p>Mell is a personal assistant people talk to by text. When someone asks Mell to find a train, book a table or cancel a subscription, Mell visits the website the way that person would: one page at a time, at human pace, only while that request is being handled.</p>
<p>Mell does not crawl, index or archive. It never visits a site nobody asked for. Page content is used only to answer that one request, is not kept beyond it, and is never used to train any model. Bookings and purchases happen only after the person has approved them in the conversation, with their own accounts and payment details.</p>
<p>Every request Mell makes is signed with Web Bot Auth (HTTP Message Signatures, RFC 9421), so a site can verify it is really Mell. The public key is published at <a href="/.well-known/http-message-signatures-directory">askmell.com/.well-known/http-message-signatures-directory</a> (Ed25519, key id <code>SKjz6E1f7ojGBOjFzi1bCQSKwfdZ55oH-xSwRDRxZxw</code>). The <code>Signature-Agent</code> header names <code>askmell.com</code>.</p>
<p>Mell is operated by the company behind askmell.com (<a href="/legal">legal</a>, <a href="/privacy">privacy</a>), on servers in Paris. If you run a website and have a question, or would rather Mell did not visit it, write to <a href="mailto:hello@askmell.com">hello@askmell.com</a>: we honour it.</p></div>` })));
  http.get("/i/:code", async (req, reply) => render(req, reply, String((req.params as { code: string }).code ?? "").toLowerCase()));
  // Pour les moteurs (Search Console, 21/10) : les liens privés restent hors de leur chemin, le plan donne les pages publiques.
  const base = deps.publicUrl.replace(/\/+$/, "");
  http.get("/robots.txt", async (_req, reply) =>
    reply.type("text/plain; charset=utf-8").send(["User-agent: *", ...["/admin", "/me", "/access", "/v/", "/l/", "/c/", "/i/"].map((p) => `Disallow: ${p}`), "", `Sitemap: ${base}/sitemap.xml`, ""].join("\n")),
  );
  http.get("/sitemap.xml", async (_req, reply) =>
    reply
      .type("application/xml; charset=utf-8")
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${INDEXED.map((p) => `  <url><loc>${base}${p}</loc></url>`).join("\n")}\n</urlset>\n`),
  );
}
