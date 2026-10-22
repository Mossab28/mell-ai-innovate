import { createHash, randomBytes, randomInt } from "node:crypto";
import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { enqueue } from "../outbox.ts";
import { pickLine } from "../lines.ts";
import { inviteOf } from "../invites.ts";
import { sendPlainMail } from "../mail/outbound.ts";
import { addContactBubble, findOrCreateUser, mellVCard, welcomeBubbles } from "../users.ts";
import { waitlistBubbles } from "../invites.ts";
import type { AppsService } from "../apps/service.ts";
import { APP_CATALOG, APP_CATEGORIES, appInfo, isAppService, type AppService } from "../apps/catalog.ts";
import { issueLink } from "../vault/links.ts";
import type { VaultService } from "../vault/service.ts";
import type { VaultRef } from "../vault/types.ts";
import { composePhone, phoneRow } from "./phone.ts";
import { getPersonal, personalLabel, PERSONAL_INFO_FIELDS, setPersonal } from "../personal.ts";
import { forget, listFacts } from "../memory.ts";
import { INK, esc, lockSvg, logoSvg, page, siteLang } from "./da.ts";

/**
 * Le compte, c'est le numéro. « Request access » demande le numéro, Mell envoie un code à 6 chiffres dans le
 * fil iMessage (le premier message de Mell, pour qui ne l'a jamais écrit), la personne le tape, une session est
 * posée sur le navigateur, et elle arrive sur son espace (/me) : apps connectées, coffre, invitation, compte.
 * Si le fil ne répond pas (numéro pas sur iMessage), le code peut partir par mail, en secours seulement.
 * Les codes : 10 minutes, 5 essais. Les sessions : 30 jours, jeton aléatoire dont seul le haché est gardé.
 */

const COOKIE = "mell_s";
const CODE_TTL_MIN = 10;
const SESSION_DAYS = 30;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface AccountDeps {
  db: Db;
  cfg: Pick<Config, "publicUrl" | "invites" | "mail">;
  apps?: AppsService;
  vault?: VaultService;
  wake: (lineId: string) => void;
}

/** +33 6 12 34 56 78, 06 12 34 56 78, 0033… : un numéro E.164 ou rien. */
export function normalizePhone(raw: string): string | undefined {
  let v = raw.replace(/[\s.\-()]/g, "");
  if (v.startsWith("00")) v = `+${v.slice(2)}`;
  if (/^0\d{9}$/.test(v)) v = `+33${v.slice(1)}`;
  return /^\+\d{8,15}$/.test(v) ? v : undefined;
}

function cookieOf(req: FastifyRequest): string | undefined {
  const m = String(req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`));
  return m?.[1];
}

/** La personne connectée sur ce navigateur, ou undefined. */
export async function sessionUser(db: Pick<Db, "query">, req: FastifyRequest): Promise<{ id: string; handle: string; lang: string; status: string } | undefined> {
  const token = cookieOf(req);
  if (!token) return undefined;
  return (
    await db.query<{ id: string; handle: string; lang: string; status: string }>(
      `SELECT u.id, u.handle, u.lang, u.status FROM web_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha(token)],
    )
  ).rows[0];
}

