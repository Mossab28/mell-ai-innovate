import { createHash } from "node:crypto";
import { EmailClient } from "@azure/communication-email";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { User } from "../users.ts";
import { getTask, normalizeEmail, recordStep } from "../tasks.ts";
import { ensureAddress } from "./address.ts";
import { mailRuntime } from "./runtime.ts";

type Q = Pick<Db, "query">;
export interface MellMail { to: string[]; cc: string[]; subject: string; body: string; replyToId?: number }
export type OutboundStatus = "pending" | "accepted" | "unknown" | "failed";
interface OutboundRow { id: string; status: OutboundStatus; provider_id: string | null }

export function outboundOn(cfg: Pick<Config, "mail">): boolean {
  return !!(cfg.mail.domains.length && cfg.mail.from && cfg.mail.azureConnectionString);
}

export function mailArgs(a: Record<string, any>): MellMail {
  const addresses = (value: unknown): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error("adresses invalides");
    return [...new Set(value.map(normalizeEmail))].sort();
  };
  const mail = { to: addresses(a.to), cc: addresses(a.cc), subject: String(a.subject ?? ""), body: String(a.body ?? ""), replyToId: a.reply_to_id === undefined ? undefined : Number(a.reply_to_id) };
  if (!mail.to.length || mail.to.length + mail.cc.length > 20) throw new Error("il faut entre 1 et 20 destinataires");
  if (!mail.body.trim() || mail.body.length > 6000) throw new Error("le texte doit contenir entre 1 et 6000 caractères");
  if (mail.subject.length > 998 || /[\r\n]/.test(mail.subject)) throw new Error("objet invalide");
  if (mail.replyToId !== undefined && (!Number.isSafeInteger(mail.replyToId) || mail.replyToId < 1)) throw new Error("mail de réponse introuvable");
  return mail;
}

export async function outboundIdentity(db: Q, cfg: Pick<Config, "mail">, user: User): Promise<{ from: string; replyTo: string }> {
  if (!outboundOn(cfg)) throw new Error("l'envoi de mails par Mell n'est pas encore disponible");
  const replyTo = await ensureAddress(db, cfg, user);
  if (!replyTo) throw new Error("adresse de réponse indisponible");
  return { from: normalizeEmail(cfg.mail.from!), replyTo };
}

function outcome(row: OutboundRow, duplicate = false) {
  return { accepted: row.status === "accepted", status: row.status, duplicate, operation_id: row.id, next: row.status === "accepted"
    ? "Le service a accepté l'envoi, pas encore confirmé la livraison."
    : "L'envoi n'est pas confirmé. Le renvoyer risquerait un doublon, même avec une autre tâche ou un nouveau brouillon." };
}

/** The row is claimed atomically before any HTTP request. A retry only reads that durable result. */
export async function sendOutbound(db: Q, user: User, mail: MellMail, taskId: string, draftId?: string) {
  const rt = mailRuntime();
  if (!rt) throw new Error("l'envoi de mails par Mell n'est pas encore disponible");
  const task = await getTask(db, user.id, taskId);
  if (!task) return { sent: false, decision: "needs_approval", next: "Montre le texte et propose_task avec send_email et chaque destinataire To et Cc, puis attends son accord." };
  const decision = await recordStep(db, task, { action: "send_email", amountCents: 0, detail: `mail « ${mail.subject.slice(0, 80)} »`, recipients: [...mail.to, ...mail.cc] });
  if (decision.decision !== "allowed") return { sent: false, ...decision, next: "Ça sort de ce qu'elle a validé : redemande-lui avant d'envoyer." };
  const identity = await outboundIdentity(db, rt.cfg, user);
  let headers: Record<string, string> | undefined;
  if (mail.replyToId !== undefined) {
    const original = (await db.query<{ message_id: string }>(`SELECT message_id FROM inbox WHERE user_id = $1 AND id = $2`, [user.id, mail.replyToId])).rows[0];
    if (!original || !/^<[^<>\s]+@[^<>\s]+>$/.test(original.message_id)) throw new Error("mail de réponse introuvable ou identifiant invalide");
    headers = { "In-Reply-To": original.message_id, References: original.message_id };
  }
  const hash = createHash("sha256").update(JSON.stringify(mail)).digest("hex");
  const key = draftId ? `draft:${draftId}` : `task:${taskId}:${hash}`;
  const claimed = (await db.query<OutboundRow>(`INSERT INTO outbound_mail (user_id, task_id, draft_id, dedupe_key) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING *`, [user.id, task.id, draftId ?? null, key])).rows[0];
  if (!claimed) {
    const previous = (await db.query<OutboundRow>(`SELECT * FROM outbound_mail WHERE user_id = $1 AND dedupe_key = $2`, [user.id, key])).rows[0];
    return outcome(previous, true);
  }

  let status: OutboundStatus = "unknown";
  let providerId: string | undefined;
  try {
    // No SDK retries for a send. A transport error may happen after Azure accepted the message.
    const client = rt.emailClient ?? new EmailClient(rt.cfg.mail.azureConnectionString!, { retryOptions: { maxRetries: 0 } });
    const signal = AbortSignal.timeout(30_000);
    const poller = await client.beginSend({ senderAddress: identity.from, replyTo: [{ address: identity.replyTo }], recipients: { to: mail.to.map((address) => ({ address })), cc: mail.cc.map((address) => ({ address })) }, content: { subject: mail.subject, plainText: mail.body }, headers, disableUserEngagementTracking: true }, { operationId: claimed.id, abortSignal: signal, updateIntervalInMs: 1000 });
    const result = await poller.pollUntilDone({ abortSignal: signal });
    providerId = result.id;
    status = result.status === "Succeeded" ? "accepted" : result.status === "Failed" || result.status === "Canceled" ? "failed" : "unknown";
  } catch {
    // Keep ambiguous results, including timeouts, locked. Never expose provider diagnostics or keys.
  }
  await db.query(`UPDATE outbound_mail SET status = $2, provider_id = $3, updated_at = now() WHERE id = $1`, [claimed.id, status, providerId ?? null]);
  return outcome({ ...claimed, status, provider_id: providerId ?? null });
}

/** Un mail simple depuis l'expéditeur de Mell (code de connexion) : pas de tâche, pas de brouillon, pas de Reply-To. */
export async function sendPlainMail(cfg: Pick<Config, "mail">, to: string, subject: string, text: string): Promise<boolean> {
  if (!outboundOn(cfg)) return false;
  try {
    const client = new EmailClient(cfg.mail.azureConnectionString!, { retryOptions: { maxRetries: 0 } });
    const signal = AbortSignal.timeout(30_000);
    const poller = await client.beginSend({ senderAddress: normalizeEmail(cfg.mail.from!), recipients: { to: [{ address: to }] }, content: { subject, plainText: text }, disableUserEngagementTracking: true }, { abortSignal: signal, updateIntervalInMs: 1000 });
    const result = await poller.pollUntilDone({ abortSignal: signal });
    return result.status === "Succeeded";
  } catch {
    return false;
  }
}
