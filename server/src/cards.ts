import { randomBytes } from "node:crypto";
import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "./db.ts";
import type { Config } from "./config.ts";
import { enqueue } from "./outbox.ts";
import { progressBecome } from "./progress.ts";
import { pickLine } from "./lines.ts";
import { getUser } from "./users.ts";
import { authorizeNow, describeScope, formatMoney, recordStep } from "./tasks.ts";
import { createJob } from "./agent.ts";
import { googleRuntime } from "./google/runtime.ts";
import { sendDraft, type OutgoingMail } from "./google/gmail.ts";
import { cardPhoto, previewUrl } from "./preview.ts";
import { FONT_FAMILY, headTags } from "./web/da.ts";
import { mailRuntime } from "./mail/runtime.ts";
import { mailArgs, outboundIdentity, sendOutbound } from "./mail/outbound.ts";

type Q = Pick<Db, "query">;

/**
 * Cartes d'action. Tout ce que Mell prépare et qui attend l'accord de la personne part en carte : une
 * option trouvée sur le web (photo, prix, « Réserver · 18 € »), un brouillon de mail (« Envoyer »,
 * « Modifier »), un achat (« Acheter · 34 € »). La carte est un lien seul dans sa bulle, qu'iMessage
 * affiche avec son titre et sa photo. Une option qui a sa page sur un site (Booking, Amazon...) : le
 * toucher ouvre directement ce site, comme une intégration de l'iPhone, et son 👍 sur la carte vaut le
 * bouton (« Réserver · 18 € »). Une carte sans site (un brouillon de mail) ouvre une page Mell avec ses
 * boutons. Le geste est son accord pour cette action précise : Mell la fait, sans redemander.
 */

export type CardKind = "option" | "draft" | "purchase" | "info";
export type CardAction = "choose" | "edit" | "send_mail" | "book" | "buy" | "open";

export interface CardInput {
  kind?: CardKind;
  title: string;
  subtitle?: string;
  body?: string;
  url?: string;
  image?: string;
  priceCents?: number;
  actions?: CardAction[];
  meta?: Record<string, unknown>;
}

export interface Card {
  id: string;
  user_id: string;
  kind: CardKind;
  title: string;
  subtitle: string | null;
  body: string | null;
  url: string | null;
  image_url: string | null;
  source_host: string | null;
  price_cents: number | null;
  currency: string;
  actions: CardAction[];
  meta: Record<string, any>;
  chosen_at: Date | null;
  done_action: string | null;
}

const isPublicHttp = (u: string | undefined): u is string => {
  if (!u) return false;
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1)/.test(x.hostname);
  } catch {
    return false;
  }
};

// Le navigateur recopie parfois un bout de balise avec le texte de la page (« CASE-YES</title> »).
const plain = (s: string) => s.replace(/<\/?[a-z][^>]*>/gi, "").trim();

const ACTIONS: readonly CardAction[] = ["choose", "edit", "send_mail", "book", "buy", "open"];

