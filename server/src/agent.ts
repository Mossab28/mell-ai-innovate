import type { Db } from "./db.ts";
import type { Config } from "./config.ts";
import type { ChatMessage, Llm } from "./llm.ts";
import { refreshVoiceNote } from "./voice.ts";
import { refreshThreadSummary } from "./compaction.ts";
import { refreshRhythm } from "./rhythm.ts";
import { getUser, type User } from "./users.ts";
import { enqueue, type Enqueue } from "./outbox.ts";
import { render } from "./style.ts";
import { systemPrompt, turnReminder } from "./prompt.ts";
import { toolsFor, runTool, SEND_MESSAGE } from "./tools.ts";
import { authorizePending, isApprovalTapback, isApprovalText, describeScope } from "./tasks.ts";
import { TAPBACK_EMOJI, type Tapback } from "@mella/shared";
import { takeCodeReply } from "./browser/codes.ts";
import { detectLang } from "./lang.ts";
import { readAttachments } from "./media.ts";
import { isPositiveTapback, readReactions } from "./reactions.ts";
import { cardReactions } from "./cards.ts";
import { endWork, keepTyping, progress, progressBecome, progressDone, startWork } from "./progress.ts";
// Les 60 derniers messages : à 30, un « je l'ai payé depuis l'app » sortait de sa vue en une heure de fil dense et il se
// dédisait (face-à-face du 19/10).
import { HISTORY } from "./history.ts";

/**
 * Un tour de conversation : tout ce que la personne a envoyé depuis la dernière réponse,
 * traité d'un bloc (les gens écrivent en plusieurs bulles). Un seul tour à la fois par
 * personne, sous un verrou qui expire toujours.
 */

const TURN_LOCK_SECONDS = 180;
const MAX_STEPS = { tool: 6, task: 15 } as const;

interface Pending {
  id: number;
  guid: string | null;
  text: string | null;
  tapback: string | null;
  target_guid: string | null;
}

/** Historique au format modèle. Les réactions deviennent une note lisible. */
export async function buildHistory(db: Pick<Db, "query">, userId: string, limit = HISTORY): Promise<ChatMessage[]> {
  const { rows } = await db.query<{ direction: string; text: string | null; tapback: string | null }>(
    `SELECT direction, text, tapback FROM (SELECT * FROM messages WHERE user_id = $1 ORDER BY id DESC LIMIT $2) m ORDER BY id`,
    [userId, limit],
  );
  const out: ChatMessage[] = [];
  for (const r of rows) {
    const content = r.text ?? (r.tapback ? `[réaction ${TAPBACK_EMOJI[r.tapback as Tapback] ?? r.tapback} sur ton dernier message]` : "");
    if (!content) continue;
    const role = r.direction === "in" ? "user" : "assistant";
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${content}`;
    else out.push(role === "user" ? { role, content } : { role, content });
  }
  return out;
}

/** Dernier message de la personne dans l'historique, pour le juge. */
function lastUserText(history: ChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].role === "user") return String(history[i].content).slice(-2000);
  return "";
}

/** L'étape en cours, en quelques mots et dans sa langue, d'après ce que l'assistant lance (modèle rapide, ~0,5 s). */
async function stepLine(llm: Llm, model: string, lang: string, request: string, calls: string): Promise<string | undefined> {
  const r = await llm.chat({
    model,
    purpose: "status",
    maxTokens: 40,
    messages: [
      {
        role: "system",
        content:
          "Tu écris l'étape en cours d'un assistant personnel, affichée en direct à la personne pendant qu'il travaille pour elle. Une seule ligne de trois à sept mots, au présent, à la première personne et en la tutoyant, dans la langue demandée, qui dit concrètement ce qu'il fait (« Je compare trois restos rue de Bretagne »). Pas de nom d'outil, pas de jargon, pas de guillemets, pas de point final.",
      },
      { role: "user", content: `Langue : ${lang === "en" ? "anglais" : "français"}.\nSa demande : ${request.slice(0, 400)}\nCe que l'assistant lance maintenant : ${calls.slice(0, 600)}` },
    ],
    signal: AbortSignal.timeout(4000),
  });
  const line = (r.text ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  return line ? line.replace(/^["«»“”]+|["«»“”.]+$/g, "").slice(0, 100) : undefined;
}