const T = {
  fr: {
    access: "Demander l'accès", login: "Ton espace", phone: "Ton numéro", phoneHint: "Mell t'envoie un code dans Messages.", send: "Recevoir le code",
    useEmail: "Recevoir le code par e-mail", emailHint: "Le code part sur l'e-mail de ta demande d'accès.", back: "Retour",
    unknownPhone: "Pas encore de compte pour ce numéro. Demande l'accès depuis l'accueil.", unknownEmail: "Cet e-mail ne me dit rien. Essaie avec ton numéro.",
    badPhone: "Ce numéro n'a pas l'air complet.", code: "Le code", codeHint: (h: string) => `Envoyé dans Messages, au ${h}.`, verify: "Entrer",
    badCode: "Ce n'est pas ce code.", expired: "Code expiré. Redemande-en un.", notYet: "Pas reçu ? Le fil met parfois quelques secondes.",
    byMail: "Pas de Messages sur ce numéro ? Reçois le code par mail.", email: "Ton e-mail", sendMail: "Envoyer par mail", mailed: (e: string) => `Code envoyé à ${e}.`,
    mailFail: "Le mail n'est pas parti. Réessaie.", me: "Ton espace", active: "Compte actif.", waitlist: "Sur la liste d'attente : Mell t'écrit dès qu'une place s'ouvre.",
    apps: "Connecteurs", appsSub: "Ce que Mell peut utiliser pour toi.", connect: "Connecter", disconnect: "Déconnecter", 
    cats: { google: "Google", microsoft: "Microsoft", talk: "Messages et réunions", tasks: "Notes et tâches", files: "Fichiers et création", work: "Business", life: "Perso" },
    connectedCount: (n: number) => `${n} connecté${n > 1 ? "s" : ""}`, close: "Fermer", vaultNote: "Chiffré, jamais montré à l'IA", addCard: "Ajouter une carte", editPersonal: "Compléter",
    seeAll: (n: number) => `Voir les ${n} connecteurs`, seeLess: "Réduire", rmCard: "Retirer cette carte ?", rmLogin: "Retirer cet identifiant ?", rmInfo: "Retirer cette info ?", rmFact: "Oublier ça ?", forget: "Oublier", cancel: "Annuler",
    invites: (n: number) => `${n}`,
    logins: "Identifiants", noLogins: "Aucun.", cards: "Cartes", noCards: "Aucune.", add: "Ajouter", site: "Le site (ex. sncf-connect.com)",
    data: "Données", dataSub: "Ce que Mell a lu pour toi dans tes services connectés : mails, agenda, pages des apps.", erase: "Effacer", eraseDone: "C'est effacé.",
    personal: "Infos perso", noPersonal: "Aucune. Mell retient ton nom, ton e-mail ou ton adresse quand tu les lui donnes.",
    learned: "Ce que Mell a appris pour toi", noLearned: "Rien pour l'instant. Ce que tu lui dis de toi et la façon dont tu le reprends s'affichent ici.",
    vault: "Coffre", noVault: "Vide. Tes identifiants et tes cartes, quand Mell en a besoin.", remove: "Retirer", invite: "Inviter", inviteHint: (n: number) => (n ? `${n} invitation${n > 1 ? "s" : ""} restante${n > 1 ? "s" : ""}.` : "Toutes tes invitations sont parties."), shareText: "Je t'invite sur Mell, l'assistant qui fait les choses pour toi par message.", copied: "Lien copié",
    logout: "Se déconnecter", del: "Supprimer mon compte", delHint: "Tout est effacé : messages, coffre, connexions. Mell ne te connaîtra plus.", delConfirm: "Oui, supprimer",
    open: "Écrire à Mell", codeMsg: (c: string) => `Ton code Mell : ${c}`, codeMail: (c: string) => `Ton code Mell : ${c}\n\nIl est valable ${CODE_TTL_MIN} minutes.`,
  },
  en: {
    access: "Request access", login: "Your space", phone: "Your number", phoneHint: "Mell texts you a code in Messages.", send: "Get the code",
    useEmail: "Get the code by email instead", emailHint: "The code goes to the email of your access request.", back: "Back",
    unknownPhone: "No account for this number yet. Request access from the home page.", unknownEmail: "I don't know this email. Try your number.",
    badPhone: "That number doesn't look complete.", code: "The code", codeHint: (h: string) => `Sent in Messages, to ${h}.`, verify: "Enter",
    badCode: "That's not it.", expired: "Code expired. Ask for a new one.", notYet: "Not there yet? The thread sometimes takes a few seconds.",
    byMail: "No Messages on this number? Get the code by email.", email: "Your email", sendMail: "Send by email", mailed: (e: string) => `Code sent to ${e}.`,
    mailFail: "The email didn't go out. Try again.", me: "Your space", active: "Account active.", waitlist: "On the waiting list: Mell texts you as soon as a spot opens.",
    apps: "Connectors", appsSub: "What Mell can use for you.", connect: "Connect",
    disconnect: "Disconnect", 
    cats: { google: "Google", microsoft: "Microsoft", talk: "Chat and meetings", tasks: "Notes and tasks", files: "Files and design", work: "Business", life: "Personal" },
    connectedCount: (n: number) => `${n} connected`, close: "Close", vaultNote: "Encrypted, never shown to the AI", addCard: "Add a card", editPersonal: "Fill in",
    seeAll: (n: number) => `See all ${n} connectors`, seeLess: "Show less", rmCard: "Remove this card?", rmLogin: "Remove this login?", rmInfo: "Remove this info?", rmFact: "Forget this?", forget: "Forget", cancel: "Cancel",
    invites: (n: number) => `${n}`,
    logins: "Logins", noLogins: "None.", cards: "Cards", noCards: "None.", add: "Add", site: "The site (e.g. sncf-connect.com)",
    data: "Data", dataSub: "What Mell read for you in your connected services: emails, calendar, app pages.", erase: "Erase", eraseDone: "Erased.",
    personal: "Personal info", noPersonal: "None yet. Mell remembers your name, email or address when you give them.",
    learned: "What Mell learned for you", noLearned: "Nothing yet. What you tell Mell about yourself and how you correct it show up here.",
    vault: "Vault", noVault: "Empty. Your logins and cards, when Mell needs them.", remove: "Remove", invite: "Invite", inviteHint: (n: number) => (n ? `${n} invite${n > 1 ? "s" : ""} left.` : "All your invites are out."), shareText: "You're invited to Mell, the assistant that does things for you by text.", copied: "Link copied",
    logout: "Log out", del: "Delete my account", delHint: "Everything is erased: messages, vault, connections. Mell won't know you anymore.", delConfirm: "Yes, delete",
    open: "Text Mell", codeMsg: (c: string) => `Your Mell code: ${c}`, codeMail: (c: string) => `Your Mell code: ${c}\n\nIt is valid for ${CODE_TTL_MIN} minutes.`,
  },
};
/** Une ligne par connecteur, comme la page d'Instinct : ce que Mell en fait. */
const APP_LINES: Record<AppService, { fr: string; en: string }> = {
  gmail: { fr: "Lire, chercher, préparer et envoyer tes mails, avec ton accord.", en: "Read, search, draft and send your email, with your OK." },
  calendar: { fr: "Voir ton agenda, poser et déplacer tes rendez-vous.", en: "See your calendar, add and move events." },
  drive: { fr: "Retrouver et lire tes fichiers Drive, Docs et Sheets.", en: "Find and read your Drive files, Docs and Sheets." },
  sheets: { fr: "Lire et remplir tes feuilles de calcul.", en: "Read and fill in your spreadsheets." },
  outlook: { fr: "Lire, chercher et envoyer tes mails Outlook.", en: "Read, search and send your Outlook email." },
  onedrive: { fr: "Retrouver et lire tes fichiers OneDrive.", en: "Find and read your OneDrive files." },
  teams: { fr: "Lire tes conversations Teams, envoyer un message.", en: "Read your Teams chats, send a message." },
  slack: { fr: "Lire et chercher tes conversations, envoyer un message.", en: "Read and search your conversations, send a message." },
  zoom: { fr: "Voir et créer tes réunions Zoom.", en: "See and create your Zoom meetings." },
  calendly: { fr: "Voir tes rendez-vous et tes liens Calendly.", en: "See your Calendly bookings and links." },
  discord: { fr: "Lire tes salons, envoyer un message.", en: "Read your channels, send a message." },
  notion: { fr: "Chercher, lire et mettre à jour tes pages Notion.", en: "Search, read and update your Notion pages." },
  todoist: { fr: "Voir, créer et cocher tes tâches.", en: "See, create and check off your tasks." },
  asana: { fr: "Suivre et créer tes tâches Asana.", en: "Track and create your Asana tasks." },
  trello: { fr: "Tes tableaux et tes cartes.", en: "Your boards and cards." },
  clickup: { fr: "Suivre et créer tes tâches ClickUp.", en: "Track and create your ClickUp tasks." },
  linear: { fr: "Suivre et créer tes tickets.", en: "Track and create your issues." },
  jira: { fr: "Suivre et créer tes tickets Jira.", en: "Track and create your Jira issues." },
  airtable: { fr: "Lire et remplir tes bases.", en: "Read and fill in your bases." },
  dropbox: { fr: "Retrouver, lire et ranger tes fichiers.", en: "Find, read and organize your files." },
  github: { fr: "Tes dépôts, tes tickets et tes pull requests.", en: "Your repos, issues and pull requests." },
  figma: { fr: "Retrouver tes fichiers et leurs commentaires.", en: "Find your files and their comments." },
  canva: { fr: "Retrouver et exporter tes designs.", en: "Find and export your designs." },
  hubspot: { fr: "Tes contacts, entreprises et affaires.", en: "Your contacts, companies and deals." },
  stripe: { fr: "Tes paiements, clients et factures.", en: "Your payments, customers and invoices." },
  linkedin: { fr: "Ton profil, et publier pour toi avec ton accord.", en: "Your profile, and posting for you with your OK." },
  youtube: { fr: "Tes vidéos, playlists et abonnements.", en: "Your videos, playlists and subscriptions." },
  strava: { fr: "Tes activités et tes stats.", en: "Your activities and stats." },
};
/** Le nom affiché : « Google Agenda » est le nom français du catalogue ; en anglais, Google Calendar. */
const appName = (service: AppService, lang: "fr" | "en") => (lang === "en" && service === "calendar" ? "Google Calendar" : appInfo(service).name);
const logoOf = (service: AppService) => `https://logos.composio.dev/api/${appInfo(service).toolkit}`;