export async function createCard(q: Q, userId: string, c: CardInput): Promise<Card> {
  const id = randomBytes(9).toString("base64url");
  const url = isPublicHttp(c.url) ? c.url : undefined;
  const image = isPublicHttp(c.image) ? c.image : undefined;
  let host: string | null = null;
  try {
    host = url ? new URL(url).host.replace(/^www\./, "") : null;
  } catch {}
  let actions = (c.actions ?? ["choose"]).filter((a) => ACTIONS.includes(a));
  // Réserver ou acheter sans prix connu : la carte sert à choisir, Mell proposera le prix ensuite.
  if (!c.priceCents) actions = actions.map((a) => (a === "book" || a === "buy" ? "choose" : a));
  if (url && !actions.includes("open")) actions.push("open");
  const { rows } = await q.query<Card>(
    `INSERT INTO cards (id, user_id, kind, title, subtitle, body, url, image_url, source_host, price_cents, actions, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      id,
      userId,
      c.kind ?? "option",
      plain(c.title).slice(0, 120),
      c.subtitle ? plain(c.subtitle).slice(0, 160) : null,
      c.body?.slice(0, 6000) ?? null,
      url ?? null,
      image ?? null,
      host,
      c.priceCents ? Math.round(c.priceCents) : null,
      JSON.stringify([...new Set(actions)]),
      JSON.stringify(c.meta ?? {}),
    ],
  );
  return rows[0];
}

/**
 * La photo d'aperçu d'une page, celle qu'iMessage afficherait (og:image, sinon twitter:image) : une option trouvée par
 * recherche web arrive sans photo, et la carte n'en montrait aucune (« Donne les images », 19/10).
 */
export async function pagePreview(url: string): Promise<{ image?: string; title?: string }> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return {};
    const html = (await res.text()).slice(0, 400_000);
    const meta = (key: string) =>
      html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["']`, "i"))?.[1] ??
      html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`, "i"))?.[1];
    const raw = meta("og:image") ?? meta("og:image:url") ?? meta("twitter:image");
    let image: string | undefined;
    try {
      image = raw ? new URL(raw.replace(/&amp;/g, "&"), res.url || url).href : undefined;
    } catch {}
    return { image: isPublicHttp(image) ? image : undefined, title: meta("og:title") };
  } catch {
    return {};
  }
}

const words = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !["les", "des", "rue", "paris", "restaurant", "the", "and", "cafe", "bar", "hotel"].includes(w));

/**
 * La photo d'un lieu par Google Places (MELLA_GOOGLE_PLACES_KEY), quand sa page n'en donne pas : TheFork, Tripadvisor ou
 * PagesJaunes refusent tout navigateur piloté (403, même depuis une box), et la carte partait sans photo (Charonne, 19/10).
 * Le lieu trouvé doit porter le nom de la carte : un produit ou un train ne prend jamais la photo d'un commerce voisin.
 * Rend l'adresse publique de la photo (sans la clé), ou undefined.
 */
export async function placePhoto(title: string, hint?: string): Promise<string | undefined> {
  const key = process.env.MELLA_GOOGLE_PLACES_KEY;
  if (!key) return undefined;
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key, "x-goog-fieldmask": "places.displayName,places.photos.name" },
      body: JSON.stringify({ textQuery: [title, hint].filter(Boolean).join(" ").slice(0, 200), languageCode: "fr", maxResultCount: 1 }),
      signal: AbortSignal.timeout(6000),
    });
    const place = ((await res.json()) as any)?.places?.[0];
    const photo: string | undefined = place?.photos?.[0]?.name;
    const theirs = words(String(place?.displayName?.text ?? ""));
    if (!photo || !words(title).some((w) => theirs.includes(w))) return undefined;
    const media = await fetch(`https://places.googleapis.com/v1/${photo}/media?maxWidthPx=1200&skipHttpRedirect=true&key=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(6000),
    });
    const uri = ((await media.json()) as any)?.photoUri;
    return isPublicHttp(uri) ? uri : undefined;
  } catch {
    return undefined;
  }
}

/** Options rapportées par le navigateur. `action` : ce que fait le bouton principal (« choose », « book », « buy »). */
export async function saveCards(
  q: Q,
  userId: string,
  cards: Array<{ title: string; subtitle?: string; url?: string; image?: string; priceCents?: number }>,
): Promise<Array<{ id: string; title: string; subtitle?: string; photo: boolean; price?: string }>> {
  const out: Array<{ id: string; title: string; subtitle?: string; photo: boolean; price?: string }> = [];
  for (const c of cards.slice(0, 6)) {
    const image = c.image || (await placePhoto(c.title, c.subtitle));
    const card = await createCard(q, userId, { kind: "option", title: c.title, subtitle: c.subtitle, url: c.url, image, priceCents: c.priceCents, actions: ["choose"] });
    out.push({ id: card.id, title: c.title, subtitle: c.subtitle, photo: !!card.image_url, price: c.priceCents ? formatMoney(c.priceCents) : undefined });
  }
  return out;
}

