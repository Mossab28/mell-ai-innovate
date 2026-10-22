import { randomBytes } from "node:crypto";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";

/**
 * Gmail par mot de passe d'application : IMAP pour lire et préparer, SMTP pour envoyer, chez Google
 * directement (imap.gmail.com, smtp.gmail.com). Aucune validation Google, aucun intermédiaire. La
 * recherche garde la syntaxe de Gmail (X-GM-RAW) et les identifiants sont ceux de l'API Gmail
 * (X-GM-MSGID en hexadécimal) : le modèle ne voit aucune différence avec la connexion Google.
 * La lecture ne marque rien comme lu (BODY.PEEK).
 */

export interface AppCreds {
  email: string;
  password: string;
}

export interface ImapHosts {
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
}

export const GMAIL_HOSTS: ImapHosts = {
  imap: { host: "imap.gmail.com", port: 993, secure: true },
  smtp: { host: "smtp.gmail.com", port: 465, secure: true },
};

/** Les tests remplacent Google par un faux serveur. */
let hosts: ImapHosts = GMAIL_HOSTS;
export function setImapHosts(h: ImapHosts | undefined): void {
  hosts = h ?? GMAIL_HOSTS;
}

export class ImapAuthError extends Error {}

const MAX_BODY_CHARS = 12_000;

const hex = (id: string | undefined) => (id ? BigInt(id).toString(16) : "");
const dec = (id: string) => {
  if (!/^[0-9a-f]{1,20}$/i.test(id)) throw new Error("identifiant de mail invalide");
  return BigInt(`0x${id}`).toString();
};

function client(c: AppCreds): ImapFlow {
  return new ImapFlow({ ...hosts.imap, auth: { user: c.email, pass: c.password }, logger: false, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000 });
}

/** Connexion, travail, déconnexion. Un refus de Google (code retiré, mot de passe changé) devient ImapAuthError. */
async function withImap<T>(c: AppCreds, fn: (imap: ImapFlow) => Promise<T>): Promise<T> {
  const imap = client(c);
  imap.on("error", () => {});
  try {
    await imap.connect();
  } catch (e: any) {
    if (e?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|Application-specific password required/i.test(String(e?.responseText ?? e?.message ?? ""))) {
      throw new ImapAuthError("Google refuse le code");
    }
    throw e;
  }
  try {
    return await fn(imap);
  } finally {
    await imap.logout().catch(() => imap.close());
  }
}

/** Le code est-il bon ? « ok », « refused » (Google dit non), ou « unavailable » (Google ne répond pas). */
export async function checkLogin(c: AppCreds): Promise<"ok" | "refused" | "unavailable"> {
  try {
    await withImap(c, async () => undefined);
    return "ok";
  } catch (e) {
    return e instanceof ImapAuthError ? "refused" : "unavailable";
  }
}

/** Dossier spécial (Tous les messages, Brouillons), quel que soit le nom dans sa langue. */
async function special(imap: ImapFlow, use: "\\All" | "\\Drafts"): Promise<string> {
  const boxes = await imap.list();
  const box = boxes.find((b) => b.specialUse === use);
  if (!box) throw new Error(use === "\\All" ? "dossier « Tous les messages » introuvable" : "dossier « Brouillons » introuvable");
  return box.path;
}