type Lang = keyof typeof T;
const langOf = (req: FastifyRequest, _account?: string): Lang => siteLang(req);

export async function registerAccountRoutes(http: FastifyInstance, deps: AccountDeps): Promise<void> {
  const { db, cfg } = deps;
  const base = cfg.publicUrl.replace(/\/+$/, "");
  const html = (reply: FastifyReply, code: number, body: string) =>
    reply.code(code).headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" }).send(body);
  const shell = (lang: Lang, title: string, body: string) =>
    page({ lang, title, lock: true, body: `<a class="corner l" href="/" aria-label="Mell">${logoSvg(INK, 30).replace("<svg ", '<svg class="m" ')}</a><div class="doc form">${body}</div>` });
  const field = (name: string, label: string, type: string, extra = "", value = "") => `<label for="${name}">${esc(label)}</label><input id="${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}>`;
  const setSession = async (reply: FastifyReply, userId: string) => {
    const token = randomBytes(32).toString("base64url");
    await db.query(`INSERT INTO web_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`, [sha(token), userId, SESSION_DAYS]);
    reply.header("set-cookie", `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`);
  };
  const clearSession = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = cookieOf(req);
    if (token) await db.query(`DELETE FROM web_sessions WHERE token_hash = $1`, [sha(token)]);
    reply.header("set-cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  };
  const issueCode = async (userId: string, lang: Lang, via: { thread?: true; email?: string }, purpose: "login" | "vault" = "login") => {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const { rows } = await db.query<{ id: string }>(`INSERT INTO web_codes (user_id, code_hash, email, expires_at, purpose) VALUES ($1, $2, $3, now() + make_interval(mins => $4), $5) RETURNING id`, [userId, "", via.email ?? null, CODE_TTL_MIN, purpose]);
    const id = rows[0].id;
    await db.query(`UPDATE web_codes SET code_hash = $2 WHERE id = $1`, [id, sha(`${id}:${code}`)]);
    return { id, code };
  };

  await http.register(async (scope) => {
    await scope.register(formbody, { bodyLimit: 2048 });

    // 1. Le numéro (ou l'e-mail de sa demande d'accès). Le compte existe déjà : ici on ne crée rien, on envoie un code.
    const SWITCH_JS = (leadPhone: string, leadEmail: string) =>
      `(function(){var a=document.getElementById("p-phone"),b=document.getElementById("p-email"),lead=document.getElementById("lead");
function go(from,to,text){from.classList.add("out");setTimeout(function(){from.hidden=true;from.classList.remove("out");from.querySelectorAll("input,select").forEach(function(i){i.disabled=true});to.hidden=false;to.querySelectorAll("input,select").forEach(function(i){i.disabled=false});to.classList.add("in");requestAnimationFrame(function(){requestAnimationFrame(function(){to.classList.remove("in")})});var f=to.querySelector("input");if(f)f.focus();lead.textContent=text},200)}
document.getElementById("to-email").onclick=function(){go(a,b,${JSON.stringify(leadEmail)})};document.getElementById("to-phone").onclick=function(){go(b,a,${JSON.stringify(leadPhone)})}})();`;
    const loginForm = (lang: Lang, cc: string, error?: string, values: { phone?: string; email?: string } = {}, pane: "phone" | "email" = "phone") => {
      const t = T[lang];
      const onPhone = pane === "phone";
      return shell(
        lang,
        t.login,
        `<div class="lock">${lockSvg(30, INK)}</div><h1>${esc(t.login)}</h1><p id="lead">${esc(onPhone ? t.phoneHint : t.emailHint)}</p>${error ? `<p role="alert" class="error">${esc(error)}</p>` : ""}<form method="post" action="/login" class="switch">
<div class="pane" id="p-phone"${onPhone ? "" : " hidden"}>${phoneRow(cc, t.phone, "6 12 34 56 78", values.phone).replace("<select", onPhone ? "<select" : "<select disabled").replace('<input id="phone"', onPhone ? '<input id="phone"' : '<input disabled id="phone"')}<button class="submit" type="submit">${esc(t.send)}</button><button class="alt" type="button" id="to-email">${esc(t.useEmail)}</button></div>
<div class="pane" id="p-email"${onPhone ? " hidden" : ""}><label for="email">${esc(t.email)}</label><input id="email" name="email" type="email" value="${esc(values.email ?? "")}" autocomplete="email" inputmode="email" placeholder="you@example.com" required${onPhone ? " disabled" : ""}><button class="submit" type="submit">${esc(t.sendMail)}</button><button class="alt" type="button" id="to-phone">${esc(t.back)}</button></div>
</form><script>${SWITCH_JS(t.phoneHint, t.emailHint)}</script>`,
      );
    };
    scope.get("/login", async (req, reply) => {
      if (await sessionUser(db, req)) return reply.redirect("/me");
      const lang = langOf(req);
      return html(reply, 200, loginForm(lang, "33"));
    });

    scope.post("/login", async (req, reply) => {
      const lang = langOf(req);
      const t = T[lang];
      const b = req.body as { cc?: string; phone?: string; email?: string };
      const cc = String(b.cc ?? "33");

      // Par l'e-mail de sa demande d'accès (ou d'un code déjà reçu par mail).
      if (b.email !== undefined && b.phone === undefined) {
        const email = String(b.email ?? "").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return html(reply, 400, loginForm(lang, cc, t.unknownEmail, { email }, "email"));
        const found =
          (await db.query<{ user_id: string }>(`SELECT user_id FROM access_requests WHERE email = $1 AND user_id IS NOT NULL ORDER BY decided_at DESC LIMIT 1`, [email])).rows[0] ??
          (await db.query<{ user_id: string }>(`SELECT user_id FROM web_codes WHERE email = $1 AND purpose = 'login' ORDER BY created_at DESC LIMIT 1`, [email])).rows[0];
        if (!found) return html(reply, 404, loginForm(lang, cc, t.unknownEmail, { email }, "email"));
        const fresh = await issueCode(found.user_id, lang, { email });
        const ok = await sendPlainMail(cfg, email, "Mell", t.codeMail(fresh.code));
        if (!ok) return html(reply, 502, loginForm(lang, cc, t.mailFail, { email }, "email"));
        return reply.redirect(`/login/code?t=${fresh.id}`);
      }

      const handle = composePhone(cc, String(b.phone ?? "")) ?? normalizePhone(String(b.phone ?? ""));
      if (!handle) return html(reply, 400, loginForm(lang, cc, t.badPhone, { phone: String(b.phone ?? "") }));
      const user = (await db.query<{ id: string; lang: string; line_id: string }>(`SELECT id, lang, line_id FROM users WHERE handle = $1`, [handle])).rows[0];
      if (!user) return html(reply, 404, loginForm(lang, cc, t.unknownPhone, { phone: String(b.phone ?? "") }));
      const { id, code } = await issueCode(user.id, lang, { thread: true });
      await enqueue(db, [{ userId: user.id, kind: "text", text: T[(user.lang as Lang) in T ? (user.lang as Lang) : lang].codeMsg(code), dedupeKey: `webcode:${id}` }]);
      deps.wake(user.line_id);
      return reply.redirect(`/login/code?t=${id}`);
    });

    // 2. Le code.
    const codePage = (lang: Lang, id: string, handle: string, error?: string, mailed?: string) => {
      const t = T[lang];
      return shell(
        lang,
        t.code,
        `<div class="lock">${lockSvg(30, INK)}</div><h1>${esc(t.code)}</h1><p>${esc(mailed ? t.mailed(mailed) : t.codeHint(handle))}</p>${error ? `<p role="alert" class="error">${esc(error)}</p>` : ""}<form method="post" action="/login/code"><input type="hidden" name="t" value="${esc(id)}">${field("code", t.code, "text", 'inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus')}<button class="submit" type="submit">${esc(t.verify)}</button></form>
<p class="assurance" id="st">${esc(t.notYet)}</p>
<details class="apple"><summary>${esc(t.byMail)}</summary><form method="post" action="/login/email"><input type="hidden" name="t" value="${esc(id)}">${field("email", t.email, "email", 'autocomplete="email" required')}<button class="submit" type="submit">${esc(t.sendMail)}</button></form></details>`,
      );
    };
    scope.get("/login/code", async (req, reply) => {
      const id = String((req.query as { t?: string }).t ?? "");
      const row = (await db.query<{ id: string; handle: string; lang: string; email: string | null }>(`SELECT c.id, u.handle, u.lang, c.email FROM web_codes c JOIN users u ON u.id = c.user_id WHERE c.id = $1 AND c.purpose = 'login' AND c.expires_at > now()`, [id])).rows[0];
      if (!row) return reply.redirect("/login");
      return html(reply, 200, codePage(langOf(req, row.lang), row.id, row.handle, undefined, row.email ?? undefined));
    });

    scope.post("/login/code", async (req, reply) => {
      const b = req.body as { t?: string; code?: string };
      const id = String(b.t ?? "");
      const row = (await db.query<{ id: string; user_id: string; handle: string; lang: string; code_hash: string; attempts: number; live: boolean; email: string | null }>(
        `SELECT c.id, c.user_id, u.handle, u.lang, c.code_hash, c.attempts, c.expires_at > now() AS live, c.email FROM web_codes c JOIN users u ON u.id = c.user_id WHERE c.id = $1 AND c.purpose = 'login' AND c.verified_at IS NULL`,
        [id],
      )).rows[0];
      const lang = langOf(req, row?.lang);
      const t = T[lang];
      if (!row || !row.live || row.attempts >= 5) return reply.redirect("/login");
      const code = String(b.code ?? "").replace(/\D/g, "");
      if (sha(`${row.id}:${code}`) !== row.code_hash) {
        await db.query(`UPDATE web_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
        return html(reply, 400, codePage(lang, row.id, row.handle, t.badCode, row.email ?? undefined));
      }
      await db.query(`UPDATE web_codes SET verified_at = now() WHERE id = $1`, [row.id]);
      await setSession(reply, row.user_id);
      return reply.redirect("/me");
    });

    // Le code est-il parti dans le fil ? (la page le demande toutes les deux secondes, pour proposer le mail au bon moment)
    scope.get("/login/status", async (req, reply) => {
      const id = String((req.query as { t?: string }).t ?? "");
      const r = (await db.query<{ status: string }>(`SELECT o.status FROM outbox o WHERE o.dedupe_key = $1`, [`webcode:${id}`])).rows[0];
      return reply.send({ status: r?.status ?? "unknown" });
    });

    // Secours : par mail.
    scope.post("/login/email", async (req, reply) => {
      const b = req.body as { t?: string; email?: string };
      const id = String(b.t ?? "");
      const row = (await db.query<{ id: string; user_id: string; handle: string; lang: string }>(`SELECT c.id, c.user_id, u.handle, u.lang FROM web_codes c JOIN users u ON u.id = c.user_id WHERE c.id = $1 AND c.purpose = 'login' AND c.expires_at > now() AND c.verified_at IS NULL`, [id])).rows[0];
      if (!row) return reply.redirect("/login");
      const lang = langOf(req, row.lang);
      const t = T[lang];
      const email = String(b.email ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return html(reply, 400, codePage(lang, row.id, row.handle, t.mailFail));
      const fresh = await issueCode(row.user_id, lang, { email });
      const ok = await sendPlainMail(cfg, email, "Mell", t.codeMail(fresh.code));
      if (!ok) return html(reply, 502, codePage(lang, row.id, row.handle, t.mailFail));
      return reply.redirect(`/login/code?t=${fresh.id}`);
    });

    // 3. Son espace. Connecteurs : des plateaux d'icônes par rubrique, une feuille qui monte au toucher (Connecter ou
    // Déconnecter). Coffre : un bloc sombre façon Wallet, visible dès qu'on est connecté (cartes dessinées, identifiants,
    // infos perso). Rien ne se déplie. Inviter vit en haut à droite.
    const ME_STYLE = `<style>
.doc.form{max-width:36rem}.me-h2{display:flex;align-items:baseline;justify-content:space-between;margin:40px 2px 12px}.me-h2 b{font-size:20px;font-weight:700;letter-spacing:-.3px}.me-h2 span{font-size:13px;color:#8a857b}
.tray{background:#fff;border-radius:24px;padding:18px 12px 16px;margin-top:12px;box-shadow:0 0 0 1px rgba(17,17,17,.05),0 1px 2px rgba(17,17,17,.04),0 8px 24px -12px rgba(17,17,17,.08)}
.tray>p{margin:0 8px 14px!important;font-size:12px!important;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#8a857b!important}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px 4px}@media (min-width:600px){.grid{grid-template-columns:repeat(6,1fr)}}
.tile{appearance:none;border:0;background:none;padding:0;margin:0;font:inherit;color:inherit;display:flex;flex-direction:column;align-items:center;gap:8px;cursor:pointer;-webkit-tap-highlight-color:transparent;min-width:0}
.tile .ic{position:relative;width:58px;height:58px;border-radius:17px;background:#F7F4EE;display:grid;place-items:center;box-shadow:inset 0 0 0 1px rgba(17,17,17,.06);transition:transform 160ms cubic-bezier(.23,1,.32,1)}
.tile:active .ic{transform:scale(.94)}.tile:focus-visible .ic{outline:2px solid #111;outline-offset:3px}.tile img{width:30px;height:30px;object-fit:contain}
.tile .nm{font-size:12px;font-weight:500;color:#3a3732;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2}
.tile .ok{position:absolute;top:-5px;right:-5px;width:21px;height:21px;border-radius:50%;background:#111;display:grid;place-items:center;box-shadow:0 0 0 2.5px #fff}
dialog.sheet{border:0;padding:0;margin:auto auto 0;width:100%;max-width:36rem;border-radius:30px 30px 0 0;background:#FBF9F4;color:#111;box-shadow:0 -10px 40px rgba(17,17,17,.18)}
@media (min-width:600px){dialog.sheet{margin:auto;border-radius:30px}}
dialog.sheet::backdrop{background:rgba(17,17,17,.38);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
dialog.sheet[open]{animation:up 260ms cubic-bezier(.23,1,.32,1)}@keyframes up{from{transform:translateY(24px);opacity:0}}
@media (prefers-reduced-motion:reduce){dialog.sheet[open]{animation:none}.tile .ic{transition:none}}
.sh{padding:12px 24px calc(28px + env(safe-area-inset-bottom));text-align:center}.sh i{display:block;width:40px;height:5px;border-radius:3px;background:rgba(17,17,17,.15);margin:0 auto 22px}
.sh .ic{width:72px;height:72px;border-radius:21px;background:#fff;display:grid;place-items:center;margin:0 auto 14px;box-shadow:0 0 0 1px rgba(17,17,17,.06),0 6px 18px -8px rgba(17,17,17,.2)}.sh .ic img{width:38px;height:38px;object-fit:contain}
.sh h3{font-size:22px;letter-spacing:-.3px;margin:0 0 6px}.sh p{margin:0 auto 6px!important;max-width:22rem;color:#5f5a52!important;font-size:15px!important}.sh small{display:block;color:#8a857b;font-size:13px;margin-bottom:6px}
.sh form{margin:22px 0 0}.sh .go{width:100%;min-height:54px;border:0;border-radius:999px;background:#111;color:#F5F0E6;font:inherit;font-size:16px;font-weight:700;cursor:pointer}.sh .go.off{background:transparent;color:#b3261e;box-shadow:inset 0 0 0 1.5px rgba(179,38,30,.5)}
.sh .x{margin-top:10px;width:100%;min-height:48px;border:0;background:none;font:inherit;font-size:15px;font-weight:600;color:#5f5a52;cursor:pointer}
.vault{margin-top:12px;background:#121110;color:#F5F0E6;border-radius:28px;padding:22px 18px 18px;box-shadow:0 18px 40px -20px rgba(17,17,17,.55)}
.vault .vt{display:flex;align-items:center;gap:10px;margin:0 4px 18px}.vault .vt b{font-size:17px}.vault .vt span{margin-left:auto;font-size:12px;color:#8f897d}
.vault h4{margin:22px 4px 10px;font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#8f897d}
.wallet{display:flex;flex-direction:column;align-items:center}
.cc{position:relative;width:100%;max-width:340px;height:204px;border-radius:18px;padding:20px 22px;display:flex;flex-direction:column;justify-content:space-between;background:linear-gradient(140deg,#3a362f 0%,#1f1d19 55%,#151410 100%);box-shadow:inset 0 0 0 1px rgba(255,255,255,.09),0 -8px 24px -10px rgba(0,0,0,.6)}
.cc+.cc{margin-top:-146px}
.cc .br{font-weight:900;font-size:19px;letter-spacing:.5px;font-style:italic}.cc .chip{width:36px;height:27px;border-radius:6px;background:linear-gradient(135deg,#dccb98,#a6935a);opacity:.9}
.cc .no{font-size:18px;letter-spacing:2.5px;font-variant-numeric:tabular-nums}.cc form{position:absolute;top:10px;right:10px;margin:0}
.wallet .addc{margin-top:14px;width:100%;max-width:340px}.wallet .addc .pill{width:100%}
.rows{background:#1c1b18;border-radius:18px;padding:2px 0}.rows>div{display:flex;align-items:center;gap:12px;min-height:56px;padding:6px 6px 6px 14px}.rows>div+div{box-shadow:0 -1px 0 rgba(245,240,230,.07)}
.rows .mono{width:34px;height:34px;border-radius:10px;background:#2b2925;display:grid;place-items:center;font-weight:700;font-size:15px;color:#e9e3d6;flex:none;text-transform:uppercase}
.rows .tx{flex:1;min-width:0}.rows .tx b{display:block;font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rows .tx small{display:block;font-size:12px;color:#8f897d;margin-bottom:1px}.rows .tx small::first-letter{text-transform:uppercase}
.rows form{margin:0;flex:none}.del{width:40px;height:40px;border:0;border-radius:12px;background:none;display:grid;place-items:center;cursor:pointer;color:#8f897d}.del:hover{background:rgba(245,240,230,.06)}
.cc .del{width:30px;height:30px;color:#cfc8ba}
.rows .add{display:flex;gap:8px;padding:10px}.rows .add input{flex:1;min-width:0;min-height:44px;border:0;border-radius:12px;background:#121110;color:#F5F0E6;padding:0 14px;font:inherit;font-size:15px;box-shadow:inset 0 0 0 1px rgba(245,240,230,.08)}
.pill{min-height:44px;padding:0 16px;border:0;border-radius:999px;background:#F5F0E6;color:#111;font:inherit;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap}.pill.ghost{background:transparent;color:#e9e3d6;box-shadow:inset 0 0 0 1px rgba(245,240,230,.18)}
.vault .vmore{margin:12px 0 0;display:flex}.vault .vmore form{margin:0}
.light{background:#fff;border-radius:22px;margin-top:12px;box-shadow:0 0 0 1px rgba(17,17,17,.05),0 1px 2px rgba(17,17,17,.04)}.light>div{display:flex;align-items:center;gap:12px;min-height:56px;padding:8px 8px 8px 18px;font-size:15px}.light>div+div{box-shadow:0 -1px 0 rgba(17,17,17,.06)}.light>div>span{flex:1;min-width:0;overflow-wrap:anywhere}.light form{margin:0}.light .del{color:#8a857b}.light .del:hover{background:rgba(17,17,17,.05)}.light .empty{color:#8a857b;font-size:14px}
.pin .tile:nth-child(n+5){display:none}@media (min-width:600px){.pin .tile:nth-child(n+5){display:flex}}
.seeall{display:flex;width:100%;justify-content:center;align-items:center;gap:8px;margin:16px 0 -4px;min-height:46px;border:0;border-top:1px solid rgba(17,17,17,.06);background:none;font:inherit;font-size:14px;font-weight:600;color:#3a3732;padding:10px 0 0;cursor:pointer}
.seeall svg{transition:transform 280ms cubic-bezier(.23,1,.32,1)}.seeall[aria-expanded=true] svg{transform:rotate(180deg)}
.allapps{display:grid;grid-template-rows:0fr;transition:grid-template-rows 380ms cubic-bezier(.23,1,.32,1)}.allapps.open{grid-template-rows:1fr}.allapps>.inner{overflow:hidden;min-height:0}
.allapps>.inner>.tray{opacity:0;transform:translateY(-6px);transition:opacity 240ms ease,transform 300ms cubic-bezier(.23,1,.32,1)}.allapps.open>.inner>.tray{opacity:1;transform:none}
.cc,.rows>div,.light>div{position:relative}.cc.out{transform:translateY(-14px) scale(.96);opacity:0;transition:transform 280ms cubic-bezier(.23,1,.32,1),opacity 220ms ease}
.rows>div.out,.light>div.out{opacity:0;transform:translateX(18px);transition:transform 280ms cubic-bezier(.23,1,.32,1),opacity 220ms ease}
.confirm{position:absolute;inset:0;z-index:2;display:flex;align-items:center;gap:8px;padding:0 8px 0 16px;border-radius:inherit;background:rgba(18,17,16,.9);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);color:#F5F0E6;animation:cin 180ms cubic-bezier(.23,1,.32,1)}
.confirm.bye{opacity:0;transition:opacity 150ms ease}@keyframes cin{from{opacity:0}}
.confirm span{flex:1;min-width:0;font-size:14px;font-weight:600}.confirm button{min-height:38px;padding:0 14px;border:0;border-radius:999px;font:inherit;font-size:14px;font-weight:700;cursor:pointer}
.confirm .cno{background:transparent;color:#cfc8ba}.confirm .cyes{background:#e5484d;color:#fff}
.cc .confirm{flex-direction:column;justify-content:center;gap:14px;padding:16px;text-align:center}.cc .confirm span{flex:none;font-size:16px}.cc .confirm .cyes{order:1;min-width:150px}.cc .confirm .cno{order:2}
.light .confirm{background:rgba(255,255,255,.94);color:#111}.light .confirm .cno{color:#5f5a52}
@media (prefers-reduced-motion:reduce){.allapps,.allapps>.inner>.tray,.cc.out,.rows>div.out,.light>div.out,.seeall svg{transition:none}.confirm{animation:none}}
.btn.danger{background:transparent;color:#b3261e;border:2px solid #b3261e}
.corner.r.inv{display:flex;align-items:center;gap:8px;min-height:38px;padding:0 6px 0 15px;border:0;border-radius:999px;background:#111;color:#F5F0E6;font:inherit;font-size:14px;font-weight:700;cursor:pointer}.corner.r.inv b{min-width:26px;height:26px;border-radius:999px;background:#F5F0E6;color:#111;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-variant-numeric:tabular-nums}
</style>`;
    const X_SVG = `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
    const OK_SVG = `<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="#F5F0E6" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const CHEVRON = `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 5.2l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const ALL_JS = `(function(){var b=document.querySelector(".seeall"),a=document.getElementById("allapps");if(!b||!a)return;var i=a.firstElementChild;b.onclick=function(){var o=!a.classList.contains("open");a.classList.toggle("open",o);b.setAttribute("aria-expanded",o?"true":"false");b.firstElementChild.textContent=o?b.dataset.close:b.dataset.open;if(o)i.removeAttribute("inert");else i.setAttribute("inert","")}})();`;
    const RM_JS = `(function(){document.querySelectorAll("form.rm").forEach(function(f){f.addEventListener("submit",function(e){if(f.dataset.ok)return;e.preventDefault();var h=f.closest(".cc,.rows>div,.light>div");if(!h||h.classList.contains("arm"))return;
document.querySelectorAll(".arm .confirm .cno").forEach(function(n){n.click()});h.classList.add("arm");var c=document.createElement("div");c.className="confirm";c.innerHTML='<span></span><button type="button" class="cno"></button><button type="button" class="cyes"></button>';
c.querySelector("span").textContent=f.dataset.q;var no=c.querySelector(".cno"),yes=c.querySelector(".cyes");no.textContent=f.dataset.no;yes.textContent=f.dataset.yes;
no.onclick=function(){c.classList.add("bye");h.classList.remove("arm");setTimeout(function(){c.remove()},160)};yes.onclick=function(){h.classList.add("out");setTimeout(function(){f.dataset.ok="1";f.submit()},280)};h.appendChild(c);yes.focus()})})})();`;
    const SHORT: Partial<Record<AppService, string>> = { calendar: "Agenda", drive: "Drive", sheets: "Sheets", teams: "Teams" };
    // Retirer demande une confirmation sur place (la carte ou la ligne s'assombrit, « Retirer » ou « Annuler »), puis glisse
    // avant l'envoi. Sans JavaScript, le formulaire part tel quel.
    const del = (action: string, hidden: Record<string, string>, label: string, ask = "", yes = "", no = "") =>
      `<form method="post" action="${action}" class="rm" data-q="${esc(ask)}" data-yes="${esc(yes)}" data-no="${esc(no)}">${Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("")}<button class="del" type="submit" aria-label="${esc(label)}">${X_SVG}</button></form>`;
    const btnOf = (action: string, hidden: Record<string, string>, label: string, cls = "ghost") =>
      `<form method="post" action="${action}">${Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("")}<button class="btn small ${cls}" type="submit">${esc(label)}</button></form>`;
    const cardOf = (ref: string, name: string) => {
      const m = /card\/([a-z]+)-(\d{4})$/.exec(ref);
      const brand = m ? ({ visa: "VISA", mastercard: "mastercard", amex: "AMEX", discover: "DISCOVER" } as Record<string, string>)[m[1]] ?? m[1].toUpperCase() : "";
      return { brand, last4: m?.[2] ?? (/(\d{4})\s*$/.exec(name)?.[1] ?? "") };
    };

    const me = async (req: FastifyRequest, reply: FastifyReply, notice?: string) => {
      const u = await sessionUser(db, req);
      if (!u) return reply.redirect("/login");
      const lang = langOf(req, u.lang);
      const t = T[lang];
      const apps = deps.apps ? (await deps.apps.connected(db, u.id)).filter((a) => !a.pending) : [];
      const entries = deps.vault ? await deps.vault.list(db, u.id) : [];
      const personal = await getPersonal(db, u.id);
      const logins = entries.filter((e) => e.kind !== "card" && e.kind !== "personal" && e.kind !== "totp");
      const cards = entries.filter((e) => e.kind === "card");
      const filled = PERSONAL_INFO_FIELDS.filter((f) => personal[f]);
      // Ce que Mell a appris pour elle : ses souvenirs et ses leçons (sa façon de faire, tirée de ses reprises). Elle efface ce qu'elle veut.
      const facts = await listFacts(db, u.id);
      const lessons = (await db.query<{ id: string; description: string; body: string }>(`SELECT id::text, description, body FROM skills WHERE scope = 'user' AND user_id = $1 AND status <> 'archived' ORDER BY id`, [u.id])).rows;
      const invite = await inviteOf(db, u.id);
      const line = await pickLine(db);
      const tile = (service: AppService) => {
        const c = apps.find((x) => x.service === service);
        const login = c?.login && c.login.includes("@") ? c.login : "";
        return `<button class="tile" type="button" data-s="${esc(service)}" data-n="${esc(appName(service, lang))}" data-d="${esc(APP_LINES[service][lang])}" data-l="${esc(login)}" data-on="${c ? "1" : ""}" data-i="${esc(logoOf(service))}"><span class="ic"><img src="${esc(logoOf(service))}" alt="" loading="lazy">${c ? `<span class="ok">${OK_SVG}</span>` : ""}</span><span class="nm">${esc(SHORT[service] && lang === "fr" ? SHORT[service]! : appName(service, lang).replace(/^(Google|Microsoft) /, ""))}</span></button>`;
      };
      const on = APP_CATALOG.filter((a) => apps.some((x) => x.service === a.service)).map((a) => a.service);
      const PIN: AppService[] = ["gmail", "calendar", "notion", "slack", "drive", "outlook"];
      const pinned = [...new Set([...on, ...PIN])].slice(0, 6);
      const groups = APP_CATEGORIES.map((k) => [t.cats[k], APP_CATALOG.filter((a) => a.cat === k).map((a) => a.service)] as const);
      const inviteUrl = invite ? `${base}/i/${invite.code}` : "";
      const SHEET_JS = `(function(){var d=document.getElementById("sheet");if(!d||!d.showModal)return;var q=function(s){return d.querySelector(s)};
document.querySelectorAll(".tile").forEach(function(b){b.onclick=function(){var on=!!b.dataset.on;q(".ic img").src=b.dataset.i;q("h3").textContent=b.dataset.n;q("p").textContent=b.dataset.d;var s=q("small");s.textContent=b.dataset.l||"";s.hidden=!b.dataset.l;
var f=q("form");f.action=on?"/me/apps/disconnect":"/me/apps/connect";q("input[name=service]").value=b.dataset.s;var g=q(".go");g.textContent=on?${JSON.stringify(t.disconnect)}:${JSON.stringify(t.connect)};g.className=on?"go off":"go";d.showModal()}});
q(".x").onclick=function(){d.close()};d.addEventListener("click",function(e){if(e.target===d)d.close()})})();`;
      return html(
        reply,
        200,
        shell(
          lang,
          t.me,
          `${invite && invite.uses_left ? `<button class="corner r inv" type="button" id="share" data-url="${esc(inviteUrl)}" data-text="${esc(t.shareText)}" data-done="${esc(t.copied)}" aria-label="${esc(t.inviteHint(invite.uses_left))}">${esc(t.invite)}<b>${esc(t.invites(invite.uses_left))}</b></button><script>(function(){var b=document.getElementById("share");if(!b)return;b.onclick=function(){var u=b.dataset.url,t=b.dataset.text;if(navigator.share){navigator.share({title:"Mell",text:t,url:u}).catch(function(){});return}(navigator.clipboard?navigator.clipboard.writeText(u):Promise.reject()).then(function(){var l=b.innerHTML;b.textContent=b.dataset.done;setTimeout(function(){b.innerHTML=l},1600)}).catch(function(){prompt("",u)})}})();</script>` : ""}${ME_STYLE}
<div class="lock">${lockSvg(30, INK)}</div><h1>${esc(t.me)}</h1><p>${esc(u.handle)} · ${esc(u.status === "active" ? t.active : t.waitlist)}</p>${notice ? `<p class="safe">${esc(notice)}</p>` : ""}
${line ? `<a class="action" href="sms:${esc(line.handle)}">${esc(t.open)}</a>` : ""}
<div class="me-h2"><b>${esc(t.apps)}</b><span>${on.length ? esc(t.connectedCount(on.length)) : ""}</span></div>
<div class="tray"><div class="grid pin">${pinned.map(tile).join("")}</div><button class="seeall" type="button" aria-expanded="false" aria-controls="allapps" data-open="${esc(t.seeAll(APP_CATALOG.length))}" data-close="${esc(t.seeLess)}"><span>${esc(t.seeAll(APP_CATALOG.length))}</span>${CHEVRON}</button></div>
<div class="allapps" id="allapps"><div class="inner" inert>${groups.map(([title, list]) => `<div class="tray"><p>${esc(title)}</p><div class="grid">${list.map(tile).join("")}</div></div>`).join("")}</div></div><script>${ALL_JS}</script>
<dialog class="sheet" id="sheet" aria-labelledby="sheet-t"><div class="sh"><i></i><div class="ic"><img src="" alt=""></div><h3 id="sheet-t"></h3><small hidden></small><p></p><form method="post"><input type="hidden" name="service" value=""><button class="go" type="submit"></button></form><button class="x" type="button">${esc(t.close)}</button></div></dialog><script>${SHEET_JS}</script>
<div class="me-h2" id="coffre"><b>${esc(t.vault)}</b><span>${esc(t.vaultNote)}</span></div>
<section class="vault">
<h4 style="margin-top:2px">${esc(t.cards)}</h4><div class="wallet">${cards.map((e) => { const c = cardOf(e.ref, e.name); return `<div class="cc"><span class="br">${esc(c.brand)}</span><span class="chip"></span><span class="no">•••• ${esc(c.last4)}</span>${del("/me/vault/delete", { ref: e.ref }, `${t.remove} ${e.name}`, t.rmCard, t.remove, t.cancel)}</div>`; }).join("")}<form method="post" action="/me/vault/add" class="addc"><input type="hidden" name="kind" value="card"><button class="pill ghost" type="submit">+ ${esc(t.addCard)}</button></form></div>
<h4>${esc(t.logins)}</h4><div class="rows">${logins.map((e) => `<div><span class="mono">${esc(e.name.replace(/^www\./, "").charAt(0))}</span><span class="tx"><b>${esc(e.name)}</b></span>${del("/me/vault/delete", { ref: e.ref }, `${t.remove} ${e.name}`, t.rmLogin, t.remove, t.cancel)}</div>`).join("")}<form method="post" action="/me/vault/add" class="add"><input type="hidden" name="kind" value="login"><input name="site" placeholder="${esc(t.site)}" required autocomplete="off" aria-label="${esc(t.site)}"><button class="pill" type="submit">${esc(t.add)}</button></form></div>
<h4>${esc(t.personal)}</h4><div class="rows">${filled.map((f) => `<div><span class="tx"><small>${esc(personalLabel(f, lang))}</small><b>${esc(personal[f] ?? "")}</b></span>${del("/me/personal/delete", { field: f }, `${t.remove} ${personalLabel(f, lang)}`, t.rmInfo, t.remove, t.cancel)}</div>`).join("")}${filled.length ? "" : `<div><span class="tx"><small>${esc(t.noPersonal)}</small></span></div>`}</div>
<div class="vmore"><form method="post" action="/me/vault/add"><input type="hidden" name="kind" value="personal"><button class="pill ghost" type="submit">${esc(filled.length ? t.editPersonal : `+ ${t.add}`)}</button></form></div>
</section>
<div class="me-h2"><b>${esc(t.learned)}</b><span>${facts.length + lessons.length || ""}</span></div>
<div class="light">${facts.length || lessons.length ? `${facts.map((f) => `<div><span>${esc(f.fact)}</span>${del("/me/learned/delete", { fact: String(f.id) }, t.remove, t.rmFact, t.forget, t.cancel)}</div>`).join("")}${lessons.map((l) => `<div><span>${esc(l.description)}</span>${del("/me/learned/delete", { lesson: l.id }, t.remove, t.rmFact, t.forget, t.cancel)}</div>`).join("")}` : `<div><span class="empty">${esc(t.noLearned)}</span></div>`}</div>
<div class="me-h2"><b>${esc(t.data)}</b><span></span></div>
<div class="light"><div><span class="empty">${esc(t.dataSub)}</span>${btnOf("/me/data/erase", {}, t.erase, "danger")}</div></div>
<div class="row left">${btnOf("/me/logout", {}, t.logout)}${btnOf("/me/delete", {}, t.del)}</div><script>${RM_JS}</script>`,
        ),
      );
    };
    scope.get("/me", async (req, reply) => me(req, reply));
    // L'ancienne page du coffre (21/10 matin) : le coffre est maintenant dans l'espace.
    scope.get("/me/coffre", async (_req, reply) => reply.redirect("/me#coffre"));

    scope.post("/me/apps/disconnect", async (req, reply) => {
      const u = await sessionUser(db, req);
      if (!u) return reply.redirect("/login");
      const service = String((req.body as { service?: string }).service ?? "") as AppService;
      if (deps.apps && service) await deps.apps.disconnect(db, u.id, service).catch(() => false);
      return reply.redirect("/me");
    });

    // Connecter une app depuis son espace : même parcours que le lien du fil (page Mell, puis l'écran de l'app).
    scope.post("/me/apps/connect", async (req, reply) => {
      const u = await sessionUser(db, req);
      if (!u) return reply.redirect("/login");
      const service = String((req.body as { service?: string }).service ?? "");
      if (!deps.apps || !isAppService(service)) return reply.redirect("/me");
      const url = await deps.apps.connect(db, u.id, service).catch(() => undefined);
      return reply.redirect(url ?? "/me");
    });

    // Ranger un identifiant, une carte ou ses infos : la page sécurisée du coffre, comme le lien que Mell envoie.
    scope.post("/me/vault/add", async (req, reply) => {
      const u = await sessionUser(db, req);
      if (!u) return reply.redirect("/login");
      const b = req.body as { kind?: string; site?: string };
      const kind = b.kind === "card" || b.kind === "personal" || b.kind === "login" ? b.kind : undefined;
      if (!kind) return reply.redirect("/me");
      const link = await issueLink(db, base, { userId: u.id, kind, site: kind === "login" ? String(b.site ?? "").trim() || undefined : undefined }).catch(() => undefined);
      return reply.redirect(link?.url ?? "/me");
    });

    // Effacer ce que Mell a lu dans ses services (comme « External data » chez Instinct) : les résultats de ses lectures
    // Gmail, Agenda et apps, et les mails reçus sur son adresse Mell. Les connexions restent ; le compte aussi.
    scope.post("/me/data/erase", async (req, reply) => {
      const u = await sessionUser(db, req);
      if (!u) return reply.redirect("/login");
      await db.query(`DELETE FROM tool_calls WHERE user_id = $1 AND (name LIKE 'gmail\\_%' OR name LIKE 'calendar\\_%' OR name IN ('app_do', 'inbox_read'))`, [u.id]);
      await db.query(`DELETE FROM inbox WHERE user_id = $1`, [u.id]);
      return me(req, reply, T[langOf(req, u.lang)].eraseDone);
    });

    scope.post("/me/personal/delete", async (req, reply) => {
      const u = await sessionUser(db, req);
      if (!u) return reply.redirect("/login");
      const field = String((req.body as { field?: string }).field ?? "");
      if ((PERSONAL_INFO_FIELDS as readonly string[]).includes(field)) await setPersonal(db, u.id, { [field]: null });
      return reply.redirect("/me#coffre");
    });

    scope.post("/me/learned/delete", async (req, reply) => {
      const u = await sessionUser(db, req);
      if (!u) return reply.redirect("/login");
      const b = req.body as { fact?: string; lesson?: string };
      if (b.fact) await forget(db, u.id, Number(b.fact));
      if (b.lesson && /^\d+$/.test(b.lesson)) await db.query(`DELETE FROM skills WHERE id = $1 AND scope = 'user' AND user_id = $2`, [b.lesson, u.id]);
      return reply.redirect("/me");
    });

    scope.post("/me/vault/delete", async (req, reply) => {
      const u = await sessionUser(db, req);
      if (!u) return reply.redirect("/login");
      const ref = String((req.body as { ref?: string }).ref ?? "") as VaultRef;
      if (deps.vault && ref.startsWith("vault://")) await deps.vault.deleteEntry(db, u.id, ref, { actor: "user_link", detail: "web" }).catch(() => false);
      return reply.redirect("/me#coffre");
    });

    scope.post("/me/logout", async (req, reply) => {
      await clearSession(req, reply);
      return reply.redirect("/");
    });

    scope.post("/me/delete", async (req, reply) => {
      const u = await sessionUser(db, req);
      if (!u) return reply.redirect("/login");
      const lang = langOf(req, u.lang);
      const t = T[lang];
      const b = req.body as { confirm?: string };
      if (b.confirm !== "yes") {
        return html(reply, 200, shell(lang, t.del, `<div class="lock">${lockSvg(30, INK)}</div><h1>${esc(t.del)}</h1><p>${esc(t.delHint)}</p><form method="post" action="/me/delete"><input type="hidden" name="confirm" value="yes"><button class="submit" type="submit">${esc(t.delConfirm)}</button></form><p class="assurance"><a href="/me">${esc(lang === "en" ? "Back" : "Retour")}</a></p>`));
      }
      // Le coffre d'abord (il vit à part), puis tout le reste par cascade.
      if (deps.vault) for (const e of await deps.vault.list(db, u.id)) await deps.vault.deleteEntry(db, u.id, e.ref, { actor: "user_link", detail: "web-delete" }).catch(() => false);
      if (deps.apps) for (const a of await deps.apps.connected(db, u.id)) await deps.apps.disconnect(db, u.id, a.service).catch(() => false);
      await clearSession(req, reply);
      await db.query(`DELETE FROM users WHERE id = $1`, [u.id]);
      return reply.redirect("/");
    });
  });
}