/**
 * Envoie des cartes dans le fil : une bulle d'intro, puis pour chaque carte sa photo et une ligne avec son lien. `action` change le
 * bouton principal des options déjà gardées (réserver ou acheter quand le prix est connu).
 */
export async function sendCards(q: Q, userId: string, publicUrl: string, ids: string[], intro?: string, action?: "choose" | "book" | "buy"): Promise<number> {
  const rows = (await q.query<Card>(`SELECT * FROM cards WHERE user_id = $1 AND id = ANY($2::text[])`, [userId, ids.slice(0, 4)])).rows;
  const ordered = ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean) as Card[];
  if (action && action !== "choose") {
    for (const c of ordered) {
      if (!c.price_cents) continue;
      const actions = [action, ...c.actions.filter((a) => a !== "choose" && a !== "book" && a !== "buy")];
      await q.query(`UPDATE cards SET actions = $2 WHERE id = $1`, [c.id, JSON.stringify(actions)]);
    }
  }
  const base = publicUrl.replace(/\/+$/, "");
  // Chaque option : sa photo (elle s'affiche toujours d'office, quand un lien seul demande « Toucher pour
  // charger l'aperçu »), puis une ligne nom · prix · site avec le lien dans le texte. Le 👍 sur l'une ou
  // l'autre vaut « je prends celui-là ».
  const bubbles = ordered.flatMap((c) => {
    const line = [c.title, c.price_cents ? formatMoney(c.price_cents) : undefined, c.source_host ?? undefined].filter(Boolean).join(" · ");
    // Une carte de lien native : la photo du site telle quelle (le relais l'envoie dans la carte, le titre est
    // celui de la ligne). Sans photo, une carte texte rendue par nous ; sans aperçu du tout, un simple lien texte.
    const pv = c.image_url
      ? `${base}/c/${c.id}/image?n=${ordered.length}`
      : previewUrl({ title: c.title, subtitle: c.price_cents ? formatMoney(c.price_cents, c.currency) : (c.subtitle ?? undefined), host: c.source_host ?? undefined });
    const caption = `${line}\n${base}/c/${c.id}`;
    return [pv ? { userId, kind: "card" as const, image: pv, text: caption, ref: `card:${c.id}` } : { userId, kind: "text" as const, text: caption, ref: `card:${c.id}` }];
  });
  // Pendant un travail, la bulle d'avancement devient l'intro : sinon c'est le résultat qui la reprenait, au-dessus des
  // cartes, et l'intro partait en plus (face-à-face du 19/10, rue de Bretagne).
  const top = intro?.trim();
  const became = top ? await progressBecome(q, userId, top) : false;
  await enqueue(q, [...(top && !became ? [{ userId, kind: "text" as const, text: top }] : []), ...bubbles]);
  return ordered.length;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.45 ${FONT_FAMILY}}
