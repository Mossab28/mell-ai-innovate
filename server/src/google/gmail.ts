import type { Db } from "../db.ts";
import type { User } from "../users.ts";
import { normalizeEmail } from "../tasks.ts";
import { SCOPES } from "./oauth.ts";
import { GoogleError, type GoogleService } from "./service.ts";
import { shortLocal } from "./time.ts";
import { ImapAuthError, ImapNotFound, imapDraft, imapRead, imapReplyHeaders, imapSearch, imapSendDraft, smtpSend, type AppCreds } from "./imap.ts";

type Q = Pick<Db, "query">;

/**
 * Gmail par son API REST, avec fetch, ou par IMAP/SMTP quand elle a branché sa boîte avec un mot de
 * passe d'application (imap.ts) : mêmes fonctions, mêmes identifiants, le reste de Mell ne voit pas la différence. Tout ce qui vient d'un mail (expéditeur, objet, extrait,
 * corps) est une donnée non fiable : les outils l'enveloppent avant de le rendre au modèle.
 */

interface Header {
  name: string;
  value: string;
}
interface Part {
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { data?: string; size?: number };
  parts?: Part[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: Part;
}

const MAX_BODY_CHARS = 12_000;

const header = (p: Part | undefined, name: string) => p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

function checkId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("identifiant de mail invalide");
  return id;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function decodePart(data: string, contentType: string | undefined): string {
  const bytes = Buffer.from(data, "base64url");
  const charset = /charset="?([^";\s]+)/i.exec(contentType ?? "")?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Corps lisible d'un mail : le texte brut s'il existe, sinon le HTML réduit à du texte. Pièces jointes nommées. */