/** Boucle modèle + outils, bornée en nombre d'étapes. Rend le texte final. */
export async function runAgentLoop(
  db: Pick<Db, "query">,
  llm: Llm,
  user: User,
  p: {
    mode: "tool" | "task";
    model: string;
    system: string;
    history: ChatMessage[];
    deadline: number;
    cfg?: Pick<Config, "decisions">;
    /** Petit modèle rapide qui formule l'étape en cours quand le modèle principal n'en dit rien. */
    statusModel?: string;
    /** Rien n'est affiché avant ce moment (chemin synchrone : une action instantanée n'a pas besoin de bulle). */
    narrateAfter?: number;
    /** Ce qu'elle a écrit (ou ce que le système signale) depuis le dernier appel : lu entre deux étapes. */
    incoming?: () => Promise<string[]>;
    /** Le silence est une réponse valable (un retour que Mell s'était fixé, devenu sans objet). */
    allowSilence?: boolean;
    /** Son message à l'origine du tour ou du travail : ce qui en découle lui répond dans son fil. */
    sourceGuid?: string | null;
  },
): Promise<string | null> {
  const messages: ChatMessage[] = [{ role: "system", content: p.system }, ...p.history];
  // Passage silencieux par défaut : il écrit par send_message, son texte final reste une note (jamais envoyée).
  const tools = p.allowSilence ? [...toolsFor(p.mode), SEND_MESSAGE] : toolsFor(p.mode);
  let nudged = false;
  let usedTools = false;
  let nudgedClaim = false;
  let narrated = 0;
  let lastStep = "";
  let lastStepAt = 0;
  let narration: Promise<void> = Promise.resolve();
  for (let step = 0; step < MAX_STEPS[p.mode]; step++) {
    const left = p.deadline - Date.now();
    if (left <= 0) throw new Error("délai dépassé");
    const reply = await llm.chat({ model: p.model, purpose: p.mode, messages, tools, maxTokens: 1024, signal: AbortSignal.timeout(Math.min(left, 90_000)) });
    if (!reply.toolCalls.length) {
      // Elle a écrit pendant que la réponse se rédigeait : cette réponse ne part pas, elle est refaite avec son message.
      const fresh = p.incoming ? await p.incoming() : [];
      if (fresh.length) {
        messages.push({ role: "assistant", content: reply.text || "…" });
        messages.push({ role: "user", content: `${arrivals(fresh)}\n\n[système] Ta réponse ci-dessus n'est pas partie : réécris-la en tenant compte de ce qu'elle vient d'écrire.` });
        continue;
      }
      // Après un 👀, la personne attend un résultat : un silence ou une simple réaction ne suffit pas (banc de voix).
      const silent = !render(reply.text).bubbles.length;
      if (silent && p.mode === "task" && !nudged && !p.allowSilence) {
        nudged = true;
        messages.push({ role: "assistant", content: reply.text || "…" });
        messages.push({ role: "user", content: "[système] Tu n'as rien écrit à l'utilisateur. Rends-lui maintenant le résultat en une bulle : ce que tu as trouvé ou fait d'abord, puis une question fermée si une décision l'attend." });
        continue;
      }
      await narration;
      return p.allowSilence ? null : reply.text;
    }
    usedTools = true;
    // L'étape en cours s'affiche en direct dans la bulle d'avancement, qui s'édite étape par étape : les mots du modèle
    // s'il en a écrit avant ses outils, sinon une ligne formulée par un petit modèle à partir de ce qui part vraiment.
    // Jamais de libellé écrit d'avance ; rien pour une action instantanée du chemin synchrone.
    if (narrated < 4 && Date.now() >= (p.narrateAfter ?? 0) && Date.now() - lastStepAt > 2500) {
      narrated++;
      lastStepAt = Date.now();
      const said = (reply.text ?? "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 120);
      const calls = reply.toolCalls.map((c) => `${c.function.name}(${c.function.arguments.slice(0, 200)})`).join(" ; ");
      narration = (async () => {
        // Toujours rédigée d'après ce qui part vraiment : le texte libre du modèle avant ses outils est parfois son
        // raisonnement ou une réponse (« Petite précision sur le jour... », « Je dois d'abord corriger... »), et il
        // s'affichait tel quel dans la bulle (19/10).
        const step = p.statusModel ? await stepLine(llm, p.statusModel, user.lang, lastUserText(p.history), calls) : said;
        if (step && step !== lastStep) {
          lastStep = step;
          await progress(db, user.id, step);
        }
      })().catch(() => {});
    }
    messages.push({ role: "assistant", content: reply.text, tool_calls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      const t0 = Date.now();
      const result = await runTool(db, user, call.function.name, call.function.arguments, { sourceGuid: p.sourceGuid });
      // Journal des outils (règle 9) : arguments et résultat bornés, sans valeur du coffre (le modèle n'en voit jamais).
      await db
        .query(`INSERT INTO tool_calls (user_id, mode, name, args, result, ms) VALUES ($1, $2, $3, $4, $5, $6)`, [
          user.id,
          p.mode,
          call.function.name,
          call.function.arguments.slice(0, 2000),
          result.slice(0, 8000),
          Date.now() - t0,
        ])
        .catch(() => {});
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    // Un outil peut tenir plusieurs minutes (navigateur) : ce qu'elle a écrit entre-temps arrive avec ses résultats.
    const fresh = p.incoming ? await p.incoming() : [];
    if (fresh.length) messages.push({ role: "user", content: arrivals(fresh) });
  }
  await narration;
  // Trop d'étapes : on demande au modèle de conclure sans outil.
  const final = await llm.chat({
    model: p.model,
    purpose: p.mode,
    messages: [...messages, { role: "user", content: "[système] Conclus maintenant pour l'utilisateur, sans outil." }],
    maxTokens: 400,
  });
  return p.allowSilence ? null : final.text;
}

/**
 * `reactTo` : message de la personne sur lequel poser la réaction choisie par le modèle.
 * `thread` : répondre dans le fil de ce message (résultat d'un travail de fond arrivé après d'autres échanges).
 */
async function send(db: Pick<Db, "query">, userId: string, text: string | null, reactTo?: string | null, thread?: string | null, skip = 0): Promise<void> {
  const { bubbles: all, react, effect } = render(text);
  const bubbles = all.slice(skip);
  const items: Enqueue[] = bubbles.map((t, i) => ({
    userId,
    kind: "text",
    text: t,
    ...(i === 0 && effect && !skip ? { effect } : {}),
    ...(thread ? { replyTo: thread } : {}),
  }));
  if (react && reactTo) items.unshift({ userId, kind: "tapback", tapback: react, targetGuid: reactTo });
  // Rien à envoyer : le relais avait allumé « en train d'écrire » à la réception, on l'éteint.
  await enqueue(db, items.length ? items : [{ userId, kind: "typing", text: "off" }]);
}

/** Le résultat : sa première bulle prend la place de la bulle d'avancement quand il y en a une, le reste suit. */
async function finish(db: Pick<Db, "query">, userId: string, lang: string, text: string | null, reactTo?: string | null, thread?: string | null): Promise<void> {
  const { bubbles, effect } = render(text);
  const became = bubbles.length > 0 && !effect && (await progressBecome(db, userId, bubbles[0]));
  if (!became) await progressDone(db, userId, lang);
  await send(db, userId, text, reactTo, thread, became ? 1 : 0);
}

async function recentSummary(db: Pick<Db, "query">, userId: string): Promise<string> {
  const h = await buildHistory(db, userId, 6);
  return h
    .slice(0, -1)
    .map((m) => `${m.role === "user" ? "Utilisateur" : "Mell"} : ${String(m.content).slice(0, 200)}`)
    .join("\n");
}

/**
 * Un seul travail de fond à la fois par personne. S'il y en a déjà un, la demande lui est remise et il la lit à sa
 * prochaine étape (une précision, un « attends », la même demande redite, un dépôt au coffre), au lieu qu'un second
 * travail réponde à côté du premier : le 18/10, trois travaux sur la même réservation se sont contredits dans le fil.
 * Rend true quand la demande a rejoint un travail déjà là.
 */
export async function createJob(
  db: Pick<Db, "query">,
  cfg: Config,
  userId: string,
  request: string,
  sourceGuid?: string | null,
  opts: { quietOk?: boolean; separate?: boolean } = {},
): Promise<boolean> {
  // `separate` : une autre demande que le travail en cours. Elle a son propre travail, qui part après lui
  // (le navigateur de la personne est un seul onglet : deux travaux dessus se le disputeraient).
  if (!opts.separate && (await appendToOpenJob(db, userId, request))) return true;
  await db.query(`INSERT INTO jobs (user_id, request, model, deadline_at, source_guid, quiet_ok) VALUES ($1, $2, $3, now() + interval '20 minutes', $4, $5)`, [
    userId,
    request.slice(0, 4000),
    cfg.models.task,
    sourceGuid ?? null,
    !!opts.quietOk,
  ]);
  return false;
}

/** Revues en cours (les bancs les attendent avant de rejouer un parcours). */
export const pendingReviews = new Set<Promise<unknown>>();

/** Remet un texte au travail de fond ouvert pour elle ; il le lit à sa prochaine étape. Rend false s'il n'y en a pas. */
export async function appendToOpenJob(db: Pick<Db, "query">, userId: string, text: string): Promise<boolean> {
  const joined = await db.query(
    `UPDATE jobs SET followups = followups || jsonb_build_array($2::text), deadline_at = greatest(deadline_at, now() + interval '10 minutes')
     WHERE id = (SELECT id FROM jobs WHERE user_id = $1 AND status IN ('queued', 'running') AND attempts < 2 AND deadline_at > now()
                 ORDER BY created_at LIMIT 1 FOR UPDATE)
       AND status IN ('queued', 'running')
     RETURNING id`,
    [userId, text.slice(0, 4000)],
  );
  return joined.rows.length > 0;
}

/**
 * Ce que ses outils ont rendu pendant la conversation encore visible, souvenirs retrouvés compris : c'est la source de
 * ce qu'il y a dit (sans elle, il prenait sa propre bonne réponse pour une invention et la démentait, 19/10). Le fil ne garde que les bulles : sans leur source, un nouveau tour
 * voyait ses propres horaires et prix comme inventés et se démentait (banc du 19/10 : « je n'ai en fait lancé aucune
 * recherche, ces prix ne valent rien », puis la même recherche, les mêmes prix).
 */
export async function recentResults(db: Pick<Db, "query">, userId: string, at = new Date()): Promise<string | undefined> {
  const rows = (
    await db.query<{ name: string; args: string; result: string; created_at: Date }>(
      // Seulement ce qui a nourri la conversation encore visible (les derniers messages, HISTORY) : un sujet sorti du fil
      // n'y revient plus par ses vieux résultats (le 19/10, il ressassait un paiement du matin). history_search le retrouve.
      `SELECT name, left(args, 300) AS args, left(result, 6000) AS result, created_at FROM tool_calls
       WHERE user_id = $1 AND created_at > $2::timestamptz - interval '24 hours' AND created_at <= $2::timestamptz AND name NOT IN ('progress', 'skill_view', 'react')
         AND created_at >= coalesce((SELECT min(sent_at) FROM (SELECT sent_at FROM messages WHERE user_id = $1 AND sent_at <= $2::timestamptz ORDER BY id DESC LIMIT ${HISTORY}) w), $2::timestamptz - interval '24 hours')
       ORDER BY id DESC LIMIT 10`,
      [userId, at],
    )
  ).rows;
  if (!rows.length) return undefined;
  // Les plus récents en entier ou presque : coupé à 1 500 caractères, un gmail_search de 15 mails perdait les
  // rendez-vous qu'il venait de citer, et le tour suivant se démentait (« je me suis embrouillé », 20/10).
  let budget = 16000;
  rows.forEach((r, i) => {
    const room = Math.max(0, Math.min(i < 3 ? 6000 : 1500, budget));
    if (r.result.length > room) r.result = `${r.result.slice(0, room)}…`;
    budget -= r.result.length;
  });
  rows.reverse();
  const hm = (d: Date) => new Date(d).toISOString().slice(11, 16);
  return `Ce que tes outils ont rendu pendant la conversation ci-dessous (UTC, le plus récent en bas) : c'est la source de ce que tu y as dit. Ne le refais pas, ne le démens pas sans l'avoir revérifié.\n${rows.map((r) => `- ${hm(r.created_at)} ${r.name} ${r.args} => ${r.result}`).join("\n")}`;
}

/**
 * Le prompt système d'un tour ou d'un travail, à l'instant `now`, avec ce que ses outils ont rendu (dans le système :
 * jamais une réponse à faire). Le banc de rejeu le reconstruit pour un tour passé.
 */
export async function turnSystem(db: Pick<Db, "query">, user: User, now: Date, mode: "tool" | "task", opts: { jobId?: string } = {}): Promise<string> {
  return systemPrompt(db, user, now, mode, { ...opts, results: await recentResults(db, user.id, now) });
}

/** Le fil, suivi de la manière d'écrire : au plus près de la réponse, pas sous 60 messages (21/10). */
export function withReminder(history: ChatMessage[], lang: string): ChatMessage[] {
  return [...history, { role: "system", content: turnReminder(lang) }];
}

/** Ce qui est arrivé pendant le travail, remis au modèle : ses messages à elle, ou un avis du système tel quel. */
export function arrivals(fresh: string[]): string {
  return fresh.map((t) => (t.startsWith("[système]") ? t : `[système] Pendant que tu travaillais, elle a écrit : « ${t} ». Tiens-en compte maintenant.`)).join("\n\n");
}

/** Traite le tour d'une personne. Appelé sous verrou. */
export async function handleTurn(db: Db, cfg: Config, llm: Llm, userId: string): Promise<void> {
  const user = await getUser(db, userId);
  const pending = (
    await db.query<Pending>(
      `SELECT id::int, guid, text, tapback, target_guid FROM messages WHERE user_id = $1 AND direction = 'in' AND processed_at IS NULL ORDER BY id`,
      [userId],
    )
  ).rows;
  if (!pending.length) return;
  void refreshVoiceNote(db, cfg, llm, user); // sa façon d'écrire, relue en fond ; sert dès le tour suivant
  void refreshThreadSummary(db, cfg, llm, user); // la fiche de reprise de ce qui sort du fil, en fond
  void refreshRhythm(db, cfg, llm, user); // ses heures de passage, relues chaque semaine sur son vrai rythme
  // Photos et vocaux deviennent du texte avant tout le reste.
  const enriched = await readAttachments(db, cfg, llm, user, pending.map((p) => p.id));
  for (const p of pending) if (enriched.has(p.id)) p.text = enriched.get(p.id)!;
  const markDone = () => db.query(`UPDATE messages SET processed_at = now() WHERE id = ANY($1::bigint[])`, [pending.map((p) => p.id)]);
  const lastGuid = [...pending].reverse().find((p) => p.guid && !p.tapback)?.guid ?? [...pending].reverse().find((p) => p.guid)?.guid ?? null;
  // Ce qu'elle a écrit elle-même : sert à deviner sa langue (les réactions traduites sont en français).
  const ownText = pending.filter((p) => p.text?.trim()).map((p) => p.text!.trim()).join("\n");

  // 0. Une tâche web attend un code (SMS, mail) et c'est ce que la personne envoie : il part à la tâche.
  if (await takeCodeReply(db, userId, pending)) {
    if (lastGuid) await enqueue(db, [{ userId, kind: "tapback", tapback: "like", targetGuid: lastGuid }]);
    await markDone();
    return;
  }

  // 0 bis. Son 👍 sur une carte vaut le bouton de la carte (réserver, acheter, choisir) : un seul geste, son accord.
  const onCards = await cardReactions(db, cfg, userId, pending, isPositiveTapback);
  if (onCards.size) {
    await db.query(`UPDATE messages SET processed_at = now() WHERE id = ANY($1::bigint[])`, [[...onCards]]);
    for (let i = pending.length - 1; i >= 0; i--) if (onCards.has(pending[i].id)) pending.splice(i, 1);
    if (!pending.length) return;
  }

  // 1. Ses réactions sur nos bulles deviennent des phrases (👍 sur « Je le prends ? » = oui) ; l'agent décide du reste.
  const reacted = await readReactions(db, userId, pending.filter((p) => !p.text && p.tapback && p.target_guid));
  for (const p of pending) if (reacted.has(p.id)) p.text = reacted.get(p.id)!;
  if (!pending.some((p) => p.text?.trim())) {
    await markDone();
    return;
  }
  // Elle répond dans la langue de son dernier message ; une langue nette devient aussi sa langue préférée (rappels, brief).
  const lang = detectLang(ownText) ?? user.lang;
  if (lang !== user.lang) {
    await db.query(`UPDATE users SET lang = $2 WHERE id = $1`, [userId, lang]);
    user.lang = lang;
  }

  // 2. Un seul agent, avec tout le contexte et tous ses outils, décide de tout : répondre, réagir, agir, valider une
  // tâche sur son oui, lancer un travail de fond, ou transmettre ce qu'elle ajoute au travail déjà en cours. Plus de tri
  // ni de juge à côté de lui (19/10 : la réponse rapide sans outils reniait de vrais résultats, le tri ratait « vazy »).
  let acked = false;
  // Ça traîne : les trois petits points restent allumés (la bulle d'avancement prend le relais dès qu'un outil part).
  const ackTimer = setTimeout(() => {
    acked = true;
    keepTyping(db, userId).catch(() => {});
  }, cfg.ackAfterMs);
  // Le tour compte comme un travail : pas de bulle d'avancement avant 25 s (une recherche de 15 s n'en a pas besoin).
  const turnToken = startWork(userId, lastGuid);
  try {
    const now = new Date();
    const out = await runAgentLoop(db, llm, user, {
      mode: "tool",
      model: cfg.models.tool,
      system: await turnSystem(db, user, now, "tool"),
      history: withReminder(await buildHistory(db, userId), user.lang),
      deadline: Date.now() + 120_000,
      cfg,
      statusModel: cfg.models.quick,
      narrateAfter: Date.now() + Math.min(cfg.ackAfterMs, 3000),
      sourceGuid: lastGuid,
    });
    clearTimeout(ackTimer);
    // Passé la main à un travail de fond : sa bulle d'avancement reste ouverte, le travail la continue et la ferme avec le
    // résultat (le 19/10, « ✓ Terminé » s'affichait 110 s avant la réponse).
    const handedOff = (await db.query(`SELECT 1 FROM jobs WHERE user_id = $1 AND status IN ('queued', 'running') LIMIT 1`, [userId])).rows.length > 0;
    // Comme Instinct (face-à-face du 19/10) : chaque réponse s'accroche au message auquel elle répond (« Répondre »).
    if (handedOff) await send(db, userId, out, acked ? null : lastGuid, lastGuid);
    else await finish(db, userId, user.lang, out, acked ? null : lastGuid, lastGuid);
  } finally {
    clearTimeout(ackTimer);
    endWork(userId, turnToken);
  }
  await markDone();
}

/** Personnes qui ont des messages en attente depuis plus de `debounceMs`, verrou pris. */
export async function claimTurns(db: Db, cfg: Config, limit: number): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE users SET turn_lock_until = now() + make_interval(secs => $1)
     WHERE id IN (
       SELECT u.id FROM users u
       WHERE (u.turn_lock_until IS NULL OR u.turn_lock_until < now())
         AND EXISTS (SELECT 1 FROM messages m WHERE m.user_id = u.id AND m.direction = 'in' AND m.processed_at IS NULL)
         AND (SELECT max(sent_at) FROM messages m WHERE m.user_id = u.id AND m.direction = 'in' AND m.processed_at IS NULL)
             < now() - make_interval(secs => $2)
       LIMIT $3 FOR UPDATE SKIP LOCKED)
     RETURNING id`,
    [TURN_LOCK_SECONDS, cfg.debounceMs / 1000, limit],
  );
  return rows.map((r) => r.id);
}

export async function releaseTurn(db: Db, userId: string): Promise<void> {
  await db.query(`UPDATE users SET turn_lock_until = NULL WHERE id = $1`, [userId]);
}

/** Travaux de fond : un bail de 10 min, deux tentatives, une date limite. Au bout, on prévient. */
export async function runJobs(db: Db, cfg: Config, llm: Llm, limit = 4): Promise<number> {
  let jobs = (
    await db.query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = now() + interval '10 minutes'
       WHERE id IN (SELECT j.id FROM jobs j
                    WHERE (j.status = 'queued' OR (j.status = 'running' AND j.lease_until < now())) AND j.attempts < 2 AND j.deadline_at > now()
                      -- Jamais deux travaux à la fois pour la même personne.
                      AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.user_id = j.user_id AND r.id <> j.id AND r.status = 'running' AND r.lease_until >= now())
                    ORDER BY j.created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [limit],
    )
  ).rows;
  // Deux travaux en attente de la même personne pris dans le même lot : le plus ancien part, l'autre attend son tour.
  const firstOf = new Set<string>();
  for (const job of [...jobs].sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())) {
    if (!firstOf.has(job.user_id)) firstOf.add(job.user_id);
    else {
      await db.query(`UPDATE jobs SET status = 'queued', attempts = attempts - 1, lease_until = NULL WHERE id = $1`, [job.id]);
      job.skip = true;
    }
  }
  jobs = jobs.filter((j: any) => !j.skip);
  // Travaux morts (tentatives ou délai épuisés) : on clôt et on prévient la personne.
  const dead = (
    await db.query(
      `UPDATE jobs SET status = 'failed', finished_at = now(), error = coalesce(error, 'abandonné')
       WHERE (status = 'queued' OR (status = 'running' AND lease_until < now())) AND (attempts >= 2 OR deadline_at <= now())
       RETURNING user_id`,
    )
  ).rows;
  for (const d of dead) await apologize(db, d.user_id);

  await Promise.all(
    jobs.map(async (job: any) => {
      // Une tâche web peut tenir plusieurs minutes (et attendre un code) : le bail suit.
      const heartbeat = setInterval(() => {
        db.query(`UPDATE jobs SET lease_until = now() + interval '10 minutes' WHERE id = $1 AND status = 'running'`, [job.id]).catch(() => {});
      }, 60_000);
      // Les trois petits points restent allumés tant que Mell travaille. Pas pour un retour qu'il s'était fixé :
      // il peut finir sans rien dire, et des points sans message derrière inquiètent.
      const quiet = !!job.quiet_ok;
      if (!quiet) await keepTyping(db, job.user_id).catch(() => {});
      const typing = quiet ? undefined : setInterval(() => keepTyping(db, job.user_id).catch(() => {}), 35_000);
      const workToken = startWork(job.user_id, job.source_guid);
      try {
        const user = await getUser(db, job.user_id);
        const history = await buildHistory(db, job.user_id);
        // Ce qui lui a été remis avant qu'il démarre part avec la demande ; la suite arrive entre deux étapes.
        const initial: string[] = Array.isArray(job.followups) ? job.followups : [];
        let seen = initial.length;
        const request = job.request.startsWith("[système]") ? job.request : `[système] À toi de faire maintenant, avec tes outils (c'est toi le travail de fond lancé pour cette demande) : ${job.request}`;
        history.push({ role: "user", content: initial.length ? `${request}\n\n${arrivals(initial)}` : request });
        const incoming = async () => {
          const all: string[] = (await db.query<{ followups: string[] }>(`SELECT followups FROM jobs WHERE id = $1`, [job.id])).rows[0]?.followups ?? [];
          const fresh = all.slice(seen);
          seen = all.length;
          return fresh;
        };
        const out = await runAgentLoop(db, llm, user, {
          mode: "task",
          model: job.model,
          system: await turnSystem(db, user, new Date(), "task", { jobId: String(job.id) }),
          history: withReminder(history, user.lang),
          deadline: Math.min(new Date(job.deadline_at).getTime(), Date.now() + 15 * 60_000),
          cfg,
          statusModel: cfg.models.quick,
          incoming,
          allowSilence: quiet,
          sourceGuid: job.source_guid,
        });
        // Un travail qui a mené un site : la revue en tire ses modes d'emploi, en fond, sans retarder la réponse.
        const sited = (await db.query(`SELECT 1 FROM tool_calls WHERE user_id = $1 AND created_at >= $2 AND name IN ('browse', 'sncf_search', 'thefork_search', 'doctolib_search', 'booking_search', 'vault_fill') LIMIT 1`, [job.user_id, job.created_at])).rows.length > 0;
        if (sited) {
          const review = import("./review.ts").then(({ reviewJob }) => reviewJob(db, cfg, llm, { ...job, result: out }));
          pendingReviews.add(review);
          void review.finally(() => pendingReviews.delete(review));
        }
        // Comme Instinct : ce qui découle d'une demande lui répond dans son fil (« 5 réponses » sous son message).
        await db.tx(async (q) => {
          await finish(q, job.user_id, user.lang, out, null, job.source_guid);
          // Verrou sur la ligne : une demande remise en même temps est soit lue ici, soit refusée par createJob
          // (le travail n'est plus ouvert) et part dans un travail à elle. Rien ne se perd entre les deux.
          const all: string[] = (await q.query<{ followups: string[] }>(`SELECT followups FROM jobs WHERE id = $1 FOR UPDATE`, [job.id])).rows[0]?.followups ?? [];
          await q.query(`UPDATE jobs SET status = 'done', result = $2, finished_at = now() WHERE id = $1`, [job.id, out]);
          const late = all.slice(seen);
          if (late.length) {
            await q.query(`INSERT INTO jobs (user_id, request, model, deadline_at, followups) VALUES ($1, $2, $3, now() + interval '20 minutes', $4::jsonb)`, [
              job.user_id,
              "[système] Suite du fil : ce qui suit est arrivé pendant que tu finissais ta réponse précédente, déjà partie.",
              job.model,
              JSON.stringify(late),
            ]);
          }
        });
      } catch (e) {
        const last = job.attempts >= 2;
        await db.query(`UPDATE jobs SET status = $2, error = $3, lease_until = NULL, finished_at = CASE WHEN $2 = 'failed' THEN now() END WHERE id = $1`, [
          job.id,
          last ? "failed" : "queued",
          String(e).slice(0, 500),
        ]);
        if (last) await apologize(db, job.user_id);
      } finally {
        endWork(job.user_id, workToken);
        clearInterval(heartbeat);
        if (typing) clearInterval(typing);
      }
    }),
  );
  return jobs.length;
}

async function apologize(db: Pick<Db, "query">, userId: string): Promise<void> {
  const user = await getUser(db, userId);
  await enqueue(db, [
    {
      userId,
      kind: "text",
      text: user.lang === "fr" ? "Je bloque sur ta demande, je n'ai pas réussi à la finir. Je réessaie ?" : "I got stuck on that one and couldn't finish it. Want me to try again?",
    },
  ]);
}
