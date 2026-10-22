import { createHash } from "node:crypto";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { authenticate, type AuthenticateResult } from "mailauth";
import type { Db } from "../db.ts";
import type { Config } from "../config.ts";
import { ownAddresses, userForRecipient } from "./address.ts";

type Q = Pick<Db, "query">;

/**
 * Un mail arrivé sur une adresse Mell : on le lit, on vérifie qui l'a vraiment envoyé, on le range
 * chez chaque personne destinataire. Ce qu'on en fait (agir, prévenir, se taire) se décide ensuite,
 * dans la boucle de la boîte (process.ts).
 */

export interface Envelope {
  ip?: string;
  helo?: string;
  mailFrom?: string;
  rcpts: string[];
}

export type AuthCheck = (raw: Buffer, env: Envelope) => Promise<AuthenticateResult | undefined>;

/** Corps gardé au plus : un mail plus long se lit en entier dans sa boîte à elle. */
const MAX_BODY = 20_000;

/** SPF, DKIM, DMARC et ARC par les DNS. Une panne DNS ne perd pas le mail : il arrive non authentifié. */
export const checkAuth: AuthCheck = async (raw, env) => {
  try {
    return await Promise.race([
      authenticate(raw, { ip: env.ip, helo: env.helo, sender: env.mailFrom, disableBimi: true }),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 15_000)),
    ]);
  } catch {
    return undefined;
  }
};

/** L'expéditeur affiché est-il bien celui qui a envoyé ? DMARC, ou à défaut une signature DKIM de son domaine. */
export function isAuthenticated(auth: AuthenticateResult | undefined, fromAddr: string | undefined): boolean {
  if (!auth || !fromAddr) return false;
  if (auth.dmarc && auth.dmarc.status.result === "pass") return true;
  const domain = fromAddr.split("@")[1]?.toLowerCase();
  return !!domain && auth.dkim.results.some((r) => r.status.result === "pass" && (r.signingDomain.toLowerCase() === domain || domain.endsWith(`.${r.signingDomain.toLowerCase()}`)));
}

/** Signé par Google lui-même (confirmation de transfert Gmail). */
function signedByGoogle(auth: AuthenticateResult | undefined): boolean {
  return !!auth?.dkim.results.some((r) => r.status.result === "pass" && r.signingDomain.toLowerCase() === "google.com");
}

function addresses(a: AddressObject | AddressObject[] | undefined): Array<{ address: string; name: string }> {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  return list.flatMap((o) => o.value).filter((v) => v.address).map((v) => ({ address: v.address!.toLowerCase(), name: v.name ?? "" }));
}

function header(p: ParsedMail, name: string): string {
  const v = p.headers.get(name);
  if (!v) return "";
  return typeof v === "string" ? v : Array.isArray(v) ? v.join(" ") : String((v as any).text ?? (v as any).value ?? v);
}

/**
 * La boîte qui a fait suivre ce mail, d'après les en-têtes que pose Gmail (X-Forwarded-For : « elle@gmail.com
 * alias@mell ») ou l'expéditeur d'enveloppe réécrit (« elle+caf_=alias=domaine@gmail.com »).
 */
export function forwarderOf(p: ParsedMail, env: Envelope, ours: Set<string>): string | undefined {
  const xff = header(p, "x-forwarded-for").toLowerCase().match(/[^\s,<>]+@[^\s,<>]+/g) ?? [];
  const caf = env.mailFrom?.toLowerCase().match(/^([^+@]+)\+caf_=[^@]*@(.+)$/);
  const candidates = [...xff, ...(caf ? [`${caf[1]}@${caf[2]}`] : [])].filter((a) => !ours.has(a));
  return candidates[0];
}

export interface Stored {
  userId: string;
  id: number;
  kind: string;
}

/**
 * Range un mail chez chaque destinataire Mell de l'enveloppe. Rend ce qui a été rangé (un mail déjà
 * reçu, par la copie et par le transfert à la fois, n'est rangé qu'une fois).
 */
export async function ingestMail(db: Q, cfg: Pick<Config, "mail">, raw: Buffer, env: Envelope, auth: AuthCheck = checkAuth): Promise<Stored[]> {
  const userIds = [...new Set((await Promise.all(env.rcpts.map((r) => userForRecipient(db, cfg, r)))).filter((u): u is string => !!u))];
  if (!userIds.length) return [];
  const [p, a] = await Promise.all([simpleParser(raw, { skipImageLinks: true }), auth(raw, env)]);
  const from = addresses(p.from)[0];
  const to = addresses(p.to);
  const cc = addresses(p.cc);
  const authenticated = isAuthenticated(a, from?.address);
  const messageId = (p.messageId ?? "").trim() || `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const body = (p.text ?? "").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_BODY);
  const attachments = (p.attachments ?? []).slice(0, 20).map((x) => ({ name: x.filename ?? "", type: x.contentType, size: x.size }));
  const stored: Stored[] = [];
  for (const userId of userIds) {
    const mine = new Set(await ownAddresses(db, userId));
    const forwardedBy = forwarderOf(p, env, new Set(env.rcpts.map((r) => r.toLowerCase())));
    let kind: Stored["kind"];
    if (from?.address === "forwarding-noreply@google.com" && signedByGoogle(a)) kind = "gmail_confirm";
    else if (from && mine.has(from.address) && authenticated) kind = "from_user";
    else if (forwardedBy && mine.has(forwardedBy)) kind = "forwarded";
    else kind = "other";
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO inbox (user_id, message_id, kind, from_addr, from_name, to_addrs, cc_addrs, subject, sent_at, body, attachments, authenticated, forwarded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (user_id, message_id) DO NOTHING RETURNING id`,
      [
        userId,
        messageId.slice(0, 500),
        kind,
        from?.address ?? null,
        from?.name?.slice(0, 200) || null,
        to.map((x) => x.address).join(", ").slice(0, 2000) || null,
        cc.map((x) => x.address).join(", ").slice(0, 2000) || null,
        (p.subject ?? "").slice(0, 500) || null,
        p.date && !Number.isNaN(p.date.getTime()) ? p.date : null,
        body || null,
        JSON.stringify(attachments),
        authenticated,
        forwardedBy ?? null,
      ],
    );
    if (rows[0]) stored.push({ userId, id: Number(rows[0].id), kind });
  }
  return stored;
}