function extractBody(root: Part | undefined): { text: string; files: string[] } {
  const plain: string[] = [];
  const html: string[] = [];
  const files: string[] = [];
  const walk = (p: Part) => {
    if (p.filename) {
      files.push(p.filename);
      return;
    }
    if (p.parts?.length) return p.parts.forEach(walk);
    if (!p.body?.data) return;
    const type = (p.mimeType ?? "").toLowerCase();
    if (type === "text/plain") plain.push(decodePart(p.body.data, header(p, "Content-Type")));
    else if (type === "text/html") html.push(decodePart(p.body.data, header(p, "Content-Type")));
  };
  if (root) walk(root);
  const text = plain.length ? plain.join("\n\n").trim() : htmlToText(html.join("\n"));
  return { text: text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n[… suite coupée]` : text, files };
}

const dateOf = (m: GmailMessage, user: User) => (m.internalDate ? shortLocal(new Date(Number(m.internalDate)), user.timezone, user.lang) : header(m.payload, "Date"));

export interface MailSummary {
  id: string;
  thread_id: string;
  from?: string;
  subject?: string;
  date?: string;
  snippet: string;
  unread: boolean;
}

/** Les identifiants IMAP si ses mails passent par un mot de passe d'application, sinon undefined (API Gmail). */
async function appCredsFor(g: GoogleService, q: Q, user: User): Promise<AppCreds | undefined> {
  const conn = await g.connectionFor(q, user.id, "gmail");
  return conn?.method === "app_password" ? g.appCreds(q, user.id) : undefined;
}

/** Les erreurs IMAP/SMTP dites comme celles de l'API : code refusé = reconnecter, introuvable, Google muet. */
async function viaImap<T>(g: GoogleService, q: Q, user: User, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GoogleError) throw e;
    if (e instanceof ImapAuthError) {
      await g.markAppRevoked(q, user.id, "code refusé par Google");
      throw new GoogleError("reconnect", "l'accès à Gmail ne marche plus");
    }
    if (e instanceof ImapNotFound) throw new GoogleError("not_found", "introuvable chez Google");
    if (e instanceof Error && /invalide|sans destinataire|au moins un/.test(e.message)) throw e;
    throw new GoogleError("unavailable", "Google ne répond pas pour l'instant");
  }
}

export async function searchMail(g: GoogleService, q: Q, user: User, query: string, max = 8): Promise<MailSummary[]> {
  const n = Math.max(1, Math.min(15, Math.round(max) || 8));
  const app = await appCredsFor(g, q, user);
  if (app) {
    const list = await viaImap(g, q, user, () => imapSearch(app, query, n));
    return list.map((m) => ({ ...m, date: m.date ? shortLocal(m.date, user.timezone, user.lang) : undefined }));
  }
  const base = `${g.endpoints.gmail}/users/me/messages`;
  const list = await g.api<{ messages?: Array<{ id: string }> }>(q, user.id, SCOPES.gmailRead, "GET", `${base}?${new URLSearchParams({ q: query, maxResults: String(n) })}`);
  const metas = await Promise.all(
    (list.messages ?? []).slice(0, n).map((m) =>
      g.api<GmailMessage>(q, user.id, SCOPES.gmailRead, "GET", `${base}/${checkId(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`),
    ),
  );
  return metas.map((m) => ({
    id: m.id,
    thread_id: m.threadId,
    from: header(m.payload, "From"),
    subject: header(m.payload, "Subject"),
    date: dateOf(m, user),
    snippet: decodeEntities(m.snippet ?? ""),
    unread: !!m.labelIds?.includes("UNREAD"),
  }));
}

/**
 * Les fils où quelqu'un lui doit une réponse : ses mails envoyés il y a 2 à 14 jours dont elle est
 * toujours la dernière à avoir écrit. Par l'API seulement (le mot de passe d'application n'est plus proposé).
 */
export async function awaitingReplies(g: GoogleService, q: Q, user: User, max = 6): Promise<Array<{ thread_id: string; to?: string; subject?: string; date?: string }>> {
  if (await appCredsFor(g, q, user)) return [];
  const base = `${g.endpoints.gmail}/users/me`;
  const list = await g.api<{ messages?: Array<{ id: string; threadId: string }> }>(q, user.id, SCOPES.gmailRead, "GET", `${base}/messages?${new URLSearchParams({ q: "in:sent newer_than:14d older_than:2d", maxResults: "15" })}`);
  const out: Array<{ thread_id: string; to?: string; subject?: string; date?: string }> = [];
  for (const id of [...new Set((list.messages ?? []).map((m) => m.threadId))].slice(0, 10)) {
    const thread = await g.api<{ messages?: GmailMessage[] }>(q, user.id, SCOPES.gmailRead, "GET", `${base}/threads/${checkId(id)}?format=metadata&metadataHeaders=To&metadataHeaders=Subject`);
    const last = thread.messages?.at(-1);
    if (!last?.labelIds?.includes("SENT")) continue;
    out.push({ thread_id: id, to: header(last.payload, "To"), subject: header(last.payload, "Subject"), date: dateOf(last, user) });
    if (out.length >= max) break;
  }
  return out;
}

/** Un mail en texte : en-têtes utiles, corps, noms des pièces jointes. */
export async function readMail(g: GoogleService, q: Q, user: User, id: string): Promise<{ id: string; threadId: string; text: string }> {
  const app = await appCredsFor(g, q, user);
  if (app) return viaImap(g, q, user, () => imapRead(app, id, (d) => shortLocal(d, user.timezone, user.lang)));
  const m = await g.api<GmailMessage>(q, user.id, SCOPES.gmailRead, "GET", `${g.endpoints.gmail}/users/me/messages/${checkId(id)}?format=full`);
  const { text, files } = extractBody(m.payload);
  const lines = [
    `De : ${header(m.payload, "From") ?? "?"}`,
    `À : ${header(m.payload, "To") ?? "?"}`,
    header(m.payload, "Cc") ? `Cc : ${header(m.payload, "Cc")}` : undefined,
    `Objet : ${header(m.payload, "Subject") ?? ""}`,
    `Date : ${dateOf(m, user) ?? "?"}`,
    files.length ? `Pièces jointes : ${files.join(", ")}` : undefined,
    "",
    text || "(mail sans texte)",
  ];
  return { id: m.id, threadId: m.threadId, text: lines.filter((l) => l !== undefined).join("\n") };
}

export interface OutgoingMail {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  replyToId?: string;
}

/** Destinataires lus depuis les arguments d'un outil : liste ou chaîne séparée par des virgules, normalisés. */
export function parseAddresses(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === "string" && v.trim() ? v.split(/[,;]/) : [];
  return [...new Set(raw.map((s) => s.trim()).filter(Boolean).map(normalizeEmail))].slice(0, 20);
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** En-tête encodé (RFC 2047) dès qu'il sort de l'ASCII. */
function encodeWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/** Message RFC 2822 en texte brut UTF-8. Gmail pose lui-même l'expéditeur (le compte connecté). */
export function buildMime(m: { to: string[]; cc: string[]; subject: string; body: string; inReplyTo?: string; references?: string }): string {
  const headers = [
    `To: ${m.to.join(", ")}`,
    m.cc.length ? `Cc: ${m.cc.join(", ")}` : undefined,
    `Subject: ${encodeWord(oneLine(m.subject))}`,
    m.inReplyTo ? `In-Reply-To: ${oneLine(m.inReplyTo)}` : undefined,
    m.references ? `References: ${oneLine(m.references)}` : undefined,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);
  const body = Buffer.from(m.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** Brut prêt pour l'API, avec le fil et les en-têtes de réponse si l'on répond à un mail. */
async function rawFor(g: GoogleService, q: Q, user: User, m: OutgoingMail): Promise<{ raw: string; threadId?: string }> {
  if (!m.to.length) throw new Error("il faut au moins un destinataire");
  let subject = m.subject;
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  let references: string | undefined;
  if (m.replyToId) {
    // Lire les en-têtes du mail d'origine demande la lecture : sans elle, on écrit hors du fil.
    const orig = await g.api<GmailMessage>(
      q,
      user.id,
      SCOPES.gmailRead,
      "GET",
      `${g.endpoints.gmail}/users/me/messages/${checkId(m.replyToId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`,
    );
    threadId = orig.threadId;
    inReplyTo = header(orig.payload, "Message-ID");
    references = [header(orig.payload, "References"), inReplyTo].filter(Boolean).join(" ") || undefined;
    if (!subject.trim()) subject = header(orig.payload, "Subject") ?? "";
    if (!/^re\s*:/i.test(subject)) subject = `Re: ${subject}`;
  }
  const mime = buildMime({ to: m.to, cc: m.cc, subject, body: m.body, inReplyTo, references });
  return { raw: Buffer.from(mime, "utf8").toString("base64url"), threadId };
}

/** Le message à écrire par IMAP/SMTP, avec les en-têtes de réponse lus dans le mail d'origine. */
async function mimeViaImap(g: GoogleService, q: Q, user: User, app: AppCreds, m: OutgoingMail): Promise<string> {
  let subject = m.subject;
  let inReplyTo: string | undefined;
  let references: string | undefined;
  if (m.replyToId) {
    const orig = await viaImap(g, q, user, () => imapReplyHeaders(app, m.replyToId!));
    inReplyTo = orig.messageId;
    references = [orig.references, inReplyTo].filter(Boolean).join(" ") || undefined;
    if (!subject.trim()) subject = orig.subject ?? "";
    if (!/^re\s*:/i.test(subject)) subject = `Re: ${subject}`;
  }
  return buildMime({ to: m.to, cc: m.cc, subject, body: m.body, inReplyTo, references });
}

export async function draftMail(g: GoogleService, q: Q, user: User, m: OutgoingMail): Promise<{ draftId: string }> {
  const app = await appCredsFor(g, q, user);
  if (app) {
    if (!m.to.length) throw new Error("il faut au moins un destinataire");
    const mime = await mimeViaImap(g, q, user, app, m);
    const r = await viaImap(g, q, user, () => imapDraft(app, mime));
    await g.journal(q, user.id, "draft", r.draftId);
    return r;
  }
  const { raw, threadId } = await rawFor(g, q, user, m);
  const r = await g.api<{ id: string }>(q, user.id, SCOPES.gmailCompose, "POST", `${g.endpoints.gmail}/users/me/drafts`, { message: { raw, ...(threadId ? { threadId } : {}) } });
  await g.journal(q, user.id, "draft", r.id);
  return { draftId: r.id };
}

/** Envoi. Ne s'appelle qu'après la garde de la tâche (google/tools.ts). */
export async function sendMail(g: GoogleService, q: Q, user: User, m: OutgoingMail, taskId: string): Promise<{ id: string }> {
  const app = await appCredsFor(g, q, user);
  if (app) {
    if (!m.to.length) throw new Error("il faut au moins un destinataire");
    const mime = await mimeViaImap(g, q, user, app, m);
    const r = await viaImap(g, q, user, () => smtpSend(app, mime, [...m.to, ...m.cc]));
    await g.journal(q, user.id, "send", r.id, taskId);
    return r;
  }
  const { raw, threadId } = await rawFor(g, q, user, m);
  const r = await g.api<{ id: string }>(q, user.id, SCOPES.gmailCompose, "POST", `${g.endpoints.gmail}/users/me/messages/send`, { raw, ...(threadId ? { threadId } : {}) });
  await g.journal(q, user.id, "send", r.id, taskId);
  return { id: r.id };
}

/** Envoie un brouillon tel quel (bouton « Envoyer » d'une carte). Ne s'appelle qu'après la garde de la tâche. */
export async function sendDraft(g: GoogleService, q: Q, user: User, draftId: string, taskId: string): Promise<{ id: string }> {
  const app = await appCredsFor(g, q, user);
  if (app) {
    const r = await viaImap(g, q, user, () => imapSendDraft(app, draftId));
    await g.journal(q, user.id, "send", r.id, taskId);
    return r;
  }
  const r = await g.api<{ id: string }>(q, user.id, SCOPES.gmailCompose, "POST", `${g.endpoints.gmail}/users/me/drafts/send`, { id: draftId });
  await g.journal(q, user.id, "send", r.id, taskId);
  return { id: r.id };
}
