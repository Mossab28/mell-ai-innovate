import { watch } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LINE_HEADER, SIGNATURE_HEADER, sign, type OutboundMessage, type OutboxResponse } from "@mella/shared";
import { ChatDb } from "./chatdb.ts";
import { BlueBubbles } from "./bluebubbles.ts";
import { sendMessage } from "./send.ts";
import { prepareAttachments } from "./attachments.ts";
import { EmojiTapbacks } from "./tapback.ts";
import { FaceTimeCalls } from "./call.ts";

/**
 * Relais d'une ligne iMessage. Tourne dans la session macOS de Mell :
 *  - lit les nouveaux messages de chat.db dès que Messages écrit (surveillance du fichier,
 *    sondage en filet de sécurité) et les pousse au serveur (curseur persistant, avancé
 *    seulement après accusé du serveur : rien ne se perd pendant une coupure) ;
 *  - va chercher les envois en long-polling, les envoie dans l'ordre, et acquitte.
 * Avec BlueBubbles Server (API privée), il marque lu et affiche « en train d'écrire » dès
 * réception, pose de vraies réactions et des effets. Sans lui, repli AppleScript.
 * Aucune connexion entrante : un Mac derrière une box suffit.
 */

const env = process.env;
const SERVER = (env.MELLA_SERVER_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const LINE = need("MELLA_LINE_ID");
const SECRET = need("MELLA_LINE_SECRET");
const CHAT_DB = env.MELLA_CHAT_DB ?? join(homedir(), "Library/Messages/chat.db");
const STATE_DIR = env.MELLA_RELAY_STATE ?? join(homedir(), ".mella-relay");
// Photos des cartes de lien : Messages ne lit que son propre arbre de pièces jointes.
const CARDS_DIR = join(homedir(), "Library/Messages/Attachments/mell");

/** Supprime les dossiers de cartes de plus d'une heure (le transfert vers Apple est fini depuis longtemps). */
async function sweepOldCards(): Promise<void> {
  try {
    for (const name of await readdir(CARDS_DIR)) {
      const dir = join(CARDS_DIR, name);
      if (Date.now() - (await stat(dir)).mtimeMs > 3600_000) await rm(dir, { recursive: true, force: true });
    }
  } catch {}
}
const DRY_RUN = env.MELLA_DRY_RUN === "1";
const BUBBLE_GAP_MS = Number(env.MELLA_BUBBLE_GAP_MS ?? 600);
const POLL_MS = Number(env.MELLA_POLL_MS ?? 2000);
/** L'indicateur de frappe s'éteint seul s'il n'est suivi d'aucun envoi (tâche longue, réaction seule). */
const TYPING_MAX_MS = Number(env.MELLA_TYPING_MAX_MS ?? 45_000);
const bb = env.MELLA_BB_URL && env.MELLA_BB_PASSWORD ? new BlueBubbles(env.MELLA_BB_URL.replace(/\/+$/, ""), env.MELLA_BB_PASSWORD) : undefined;
let bbReady = false;
/** Réactions emoji par l'extension chargée dans Messages (infra/aws-mac/tapback), si elle est installée. */
const emoji = DRY_RUN ? undefined : new EmojiTapbacks(Number(env.MELLA_TAPBACK_PORT ?? 12346), (...a) => log(...a));
/** Appels FaceTime audio par l'extension chargée dans FaceTime (infra/aws-mac/call), si elle est installée. */
const calls = DRY_RUN ? undefined : new FaceTimeCalls(Number(env.MELLA_CALL_PORT ?? 12347), (...a) => log(...a));

function need(name: string): string {
  const v = env[name];
  if (!v) {
    console.error(`Variable manquante : ${name}`);
    process.exit(1);
  }
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const res = await fetch(SERVER + path, {
    method,
    headers: {
      "content-type": "application/json",
      [LINE_HEADER]: LINE,
      [SIGNATURE_HEADER]: sign(SECRET, method === "GET" ? path : raw),
    },
    body: method === "POST" ? raw : undefined,
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) throw new Error(`${method} ${path} : ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

// --- Conversations : identifiant Messages de chaque correspondant, et indicateur de frappe.

const chatOf = new Map<string, string>();
function chatGuidFor(handle: string): string {
  return chatOf.get(handle) ?? `iMessage;-;${handle}`;
}

const typingTimers = new Map<string, NodeJS.Timeout>();
/** Dernier envoi par conversation : un « en train d'écrire » en retard ne doit pas le suivre. */
const lastSentAt = new Map<string, number>();
async function setTyping(chat: string, on: boolean): Promise<void> {
  if (!bbReady || DRY_RUN) return;
  clearTimeout(typingTimers.get(chat));
  typingTimers.delete(chat);
  if (on) typingTimers.set(chat, setTimeout(() => setTyping(chat, false), TYPING_MAX_MS));
  await bb!.typing(chat, on).catch((e) => log("[frappe]", (e as Error).message));
}

// --- Réception

const stateFile = join(STATE_DIR, `${LINE}.json`);
async function loadCursor(db: ChatDb): Promise<number> {
  try {
    return JSON.parse(await readFile(stateFile, "utf8")).lastRowId;
  } catch {
    // Premier démarrage : on ne rejoue pas l'historique de la session.
    return db.maxRowId();
  }
}
async function saveCursor(lastRowId: number): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(stateFile, JSON.stringify({ lastRowId }));
}

/** Réveillé dès que Messages écrit dans sa base (chat.db ou son journal -wal). */
let wakeInbound: (() => void) | undefined;
function watchChatDb(): void {
  try {
    watch(dirname(CHAT_DB), (_e, file) => {
      if (file && String(file).startsWith("chat.db")) wakeInbound?.();
    });
  } catch (e) {
    log("[réception] surveillance impossible, sondage seul :", (e as Error).message);
  }
}

async function inboundLoop(db: ChatDb): Promise<never> {
  let cursor = await loadCursor(db);
  let backoff = 1000;
  for (;;) {
    try {
      const seenAt = Date.now();
      const { lastRowId, messages } = db.readAfter(cursor);
      if (messages.length) {
        // Premier signe de vie, avant même le serveur : lu, et « en train d'écrire ».
        const chats = new Set<string>();
        for (const m of messages) {
          if (m.chatGuid) chatOf.set(m.from, m.chatGuid);
          if (!m.tapback) chats.add(chatGuidFor(m.from));
        }
        if (bbReady && !DRY_RUN) {
          for (const c of chats) {
            void bb!
              .markRead(c)
              .catch(() => {})
              .then(() => ((lastSentAt.get(c) ?? 0) < seenAt ? setTyping(c, true) : undefined));
          }
        }
        // Photos et vocaux : convertis ici, avec les outils du Mac, puis envoyés avec le message.
        for (const m of messages) {
          if (m.files?.length) m.attachments = await prepareAttachments(m.files);
        }
        await call("POST", "/relay/inbound", { lineId: LINE, messages: messages.map(({ chatGuid, files, ...m }) => m) });
        for (const m of messages) log(`[reçu] ${m.from} : vu ${seenAt - Date.parse(m.sentAt)} ms après l'envoi, transmis en ${Date.now() - seenAt} ms`);
      }
      if (lastRowId !== cursor) {
        cursor = lastRowId;
        await saveCursor(cursor);
      }
      backoff = 1000;
      if (!messages.length) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, POLL_MS);
          wakeInbound = () => (clearTimeout(t), (wakeInbound = undefined), r());
        });
        // Messages écrit en plusieurs fois : on lui laisse finir sa transaction.
        await sleep(30);
      }
    } catch (e) {
      log("[réception]", (e as Error).message);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

// --- Envoi

async function sendOne(m: OutboundMessage): Promise<string | undefined> {
  const chat = chatGuidFor(m.to);
  if (m.kind === "delete") {
    // Un secret tapé dans le fil : on l'efface de Messages. Jamais de modification de chat.db.
    if (DRY_RUN) return;
    if (!bbReady || !m.targetGuid) throw new Error("suppression impossible : API privée BlueBubbles indisponible");
    await bb!.deleteMessage(chat, m.targetGuid);
    return;
  }
  if (m.kind === "typing") {
    await setTyping(chat, m.text !== "off");
    return;
  }
  if (m.kind === "call") {
    // L'appel dure jusqu'à 40 s : il part en fond pour ne pas retenir les autres envois.
    if (DRY_RUN) return;
    if (!calls?.ready()) throw new Error("appels non installés sur ce Mac");
    if (!m.text) throw new Error("appel sans texte");
    // Pas décroché : on rappelle une fois, une minute après. En « Ne pas déranger », l'iPhone coupe le premier appel
    // mais laisse sonner un second appel du même numéro dans les 3 minutes (appels répétés).
    const text = m.text;
    void calls
      .call(m.to, text)
      .then(async (o) => {
        log(`[appel] ${m.to} : ${o.answered ? `décroché après ${o.pickupSeconds} s` : "pas décroché"}`);
        if (o.answered) return;
        await sleep(60_000);
        const again = await calls!.call(m.to, text);
        log(`[appel] ${m.to}, second appel : ${again.answered ? `décroché après ${again.pickupSeconds} s` : "pas décroché"}`);
      })
      .catch((e) => log("[appel] échec :", (e as Error).message));
    return;
  }
  if (m.kind === "edit") {
    if (!bbReady || DRY_RUN || !m.targetGuid || !m.text) return;
    await bb!.edit(m.targetGuid, m.text);
    return;
  }
  if (m.kind === "image") {
    // Photo d'une carte, servie par Mell : téléchargée ici puis envoyée en pièce jointe.
    if (DRY_RUN) return;
    if (!bbReady || !m.text || !/^https:\/\//.test(m.text)) throw new Error("photo impossible : API privée BlueBubbles indisponible ou adresse invalide");
    const res = await fetch(m.text, { signal: AbortSignal.timeout(15_000) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/")) throw new Error(`photo introuvable (HTTP ${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 6 * 1024 * 1024) throw new Error("photo trop lourde");
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
    return await bb!.sendAttachment(chat, `photo.${ext}`, bytes, type);
  }
  if (m.kind === "card") {
    // Carte de lien CLIQUABLE : on fabrique un vrai lien natif (titre + image fournis par nous), envoyé par
    // l'extension de Messages. L'image est servie par Mell ; on la télécharge dans un fichier temporaire.
    if (DRY_RUN) return;
    if (!bbReady || !m.image || !/^https:\/\//.test(m.image)) throw new Error("carte impossible : API privée BlueBubbles indisponible ou image invalide");
    const res = await fetch(m.image, { signal: AbortSignal.timeout(15_000) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/")) throw new Error(`carte : image introuvable (HTTP ${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 6 * 1024 * 1024) throw new Error("carte : image trop lourde");
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
    const caption = (m.text ?? "").trim();
    const url = caption.match(/https?:\/\/\S+/)?.[0];
    const title = caption.split("\n").map((l) => l.trim()).find((l) => l && !/^https?:\/\//.test(l)) ?? "Mell";
    // 1) vrai lien cliquable via l'extension (titre + photo à nous), si on a une URL.
    if (url && emoji?.ready()) {
      try {
        // Messages ne lit les pièces jointes que dans son propre arbre ; un dossier par carte, ménage des anciens.
        const dir = join(CARDS_DIR, randomUUID());
        await mkdir(dir, { recursive: true });
        const path = join(dir, `apercu.${ext}`);
        await writeFile(path, bytes);
        void sweepOldCards();
        return await emoji.linkCard(chat, url, title, { path, mime: type.split(";")[0]!.trim() });
      } catch (e) {
        log("[carte] lien cliquable impossible, repli :", (e as Error).message);
      }
    }
    // 2) repli : l'image puis le lien juste en dessous (toujours livré).
    const guid = await bb!.sendAttachment(chat, `apercu.${ext}`, bytes, type);
    if (caption) await bb!.sendText(chat, caption);
    return guid;
  }
  if (m.kind === "contact") {
    // Fiche contact (.vcf) : la personne ajoute Mell en un toucher, et les aperçus des cartes s'affichent ensuite.
    if (DRY_RUN) return;
    if (!bbReady || !m.text) throw new Error("fiche contact impossible : API privée BlueBubbles indisponible");
    return await bb!.sendAttachment(chat, "Mell.vcf", Buffer.from(m.text, "utf8"), "text/vcard");
  }
  lastSentAt.set(chat, Date.now());
  if (bbReady && !DRY_RUN) {
    try {
      if (m.kind === "tapback" && m.targetGuid && bb!.canReact(m.tapback ?? "")) {
        await bb!.react(chat, m.targetGuid, m.tapback!);
        return;
      }
      if (m.kind === "tapback" && m.targetGuid && m.tapback) {
        // Emoji (👀, 🫡) : par l'extension de Messages ; si elle n'est pas reliée, un 👍 plutôt qu'une bulle « 👀 ».
        if (emoji?.ready()) return await emoji.react(chat, m.targetGuid, m.tapback);
        await bb!.react(chat, m.targetGuid, "like");
        return;
      }
      // Un lien seul dans sa bulle (coffre, page) part en carte cliquable au nom du site, sinon « Toucher pour charger ».
      if (m.kind === "text" && m.text && /^https?:\/\/\S+$/.test(m.text.trim()) && !m.replyTo && emoji?.ready()) {
        try {
          const url = m.text.trim();
          return await emoji.linkCard(chat, url, new URL(url).hostname);
        } catch (e) {
          log("[envoi] carte de lien impossible, envoi simple :", (e as Error).message);
        }
      }
      if (m.kind === "text" && m.text) {
        return await bb!.sendText(chat, m.text, m.effect, m.replyTo);
      }
    } catch (e) {
      log("[envoi] BlueBubbles a échoué, repli AppleScript :", (e as Error).message);
    }
  }
  await sendMessage(m, DRY_RUN);
}

async function outboundLoop(): Promise<never> {
  let backoff = 1000;
  for (;;) {
    try {
      const { messages } = await call<OutboxResponse>("GET", `/relay/outbox?wait=25000`);
      const results: Array<{ id: number; ok: boolean; error?: string }> = [];
      for (const [i, m] of messages.entries()) {
        const t = Date.now();
        try {
          const guid = await sendOne(m);
          results.push({ id: m.id, ok: true, ...(guid ? { guid } : {}) });
          log(`[${m.kind === "delete" ? "effacé" : "envoyé"}] ${m.kind} #${m.id} -> ${m.to} en ${Date.now() - t} ms`);
        } catch (e) {
          // Le message d'erreur ne contient jamais le texte (voir send.ts) : on peut le journaliser.
          const error = (e as Error).message.slice(0, 300);
          results.push({ id: m.id, ok: false, error });
          log(`[échec] ${m.kind} #${m.id} -> ${m.to} : ${error}`);
        }
        // Entre deux bulles vers la même personne : « en train d'écrire », comme quelqu'un qui tape.
        const next = messages[i + 1];
        if (m.kind === "delete" || m.kind === "typing" || m.kind === "edit" || m.kind === "call" || m.kind === "contact") continue;
        if (next && next.to === m.to && next.kind === "text") {
          await setTyping(chatGuidFor(m.to), true);
          await sleep(BUBBLE_GAP_MS);
        } else {
          await setTyping(chatGuidFor(m.to), false);
        }
      }
      if (results.length) await call("POST", "/relay/ack", { lineId: LINE, results });
      backoff = 1000;
    } catch (e) {
      log("[envoi]", (e as Error).message);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

/** BlueBubbles peut redémarrer ou perdre son API privée : on revérifie régulièrement. */
async function watchBlueBubbles(): Promise<void> {
  if (!bb) return;
  for (;;) {
    const ready = await bb.privateApiReady();
    if (ready !== bbReady) log(`[BlueBubbles] API privée ${ready ? "branchée" : "indisponible, repli AppleScript"}`);
    bbReady = ready;
    await sleep(30_000);
  }
}

const db = new ChatDb(CHAT_DB);
watchChatDb();
log(`Relais Mell : ligne ${LINE} -> ${SERVER}${DRY_RUN ? " (envois simulés)" : ""}${bb ? ", avec BlueBubbles" : ""}`);
await Promise.all([inboundLoop(db), outboundLoop(), watchBlueBubbles()]);