function fmtAddress(a: { name?: string; address?: string } | undefined): string | undefined {
  if (!a?.address) return undefined;
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export interface ImapSummary {
  id: string;
  thread_id: string;
  from?: string;
  subject?: string;
  date?: Date;
  snippet: string;
  unread: boolean;
}

/** Recherche avec la syntaxe de Gmail, dans tous ses mails (hors spam et corbeille, comme Gmail). Les plus récents d'abord. */
export async function imapSearch(c: AppCreds, query: string, max: number): Promise<ImapSummary[]> {
  return withImap(c, async (imap) => {
    const lock = await imap.getMailboxLock(await special(imap, "\\All"), { readOnly: true });
    try {
      const uids = (await imap.search({ gmailraw: query.trim() || "in:inbox" }, { uid: true })) || [];
      const pick = uids.sort((a, b) => a - b).slice(-max);
      if (!pick.length) return [];
      const out: ImapSummary[] = [];
      for await (const m of imap.fetch(pick, { uid: true, envelope: true, flags: true, internalDate: true, threadId: true, source: { maxLength: 8000 } }, { uid: true })) {
        let snippet = "";
        try {
          const p = await simpleParser(m.source ?? Buffer.alloc(0), { skipImageLinks: true });
          snippet = (p.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
        } catch {}
        out.push({
          id: hex(m.emailId),
          thread_id: hex(m.threadId),
          from: fmtAddress(m.envelope?.from?.[0]),
          subject: m.envelope?.subject,
          date: m.internalDate ? new Date(m.internalDate) : m.envelope?.date,
          snippet,
          unread: !m.flags?.has("\\Seen"),
        });
      }
      return out.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
    } finally {
      lock.release();
    }
  });
}

/** Le mail brut retrouvé par son identifiant Gmail, dans un dossier donné. */
async function sourceOf(imap: ImapFlow, box: string, id: string): Promise<{ uid: number; source: Buffer; threadId: string } | undefined> {
  const lock = await imap.getMailboxLock(box, { readOnly: true });
  try {
    const uids = (await imap.search({ emailId: dec(id) }, { uid: true })) || [];
    if (!uids.length) return undefined;
    const m = await imap.fetchOne(String(uids[0]), { uid: true, source: true, threadId: true }, { uid: true });
    if (!m || !m.source) return undefined;
    return { uid: m.uid, source: m.source, threadId: hex(m.threadId) };
  } finally {
    lock.release();
  }
}

export class ImapNotFound extends Error {}

/** Un mail en texte : en-têtes utiles, corps, noms des pièces jointes. Rien n'est marqué comme lu. */
export async function imapRead(c: AppCreds, id: string, when: (d: Date) => string): Promise<{ id: string; threadId: string; text: string }> {
  return withImap(c, async (imap) => {
    const m = await sourceOf(imap, await special(imap, "\\All"), id);
    if (!m) throw new ImapNotFound("mail introuvable");
    const p = await simpleParser(m.source, { skipImageLinks: true });
    const addr = (a: any) => (Array.isArray(a) ? a : a ? [a] : []).map((x: any) => x.text).join(", ");
    let text = (p.text ?? "").trim();
    if (text.length > MAX_BODY_CHARS) text = `${text.slice(0, MAX_BODY_CHARS)}\n[… suite coupée]`;
    const files = (p.attachments ?? []).map((a) => a.filename).filter(Boolean);
    const lines = [
      `De : ${addr(p.from) || "?"}`,
      `À : ${addr(p.to) || "?"}`,
      p.cc ? `Cc : ${addr(p.cc)}` : undefined,
      `Objet : ${p.subject ?? ""}`,
      `Date : ${p.date ? when(p.date) : "?"}`,
      files.length ? `Pièces jointes : ${files.join(", ")}` : undefined,
      "",
      text || "(mail sans texte)",
    ];
    return { id, threadId: m.threadId, text: lines.filter((l) => l !== undefined).join("\n") };
  });
}

/** En-têtes du mail auquel on répond : fil, sujet. */
export async function imapReplyHeaders(c: AppCreds, id: string): Promise<{ messageId?: string; references?: string; subject?: string }> {
  return withImap(c, async (imap) => {
    const m = await sourceOf(imap, await special(imap, "\\All"), id);
    if (!m) throw new ImapNotFound("mail introuvable");
    const p = await simpleParser(m.source, { skipImageLinks: true, skipTextToHtml: true, skipHtmlToText: true });
    const refs = p.references ? (Array.isArray(p.references) ? p.references.join(" ") : p.references) : undefined;
    return { messageId: p.messageId, references: refs, subject: p.subject };
  });
}

/** Ajoute les en-têtes qu'un envoi par SMTP doit porter lui-même (Gmail les pose seul par son API). */
export function withSenderHeaders(mime: string, from: string): string {
  const domain = from.split("@")[1] ?? "gmail.com";
  const extra = [`From: ${from}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`];
  return `${extra.join("\r\n")}\r\n${mime}`;
}

/** Brouillon dans son dossier Brouillons. Rend son identifiant Gmail. */
export async function imapDraft(c: AppCreds, mime: string): Promise<{ draftId: string }> {
  return withImap(c, async (imap) => {
    const box = await special(imap, "\\Drafts");
    const r = await imap.append(box, Buffer.from(withSenderHeaders(mime, c.email)), ["\\Draft", "\\Seen"]);
    if (!r || !r.uid) throw new Error("brouillon non enregistré");
    const lock = await imap.getMailboxLock(box, { readOnly: true });
    try {
      const m = await imap.fetchOne(String(r.uid), { uid: true }, { uid: true });
      return { draftId: hex(m ? m.emailId : undefined) };
    } finally {
      lock.release();
    }
  });
}

function transport(c: AppCreds) {
  return nodemailer.createTransport({ ...hosts.smtp, auth: { user: c.email, pass: c.password }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000 });
}

/** Envoi depuis son adresse. Gmail range lui-même le mail dans Envoyés. */
export async function smtpSend(c: AppCreds, mime: string, rcpts: string[]): Promise<{ id: string }> {
  const raw = withSenderHeaders(mime, c.email);
  try {
    const r = await transport(c).sendMail({ envelope: { from: c.email, to: rcpts }, raw });
    return { id: r.messageId ?? "" };
  } catch (e: any) {
    if (e?.code === "EAUTH" || e?.responseCode === 535) throw new ImapAuthError("Google refuse le code");
    throw e;
  }
}

/** Envoie un brouillon tel quel (bouton « Envoyer » d'une carte), puis le retire des Brouillons. */
export async function imapSendDraft(c: AppCreds, draftId: string): Promise<{ id: string }> {
  const draft = await withImap(c, async (imap) => {
    const box = await special(imap, "\\Drafts");
    const m = await sourceOf(imap, box, draftId);
    return m ? { box, ...m } : undefined;
  });
  if (!draft) throw new ImapNotFound("brouillon introuvable");
  const p = await simpleParser(draft.source, { skipImageLinks: true, skipTextToHtml: true, skipHtmlToText: true });
  const list = (a: any) => (Array.isArray(a) ? a : a ? [a] : []).flatMap((x: any) => x.value.map((v: any) => v.address)).filter(Boolean);
  const rcpts = [...list(p.to), ...list(p.cc), ...list(p.bcc)];
  if (!rcpts.length) throw new Error("brouillon sans destinataire");
  // Le brouillon porte déjà From, Date et Message-ID : on l'envoie tel quel.
  const r = await transport(c).sendMail({ envelope: { from: c.email, to: rcpts }, raw: draft.source });
  await withImap(c, async (imap) => {
    const lock = await imap.getMailboxLock(draft.box);
    try {
      await imap.messageDelete(String(draft.uid), { uid: true });
    } finally {
      lock.release();
    }
  }).catch(() => {});
  return { id: r.messageId ?? "" };
}
