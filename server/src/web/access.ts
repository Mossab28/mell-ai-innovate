import { createHash } from "node:crypto";
import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.ts";
import type { Config } from "../config.ts";
import { pickLine } from "../lines.ts";
import { findOrCreateUser } from "../users.ts";
import { sendWelcome } from "../welcome.ts";
import { attachToInviter } from "../invites.ts";
import { graphPage, graphData } from "./graph.ts";
import { INK, esc, logoSvg, page, siteLang } from "./da.ts";
import { sessionUser } from "./account.ts";
import { composePhone, phoneRow } from "./phone.ts";

/**
 * La demande d'accès (askmell.com → « Request access ») : numéro et mail gardés dans `access_requests`, Moss'Ab
 * accorde ou refuse depuis /admin, et Mell écrit en premier à la personne admise. Un code d'invitation encore
 * valable fait entrer tout de suite. Le compte web existant passe par /login (le code dans le fil).
 */

const T = {
  fr: {
    title: "Demander l'accès", lead: "Mell t'écrit dès qu'une place s'ouvre.", phone: "Ton numéro", phonePh: "6 12 34 56 78", email: "Ton e-mail", emailPh: "toi@exemple.fr",
    useEmail: "Pas de numéro ? Utilise ton e-mail", emailLead: "L'e-mail de ton compte Apple : Mell t'écrit dans Messages à cette adresse.", back: "Retour",
    send: "Demander l'accès", badPhone: "Ce numéro n'a pas l'air complet.", badEmail: "Cet e-mail n'a pas l'air complet.",
    done: "C'est noté.", doneLead: (_p: string) => "On revient vers toi très vite. Mell t'écrira directement dans Messages.",
    inTitle: "Tu es dedans.", inLead: "Mell vient de t'écrire. Ouvre Messages.", already: "Ce numéro a déjà accès.", login: "Recevoir mon code", home: "Accueil",
  },
  en: {
    title: "Request access", lead: "Mell texts you as soon as a spot opens.", phone: "Your number", phonePh: "6 12 34 56 78", email: "Your email", emailPh: "you@example.com",
    useEmail: "No number? Use your email", emailLead: "Your Apple account email: Mell texts you in Messages at that address.", back: "Back",
    send: "Request access", badPhone: "That number doesn't look complete.", badEmail: "That email doesn't look complete.",
    done: "Noted.", doneLead: (_p: string) => "We'll get back to you very soon. Mell will text you right in Messages.",
    inTitle: "You're in.", inLead: "Mell just texted you. Open Messages.", already: "This number already has access.", login: "Get my code", home: "Home",
  },
};
type Lang = keyof typeof T;
const langOf = (req: FastifyRequest): Lang => siteLang(req);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ADMIN_COOKIE = "mell_admin";

export interface AccessDeps {
  db: Db;
  cfg: Config;
}