main{max-width:30rem;margin:0 auto;padding:0 16px 32px}.ph{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:var(--line);border-radius:0 0 18px 18px}
h1{font-size:24px;line-height:1.2;margin:22px 0 6px}p.sub{color:var(--mut);margin:0 0 20px}.kind{color:var(--mut);font-size:13px;letter-spacing:.04em;text-transform:uppercase;margin-top:22px}
.body{white-space:pre-wrap;background:var(--card);border-radius:14px;padding:14px 16px;margin:0 0 22px;font-size:16px}
.meta{color:var(--mut);font-size:14px;margin:-8px 0 16px}
form{margin:0}.b{display:block;text-align:center;text-decoration:none;font-weight:600;padding:15px;border-radius:999px;border:0;width:100%;font-size:17px;cursor:pointer;margin-top:10px;font-family:inherit}
.p{background:var(--btn);color:var(--btnfg)}.s{background:transparent;color:var(--fg);border:1px solid var(--line)}
.done{font-weight:600;margin:6px 0 0}.brand{color:var(--mut);font-size:13px;text-align:center;margin-top:28px}`;

function page(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>${head}${headTags()}<style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function label(a: CardAction, c: Card, en: boolean): string {
  const price = c.price_cents ? ` · ${formatMoney(c.price_cents, c.currency)}` : "";
  switch (a) {
    case "choose":
      return en ? "I'll take this one" : "Je prends celui-là";
    case "edit":
      return en ? "Edit" : "Modifier";
    case "send_mail":
      return en ? "Send" : "Envoyer";
    case "book":
      return (en ? "Book" : "Réserver") + price;
    case "buy":
      return (en ? "Buy" : "Acheter") + price;
    case "open":
      return en ? `View on ${c.source_host ?? "the site"}` : `Voir sur ${c.source_host ?? "le site"}`;
  }
}

/** Le geste principal d'une carte : ce que vaut son 👍 (réserver, acheter, choisir). */
export function primaryAction(c: Pick<Card, "actions">): CardAction | undefined {
  return c.actions.find((a) => a !== "open" && a !== "edit");
}

/**
 * Fait l'action d'une carte : son accord pour celle-là, donné par un bouton ou par son 👍. Un seul geste par
 * carte : un second (ou un aperçu qui rejoue) ne refait rien et rend « already ». En cas d'échec, la carte
 * redevient disponible et l'erreur remonte.
 */
export async function actOnCard(
  db: Db,
  cfg: Pick<Config, "taskAuthorizationHours" | "models">,
  c: Card,
  action: CardAction,
  wake: () => void = () => {},
): Promise<"done" | "already"> {
  const mellMail = action === "send_mail" && c.meta?.mailProvider === "mell";
  const { rows } = await db.query(`UPDATE cards SET done_action = $2, chosen_at = now() WHERE id = $1 AND done_action IS NULL RETURNING id`, [c.id, mellMail ? "mail_pending" : action]);
  if (!rows.length) return "already";
  const user = await getUser(db, c.user_id);
  const en = user?.lang === "en";
  const tell = async (text: string) => {
    await db.query(`INSERT INTO messages (user_id, direction, guid, text) VALUES ($1, 'in', $2, $3) ON CONFLICT (guid) DO NOTHING`, [c.user_id, `card:${c.id}:${Date.now()}`, text]);
    await enqueue(db, [{ userId: c.user_id, kind: "typing" }]);
    wake();
  };
  try {
    if (action === "send_mail") {
      if (mellMail) {
        const rt = mailRuntime();
        if (!rt || !user) throw new Error("brouillon introuvable");
        const identity = await outboundIdentity(db, rt.cfg, user);
        if (c.meta.from !== identity.from || c.meta.replyTo !== identity.replyTo) throw new Error("l'adresse d'envoi a changé : prépare un nouveau brouillon");
        const mail = mailArgs({ ...c.meta.mail, reply_to_id: c.meta.mail?.replyToId });
        const task = await authorizeNow(db, c.user_id, { title: `Envoyer « ${mail.subject || c.title} »`, actions: ["send_email"], spendCapCents: 0, recipients: [...mail.to, ...mail.cc] }, cfg.taskAuthorizationHours);
        const result = await sendOutbound(db, user, mail, task.id, c.id);
        if (!("status" in result)) throw new Error("envoi refusé par la garde");
        await db.query(`UPDATE cards SET done_action = $2 WHERE id = $1`, [c.id, `mail_${result.status}`]);
        await enqueue(db, [{ userId: c.user_id, kind: "text", text: result.accepted
          ? (en ? `Email to ${mail.to.join(", ")} accepted for sending ✓` : `Mail à ${mail.to.join(", ")} pris en charge pour envoi ✓`)
          : (en ? "I can't confirm the email was sent. I'm keeping it on hold to avoid sending it twice." : "Je ne peux pas confirmer l'envoi du mail. Je le garde en attente pour éviter de l'envoyer deux fois.") }]);
        return "done";
      }
      const g = googleRuntime();
      const mail = c.meta?.mail as OutgoingMail | undefined;
      if (!g || !mail || !c.meta?.draftId) throw new Error("brouillon introuvable");
      const task = await authorizeNow(db, c.user_id, { title: `Envoyer « ${mail.subject || c.title} »`, actions: ["send_email"], spendCapCents: 0, recipients: [...mail.to, ...mail.cc] }, cfg.taskAuthorizationHours);
      const d = await recordStep(db, task, { action: "send_email", amountCents: 0, detail: `mail « ${mail.subject.slice(0, 80)} » depuis la carte`, recipients: [...mail.to, ...mail.cc] });
      if (d.decision !== "allowed") throw new Error("envoi refusé par la garde");
      await sendDraft(g, db, user, String(c.meta.draftId), task.id);
      await enqueue(db, [{ userId: c.user_id, kind: "text", text: en ? `Sent to ${mail.to.join(", ")} ✓` : `Envoyé à ${mail.to.join(", ")} ✓` }]);
    } else if (action === "book" || action === "buy") {
      // Plafond : le prix affiché, plus une marge pour les frais et taxes vus au paiement.
      const cap = Math.round((c.price_cents ?? 0) * 1.15);
      const task = await authorizeNow(db, c.user_id, { title: `${action === "book" ? "Réserver" : "Acheter"} ${c.title}`, actions: [action, "pay", "fill_personal"], spendCapCents: cap }, cfg.taskAuthorizationHours);
      await createJob(
        db,
        cfg as Config,
        c.user_id,
        `[système] Elle a donné son accord pour ${action === "book" ? "réserver" : "acheter"} ${c.title}${c.subtitle ? ` (${c.subtitle})` : ""}, sur sa carte. La tâche ${task.id} est autorisée : ${describeScope(task)}. Fais-le maintenant avec browse et ce task_id${c.url ? `, en partant de ${c.url}` : ""}, en invité si le site le permet, puis rends compte.`,
      );
      await enqueue(db, [{ userId: c.user_id, kind: "typing" }]);
      wake();
    } else if (action === "edit") {
      await tell(`[sur la carte « ${c.title} », elle a touché Modifier]`);
    } else {
      await tell(`[choisi sur la carte] ${c.title}${c.subtitle ? ` (${c.subtitle})` : ""}`);
    }
  } catch (e) {
    const attempted = mellMail && (await db.query(`SELECT id FROM outbound_mail WHERE user_id = $1 AND draft_id = $2`, [c.user_id, c.id])).rows.length > 0;
    if (attempted) await db.query(`UPDATE cards SET done_action = 'mail_unknown' WHERE id = $1`, [c.id]);
    else await db.query(`UPDATE cards SET done_action = NULL, chosen_at = NULL WHERE id = $1`, [c.id]);
    throw e;
  }
  return "done";
}

/**
 * Ses 👍 posés sur des cartes, parmi les messages en attente : chacun vaut le bouton de la carte. Décidé ici,
 * pas par le modèle (c'est son accord). Rend les ids des messages traités.
 */
export async function cardReactions(
  db: Db,
  cfg: Pick<Config, "taskAuthorizationHours" | "models">,
  userId: string,
  pending: Array<{ id: number; tapback: string | null; target_guid: string | null; text: string | null }>,
  isPositive: (t: string) => boolean,
): Promise<Set<number>> {
  const handled = new Set<number>();
  for (const p of pending) {
    if (p.text || !p.tapback || !p.target_guid || !isPositive(p.tapback)) continue;
    const ref = (await db.query<{ ref: string | null }>(`SELECT ref FROM outbox WHERE user_id = $1 AND guid = $2 LIMIT 1`, [userId, p.target_guid])).rows[0]?.ref;
    if (!ref?.startsWith("card:")) continue;
    const c = (await db.query<Card>(`SELECT * FROM cards WHERE id = $1 AND user_id = $2`, [ref.slice(5), userId])).rows[0];
    const action = c && primaryAction(c);
    if (!c || !action) continue;
    try {
      await actOnCard(db, cfg, c, action);
      handled.add(p.id);
    } catch {
      // L'action n'est pas passée : la réaction reste au modèle, qui le dira simplement.
    }
  }
  return handled;
}

function doneText(a: string, en: boolean): string {
  if (a === "mail_accepted") return en ? "Accepted for sending ✓" : "Pris en charge pour envoi ✓";
  if (a === "mail_pending") return en ? "Sending is in progress. Please wait; this message will not be sent again." : "Envoi en cours. Patiente, ce mail ne sera pas envoyé à nouveau.";
  if (a === "mail_unknown" || a === "mail_failed") return en ? "Sending is not confirmed. Tell Mell in Messages so it can be checked before any new attempt." : "Envoi non confirmé. Dis-le à Mell dans Messages pour vérifier avant tout nouvel essai.";
  if (a === "send_mail") return en ? "Sent ✓" : "Envoyé ✓";
  if (a === "book" || a === "buy") return en ? "On it. Mell will keep you posted in Messages; you'll approve the payment in your bank's app." : "C'est parti. Mell te tient au courant dans Messages ; tu valideras le paiement dans l'appli de ta banque.";
  if (a === "edit") return en ? "Tell Mell in Messages what to change." : "Dis à Mell dans Messages ce que tu veux changer.";
  return en ? "Got it, Mell is on it in Messages." : "C'est noté, Mell s'en occupe dans Messages.";
}

export async function registerCardRoutes(
  http: FastifyInstance,
  deps: { db: Db; cfg: Pick<Config, "publicUrl" | "taskAuthorizationHours" | "models">; wake: () => void },
): Promise<void> {
  const { db, cfg } = deps;
  const base = cfg.publicUrl.replace(/\/+$/, "");
  const html = (reply: FastifyReply, code: number, body: string) =>
    reply.code(code).headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" }).send(body);
  const get = async (id: string) => (/^[A-Za-z0-9_-]{6,16}$/.test(id) ? (await db.query<Card>(`SELECT * FROM cards WHERE id = $1`, [id])).rows[0] : undefined);

  await http.register(async (scope) => {
    await scope.register(formbody, { bodyLimit: 1024 });

    scope.get("/c/:id", async (req, reply) => {
      const c = await get((req.params as { id: string }).id);
      if (!c) return html(reply, 404, page("Mell", `<h1>Cette carte n'existe plus.</h1>`));
      const en = (await getUser(db, c.user_id))?.lang === "en";
      const img = c.image_url ? `${base}/c/${c.id}/image` : "";
      const price = c.price_cents ? formatMoney(c.price_cents, c.currency) : "";
      const sub = c.subtitle ?? (c.body ? c.body.slice(0, 140) : "");
      // Le prix dans l'aperçu, sauf s'il y est déjà ; le nom du site source, pour que ça se lise comme le vrai site.
      const description = price && !/[€$£]/.test(sub) ? [price, sub].filter(Boolean).join(" · ") : sub;
      const site = c.url && c.source_host ? c.source_host : "Mell";
      // Une option qui a sa page sur un site : un robot d'aperçu lit la vignette (il n'exécute pas le JavaScript),
      // une personne qui touche la carte est renvoyée sur le vrai site tout de suite, sans écran intermédiaire.
      const go = c.url && c.kind !== "draft" ? c.url : undefined;
      const head = `<meta property="og:title" content="${esc(c.title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:site_name" content="${esc(site)}">${
        img ? `<meta property="og:image" content="${esc(img)}"><meta name="twitter:card" content="summary_large_image">` : ""
      }${go ? `<script>location.replace(${JSON.stringify(go).replace(/</g, "\\u003c")})</script>` : ""}`;
      const kindLabel = { option: "", draft: en ? "Draft" : "Brouillon", purchase: en ? "Purchase" : "Achat", info: "" }[c.kind];
      const mail = c.meta?.mail as OutgoingMail | undefined;
      const to = mail?.to?.length ? `<p class="meta">${en ? "To" : "À"} ${esc(mail.to.join(", "))}${mail.cc?.length ? `<br>Cc ${esc(mail.cc.join(", "))}` : ""}${mail.subject ? `<br>${esc(mail.subject)}` : ""}${c.meta.mailProvider === "mell" ? `<br>${en ? "From" : "De"} ${esc(String(c.meta.from))}<br>${en ? "Reply to" : "Répondre à"} ${esc(String(c.meta.replyTo))}` : ""}</p>` : "";
      const buttons = c.done_action
        ? `<p class="done">${esc(doneText(c.done_action, en))}</p>`
        : c.actions
            .map((a, i) =>
              a === "open"
                ? c.url
                  ? `<a class="b s" href="${esc(c.url)}" rel="noopener noreferrer">${esc(label(a, c, en))}</a>`
                  : ""
                : `<form method="post" action="/c/${c.id}/act/${a}"><button class="b ${i === 0 ? "p" : "s"}" type="submit">${esc(label(a, c, en))}</button></form>`,
            )
            .join("");
      return html(
        reply,
        200,
        page(
          c.title,
          `${img ? `<img class="ph" src="${esc(img)}" alt="">` : ""}${kindLabel ? `<p class="kind">${esc(kindLabel)}</p>` : ""}<h1>${esc(c.title)}</h1>${c.subtitle ? `<p class="sub">${esc(c.subtitle)}</p>` : ""}${to}${
            c.body ? `<div class="body">${esc(c.body)}</div>` : ""
          }${buttons}<p class="brand">Mell, by Murmell</p>`,
          head,
        ),
      );
    });

    // La photo passe par chez nous : le téléphone ne parle qu'à Mell, et l'aperçu iMessage la trouve à coup sûr.
    scope.get("/c/:id/image", async (req, reply) => {
      const c = await get((req.params as { id: string }).id);
      if (!c?.image_url || !isPublicHttp(c.image_url)) return reply.code(404).send();
      // `n` = nombre de cartes envoyées ensemble : seule = carrée, deux = 2:1, trois ou plus = 3:1.
      const n = Math.max(1, Math.min(6, Number((req.query as { n?: string }).n ?? 1) || 1));
      const photo = await cardPhoto(c.image_url, n);
      if (!photo) return reply.code(404).send();
      return reply.code(200).headers({ "content-type": "image/png", "cache-control": "public, max-age=86400" }).send(photo);
    });

    // Un bouton touché : c'est l'accord de la personne pour cette action précise.
    scope.post("/c/:id/act/:action", async (req, reply) => {
      const { id, action } = req.params as { id: string; action: string };
      const c = await get(id);
      if (!c) return html(reply, 404, page("Mell", `<h1>Cette carte n'existe plus.</h1>`));
      const user = await getUser(db, c.user_id);
      const en = user?.lang === "en";
      const back = async () => {
        const line = await pickLine(db);
        return line ? `<a class="b p" href="sms:${esc(line.handle)}">${en ? "Back to Messages" : "Retour à Messages"}</a>` : "";
      };
      if (!(c.actions as string[]).includes(action) || action === "open") return html(reply, 400, page("Mell", `<h1>${en ? "Not available." : "Pas disponible."}</h1>`));
      try {
        // Un seul geste par carte : un second toucher (ou un aperçu qui rejoue) ne refait rien.
        if ((await actOnCard(db, cfg, c, action as CardAction, deps.wake)) === "already") {
          const current = await get(c.id);
          return html(reply, 200, page("Mell", `<h1>${esc(c.title)}</h1><p class="done">${esc(doneText(current?.done_action ?? action, en))}</p>${await back()}`));
        }
      } catch (e) {
        req.log.error({ err: e instanceof Error ? e.message : e }, "action de carte en échec");
        return html(reply, 500, page("Mell", `<h1>${en ? "That didn't go through." : "Ça n'est pas passé."}</h1><p class="sub">${en ? "Try again, or tell Mell in Messages." : "Réessaie, ou dis-le à Mell dans Messages."}</p>`));
      }
      const current = await get(c.id);
      return html(reply, 200, page("Mell", `<h1>${esc(c.title)}</h1><p class="done">${esc(doneText(current?.done_action ?? action, en))}</p>${await back()}<p class="brand">Mell, by Murmell</p>`));
    });
  });
}