/** Admin : le cookie posé par /admin/login?token=, ou la session web d'un numéro listé dans MELLA_ADMIN_HANDLES. */
export async function isAdminRequest(db: Db, cfg: Config, req: FastifyRequest): Promise<boolean> {
  if (cfg.adminToken) {
    const m = String(req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([a-f0-9]{64})`));
    if (m && m[1] === sha(cfg.adminToken)) return true;
  }
  if (cfg.adminHandles.length) {
    const u = await sessionUser(db, req);
    if (u && cfg.adminHandles.includes(u.handle)) return true;
  }
  return false;
}

/** Accorde une demande : la personne existe sur une ligne, active, et Mell lui écrit. */
export async function approveRequest(db: Db, id: string): Promise<{ ok: boolean; reason?: string }> {
  const r = (await db.query<{ id: string; phone: string | null; email: string | null; lang: string; status: string; invite_code: string | null }>(`SELECT id, phone, email, lang, status, invite_code FROM access_requests WHERE id = $1`, [id])).rows[0];
  if (!r) return { ok: false, reason: "demande inconnue" };
  if (r.status !== "pending") return { ok: false, reason: "déjà tranchée" };
  const line = await pickLine(db);
  if (!line) return { ok: false, reason: "aucune ligne libre" };
  const handle = r.phone ?? r.email;
  if (!handle) return { ok: false, reason: "ni numéro ni e-mail" };
  const { user, created } = await findOrCreateUser(db, handle, line.id, undefined, { inviteOnly: false });
  if (created) await db.query(`UPDATE users SET lang = $2 WHERE id = $1`, [user.id, r.lang]);
  // Entrée par le lien de quelqu'un : rangée sous lui dans l'arbre (le code a été consommé à la demande).
  if (created && r.invite_code) {
    const owner = (await db.query<{ owner_id: string | null }>(`SELECT owner_id FROM invites WHERE code = $1`, [r.invite_code])).rows[0];
    if (owner) await attachToInviter(db, user.id, { code: r.invite_code, ownerId: owner.owner_id });
  }
  if (user.status !== "active") await db.query(`UPDATE users SET status = 'active', admitted_at = now() WHERE id = $1`, [user.id]);
  await db.query(`UPDATE access_requests SET status = 'approved', decided_at = now(), user_id = $2 WHERE id = $1`, [id, user.id]);
  await sendWelcome(db, user.id);
  return { ok: true };
}

export async function registerAccessRoutes(http: FastifyInstance, deps: AccessDeps): Promise<void> {
  const { db, cfg } = deps;
  const html = (reply: FastifyReply, code: number, body: string) =>
    reply.code(code).headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" }).send(body);
  const shell = (lang: Lang, title: string, body: string) =>
    page({ lang, title, body: `<a class="corner l" href="/" aria-label="Mell">${logoSvg(INK, 30).replace("<svg ", '<svg class="m" ')}</a><div class="doc form">${body}</div>` });

  const SWITCH_JS = (leadPhone: string, leadEmail: string) =>
    `(function(){var a=document.getElementById("p-phone"),b=document.getElementById("p-email"),lead=document.getElementById("lead");
function go(from,to,text){from.classList.add("out");setTimeout(function(){from.hidden=true;from.classList.remove("out");from.querySelectorAll("input,select").forEach(function(i){i.disabled=true});to.hidden=false;to.querySelectorAll("input,select").forEach(function(i){i.disabled=false});to.classList.add("in");requestAnimationFrame(function(){requestAnimationFrame(function(){to.classList.remove("in")})});var f=to.querySelector("input");if(f)f.focus();lead.textContent=text},200)}
document.getElementById("to-email").onclick=function(){go(a,b,${JSON.stringify(leadEmail)})};document.getElementById("to-phone").onclick=function(){go(b,a,${JSON.stringify(leadPhone)})}})();`;

  /** Le numéro seul ; l'e-mail (adresse iMessage) arrive en secours, par la bascule en dessous. */
  const form = (lang: Lang, invite: string, cc: string, values: { phone?: string; email?: string } = {}, error?: string, pane: "phone" | "email" = "phone") => {
    const t = T[lang];
    const onPhone = pane === "phone";
    const dis = (html: string, on: boolean) => (on ? html : html.replace("<select", "<select disabled").replace('<input id="phone"', '<input disabled id="phone"'));
    return shell(
      lang,
      t.title,
      `<h1>${esc(t.title)}</h1><p id="lead">${esc(onPhone ? t.lead : t.emailLead)}</p>${error ? `<p role="alert" class="error">${esc(error)}</p>` : ""}<form method="post" action="/access" class="switch"><input type="hidden" name="i" value="${esc(invite)}">
<div class="pane" id="p-phone"${onPhone ? "" : " hidden"}>${dis(phoneRow(cc, t.phone, t.phonePh, values.phone), onPhone)}<button class="submit" type="submit">${esc(t.send)}</button><button class="alt" type="button" id="to-email">${esc(t.useEmail)}</button></div>
<div class="pane" id="p-email"${onPhone ? " hidden" : ""}><label for="email">${esc(t.email)}</label><input id="email" name="email" type="email" value="${esc(values.email ?? "")}" autocomplete="email" inputmode="email" placeholder="${esc(t.emailPh)}" required${onPhone ? " disabled" : ""}><button class="submit" type="submit">${esc(t.send)}</button><button class="alt" type="button" id="to-phone">${esc(t.back)}</button></div>
</form><script>${SWITCH_JS(t.lead, t.emailLead)}</script>`,
    );
  };

  await http.register(async (scope) => {
    await scope.register(formbody, { bodyLimit: 2048 });

    scope.get("/access", async (req, reply) => {
      if (await sessionUser(db, req)) return reply.redirect("/me");
      const lang = langOf(req);
      const invite = String((req.query as { i?: string }).i ?? "").toLowerCase();
      return html(reply, 200, form(lang, invite, "33"));
    });

    scope.post("/access", async (req, reply) => {
      const lang = langOf(req);
      const t = T[lang];
      const b = req.body as { cc?: string; phone?: string; email?: string; i?: string };
      const cc = String(b.cc ?? "33");
      const invite = String(b.i ?? "").toLowerCase();
      const byEmail = b.email !== undefined && b.phone === undefined;
      const phone = byEmail ? undefined : composePhone(cc, String(b.phone ?? ""));
      const email = byEmail ? String(b.email ?? "").trim().toLowerCase() : "";
      if (!byEmail && !phone) return html(reply, 400, form(lang, invite, cc, { phone: b.phone }, t.badPhone));
      if (byEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return html(reply, 400, form(lang, invite, cc, { email }, t.badEmail, "email"));
      const handle = phone ?? email;

      const existing = (await db.query<{ status: string }>(`SELECT status FROM users WHERE handle = $1`, [handle])).rows[0];
      if (existing?.status === "active") {
        return html(reply, 200, shell(lang, t.already, `<h1>${esc(t.already)}</h1><p>${esc(handle)}</p><a class="action" href="/login">${esc(t.login)}</a>`));
      }

      // Un code d'invitation encore valable fait entrer tout de suite : la demande est accordée dans la foulée.
      const valid = /^[a-z0-9]{4,8}$/.test(invite) && (await db.query(`UPDATE invites SET uses_left = uses_left - 1, used = used + 1 WHERE code = $1 AND uses_left > 0 RETURNING code`, [invite])).rows.length > 0;
      const pending = (
        await db.query<{ id: string }>(`SELECT id FROM access_requests WHERE status = 'pending' AND ${phone ? "phone = $1" : "phone IS NULL AND email = $1"} LIMIT 1`, [handle])
      ).rows[0];
      const id = pending
        ? pending.id
        : (
            await db.query<{ id: string }>(`INSERT INTO access_requests (phone, email, country, lang, invite_code) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
              phone ?? null,
              email || null,
              phone ? cc : null,
              lang,
              valid ? invite : null,
            ])
          ).rows[0].id;
      if (valid) {
        const r = await approveRequest(db, id);
        if (r.ok) return html(reply, 200, shell(lang, t.inTitle, `<h1>${esc(t.inTitle)}</h1><p>${esc(t.inLead)}</p>`));
      }
      return html(reply, 200, shell(lang, t.done, `<h1>${esc(t.done)}</h1><p>${esc(t.doneLead(handle))}</p><p class="assurance"><a href="/">${esc(t.home)}</a></p>`));
    });

    // --- Admin : accorder l'accès, suivre les invitations. Un cookie posé par le lien à jeton, ou sa session.
    scope.get("/admin/login", async (req, reply) => {
      const token = String((req.query as { token?: string }).token ?? "");
      if (!cfg.adminToken || token !== cfg.adminToken) return reply.code(401).send("non autorisé");
      reply.header("set-cookie", `${ADMIN_COOKIE}=${sha(token)}; Path=/; Max-Age=${90 * 86400}; HttpOnly; Secure; SameSite=Lax`);
      return reply.redirect("/admin");
    });

    const panel = async (reply: FastifyReply, notice?: string) => {
      const pending = (await db.query<any>(`SELECT id, phone, email, country, lang, created_at FROM access_requests WHERE status = 'pending' ORDER BY created_at`)).rows;
      const decided = (
        await db.query<any>(
          `SELECT r.phone, r.email, r.status, r.decided_at, u.status AS user_status, u.name,
                  (SELECT max(sent_at) FROM messages m WHERE m.user_id = u.id AND m.direction = 'in') AS last_in
           FROM access_requests r LEFT JOIN users u ON u.id = r.user_id
           WHERE r.status <> 'pending' ORDER BY r.decided_at DESC LIMIT 30`,
        )
      ).rows;
      const invites = (await db.query<any>(`SELECT i.code, i.label, i.uses_left, i.used, u.handle AS owner FROM invites i LEFT JOIN users u ON u.id = i.owner_id ORDER BY i.used DESC, i.code LIMIT 40`)).rows;
      const counts = (await db.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM users GROUP BY status`)).rows;
      const waiting = (await db.query<any>(`SELECT id, handle, lang, created_at FROM users WHERE status = 'waitlist' ORDER BY created_at`)).rows;
      const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
      const when = (d: string | Date | null) => (d ? new Date(d).toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-");
      const btn = (action: string, label: string, cls = "") => `<form method="post" action="${action}"><button class="btn small ${cls}" type="submit">${esc(label)}</button></form>`;
      const rows = pending.length
        ? `<ul class="list">${pending
            .map(
              (r) =>
                `<li><span><strong>${esc(r.phone ?? r.email)}</strong><br><small>${r.phone ? `${esc(r.email ?? "")} · ` : "e-mail only · "}${esc(r.lang)} · ${when(r.created_at)}</small></span><span class="acts">${btn(`/admin/access/${r.id}/approve`, "Approve")}${btn(`/admin/access/${r.id}/decline`, "Decline", "ghost")}</span></li>`,
            )
            .join("")}</ul>`
        : `<p class="assurance">Nobody waiting.</p>`;
      const past = decided.length
        ? `<ul class="list">${decided
            .map(
              (r) =>
                `<li><span><strong>${esc(r.phone ?? r.email)}</strong>${r.name ? ` · ${esc(r.name)}` : ""}<br><small>${esc(r.status)} ${when(r.decided_at)} · ${r.user_status === "active" ? `active${r.last_in ? `, last message ${when(r.last_in)}` : ", never wrote"}` : "no account"}</small></span></li>`,
            )
            .join("")}</ul>`
        : `<p class="assurance">Nothing yet.</p>`;
      const inv = invites.length
        ? `<ul class="list">${invites.map((i) => `<li><span><strong>${esc(i.code)}</strong>${i.label ? ` · ${esc(i.label)}` : ""}${i.owner ? ` · ${esc(i.owner)}` : ""}<br><small>${i.used} used, ${i.uses_left} left</small></span></li>`).join("")}</ul>`
        : `<p class="assurance">No invite yet.</p>`;
      return html(
        reply,
        200,
        page({
          lang: "en",
          title: "Mell admin",
          body: `<a class="corner l" href="/" aria-label="Mell">${logoSvg(INK, 30).replace("<svg ", '<svg class="m" ')}</a><div class="doc form admin"><p class="adminnav"><a href="/admin/graph">Invitation graph</a></p><h1>Access</h1><p>${n("active")} active · ${pending.length} request${pending.length === 1 ? "" : "s"} · ${waiting.length} waiting in the thread</p>${notice ? `<p class="safe">${esc(notice)}</p>` : ""}
<h2>Requests</h2>${rows}
${waiting.length ? `<h2>Wrote to Mell without an invite</h2><ul class="list">${waiting.map((u: any) => `<li><span><strong>${esc(u.handle)}</strong><br><small>${esc(u.lang)} · ${when(u.created_at)}</small></span><span class="acts">${btn(`/admin/waitlist/${u.id}/approve`, "Let in")}</span></li>`).join("")}</ul>` : ""}
<h2>Decided</h2>${past}
<h2>Invites</h2>${inv}</div>`,
        }),
      );
    };

    scope.get("/admin", async (req, reply) => {
      if (!(await isAdminRequest(db, cfg, req))) return reply.code(401).send("non autorisé");
      return panel(reply, (req.query as { n?: string }).n);
    });
    // Une action se termine sur /admin (le message dans l'adresse) : rendu à l'adresse du bouton, le panneau tombait en 404
    // dès que Safari rechargeait l'onglet (22/10). Même chose pour /admin/ et une action ouverte en GET.
    const done = (reply: FastifyReply, notice: string) => reply.redirect(`/admin?n=${encodeURIComponent(notice)}`, 303);
    scope.get("/admin/", async (_req, reply) => reply.redirect("/admin"));
    scope.get("/admin/:kind/:id/:action", async (_req, reply) => reply.redirect("/admin"));

    scope.post("/admin/access/:id/approve", async (req, reply) => {
      if (!(await isAdminRequest(db, cfg, req))) return reply.code(401).send("non autorisé");
      const id = String((req.params as { id: string }).id);
      if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.redirect("/admin");
      const r = await approveRequest(db, id);
      return done(reply, r.ok ? "Approved. Mell just texted them." : `Not approved: ${r.reason}`);
    });

    scope.get("/admin/graph", async (req, reply) => {
      if (!(await isAdminRequest(db, cfg, req))) return reply.code(401).send("non autorisé");
      return html(reply, 200, graphPage());
    });
    scope.get("/admin/graph.json", async (req, reply) => {
      if (!(await isAdminRequest(db, cfg, req))) return reply.code(401).send({ error: "non autorisé" });
      return reply.header("cache-control", "no-store").send(await graphData(db));
    });

    scope.post("/admin/waitlist/:id/approve", async (req, reply) => {
      if (!(await isAdminRequest(db, cfg, req))) return reply.code(401).send("non autorisé");
      const id = String((req.params as { id: string }).id);
      if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.redirect("/admin");
      const r = (await db.query(`UPDATE users SET status = 'active', admitted_at = now() WHERE id = $1 AND status = 'waitlist' RETURNING id`, [id])).rows[0];
      if (r) await sendWelcome(db, id);
      return done(reply, r ? "In. Mell just texted them." : "Already in.");
    });

    scope.post("/admin/access/:id/decline", async (req, reply) => {
      if (!(await isAdminRequest(db, cfg, req))) return reply.code(401).send("non autorisé");
      const id = String((req.params as { id: string }).id);
      if (/^[0-9a-f-]{36}$/i.test(id)) await db.query(`UPDATE access_requests SET status = 'declined', decided_at = now() WHERE id = $1 AND status = 'pending'`, [id]);
      return done(reply, "Declined.");
    });
  });
}
