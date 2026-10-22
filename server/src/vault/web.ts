import { readFile } from "node:fs/promises";
import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.ts";
import type { Config } from "../config.ts";
import { enqueue } from "../outbox.ts";
import { createJob } from "../agent.ts";
import { getUser } from "../users.ts";
import { consumeLink, issueLink, peekLink, releaseLink, type VaultLink } from "./links.ts";
import { normalizeSite } from "./refs.ts";
import { parseCardForm } from "./cards.ts";
import { bankResult } from "../tasks.ts";
import { parseTotpSeed } from "./totp.ts";
import type { VaultService } from "./service.ts";
import { PERSONAL_FIELDS, VaultError } from "./types.ts";
import { COPY, VAULT_PREVIEW_PATH, vaultForm, vaultStatus, type VaultLanguage } from "./view.ts";
import { siteLang } from "../web/da.ts";

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // same-origin et pas no-referrer : avec no-referrer, Safari et Chrome envoient « Origin: null » au POST du formulaire,
  // et la protection ci-dessous refusait chaque dépôt (carte, compte, infos perso). Rien ne part vers un autre site.
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

/** Safe display of a payment reference, without exposing a card number. */
export function cardLabel(ref: string): string {
  const m = /card\/([a-z]+)-(\d{4})$/.exec(ref);
  if (!m) return "";
  const brand = { visa: "Visa", mastercard: "Mastercard", amex: "Amex", discover: "Discover" }[m[1]] ?? "";
  return `${brand ? `${brand} ` : ""}•••• ${m[2]}`;
}

/** Browser CSRF protection. The private link is still a bearer credential. */
function isSameOriginSubmission(req: FastifyRequest, publicUrl: string): boolean {
  const site = req.headers["sec-fetch-site"];
  const mode = req.headers["sec-fetch-mode"];
  if (site !== undefined && site !== "same-origin" && site !== "same-site" && site !== "none") return false;
  if (mode !== undefined && mode !== "navigate" && mode !== "same-origin" && mode !== "cors") return false;
  const origin = req.headers.origin;
  if (!origin) return site === "same-origin";
  // Origine masquée par le navigateur (page sans référent) : ses métadonnées disent déjà que le formulaire vient d'ici.
  if (origin === "null") return site === "same-origin" && mode === "navigate";
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !["https:", "http:"].includes(parsed.protocol)) return false;
    const expected = new URL(publicUrl);
    if (parsed.origin === expected.origin) return true;
    // Supports a same-origin alternate host, such as the existing deployment address.
    const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol).split(",")[0].trim();
    return parsed.origin === new URL(`${proto}://${req.host}`).origin;
  } catch {
    return false;
  }
}

const supportedKind = (link: VaultLink): boolean => ["login", "totp", "personal", "card"].includes(link.kind);

export async function registerVaultRoutes(http: FastifyInstance, deps: { db: Db; cfg: Config; vault: VaultService }): Promise<void> {
  const { db, cfg, vault } = deps;
  // La langue du site (celle du navigateur), comme toutes les autres pages : jamais la langue du compte Mell.
  const languageFor = (req: FastifyRequest): VaultLanguage => siteLang(req);
  const send = (reply: FastifyReply, code: number, html: string) => reply.code(code).headers(HEADERS).send(html);
  const gone = (reply: FastifyReply, lang: VaultLanguage = "fr") => send(reply, 410, vaultStatus(lang, cfg.publicUrl, COPY[lang].goneTitle, COPY[lang].gone));
  const validLink = async (link: VaultLink): Promise<boolean> => {
    if (!supportedKind(link)) return false;
    if ((link.kind === "login" || link.kind === "totp") && link.site) {
      try { if (normalizeSite(link.site) !== link.site || !link.site.includes(".") || link.site === "_pending") return false; }
      catch { return false; }
    }
    if (!link.task_id) return true;
    if ((link.kind === "login" || link.kind === "totp") && !link.site) return false;
    return (await db.query("SELECT 1 FROM tasks WHERE id = $1 AND user_id = $2", [link.task_id, link.user_id])).rows.length > 0;
  };
  const activeTask = async (link: VaultLink): Promise<boolean> => !!link.task_id && (await db.query(
    "SELECT 1 FROM tasks WHERE id = $1 AND user_id = $2 AND status IN ('proposed', 'authorized', 'awaiting_bank') AND (expires_at IS NULL OR expires_at > now())",
    [link.task_id, link.user_id],
  )).rows.length > 0;

  await http.register(async (scope) => {
    await scope.register(formbody, { bodyLimit: 16 * 1024 });
    const preview = await readFile(new URL("./assets/mell-vault-lock.png", import.meta.url));
    scope.get(VAULT_PREVIEW_PATH, async (_req, reply) => reply.headers({
      "content-type": "image/png", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff",
    }).send(preview));

    scope.get("/v/:token", async (req, reply) => {
      const link = await peekLink(db, (req.params as { token: string }).token);
      if (!link || !(await validLink(link))) return gone(reply, languageFor(req));
      const { ownAddresses } = await import("../mail/address.ts");
      const [username] = await ownAddresses(db, link.user_id).catch(() => [] as string[]);
      return send(reply, 200, vaultForm(languageFor(req), cfg.publicUrl, link, undefined, false, { username }));
    });

    scope.post("/v/:token", async (req, reply) => {
      if (!isSameOriginSubmission(req, cfg.publicUrl)) {
        const l = languageFor(req);
        return send(reply, 403, vaultStatus(l, cfg.publicUrl, COPY[l].forbiddenTitle, COPY[l].forbidden));
      }
      const token = (req.params as { token: string }).token;
      const link = await peekLink(db, token);
      if (!link || !(await validLink(link))) return gone(reply, languageFor(req));
      const lang = languageFor(req);
      const t = COPY[lang];
      const body: Record<string, string> = {};
      let site = "";
      const personal: Array<[string, string]> = [];
      let card: ReturnType<typeof parseCardForm> | undefined;

      // Validate before claiming the link. Never display provider errors or submitted values.
      try {
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new VaultError(t.invalid);
        for (const [key, value] of Object.entries(req.body)) {
          if (typeof value !== "string") throw new VaultError(t.invalid);
          body[key] = value;
        }
        const limits: Record<string, number> = { site: 2048, username: 320, password: 1024, seed: 2048, number: 40, exp: 12, cvc: 4, holder: 80 };
        for (const f of PERSONAL_FIELDS) limits[f] = 500;
        for (const [key, value] of Object.entries(body)) if (value.length > (limits[key] ?? 2048)) throw new VaultError(t.tooLong);
        if (link.kind === "card") {
          card = parseCardForm(body, lang);
        } else if (link.kind === "personal") {
          for (const f of PERSONAL_FIELDS) if (body[f]?.trim()) personal.push([f, body[f].trim()]);
          if (!personal.length) throw new VaultError(t.empty);
        } else {
          try {
            site = normalizeSite(body.site ?? link.site ?? "");
            if (!site.includes(".") || site === "_pending") throw new Error("invalid domain");
          } catch { throw new VaultError(t.siteInvalid); }
          if (link.site && site !== link.site) throw new VaultError(t.siteChanged);
          if (link.kind === "login" && !body.password) throw new VaultError(t.needPassword);
          if (body.seed?.trim()) {
            try { parseTotpSeed(body.seed); } catch { throw new VaultError(t.needSeed); }
          } else if (link.kind === "totp") throw new VaultError(t.needSeed);
        }
      } catch (error) {
        return send(reply, 400, vaultForm(lang, cfg.publicUrl, link, error instanceof VaultError ? error.message : t.invalid, !!body.seed));
      }

      // One external write per index transaction: a later failure cannot roll back earlier indexes.
      if (!(await consumeLink(db, token))) return gone(reply, lang);
      const ctx = { actor: "user_link" as const, taskId: link.task_id ?? undefined };
      const saved: string[] = [];
      try {
        if (card) {
          saved.push(await db.tx((q) => vault.putCard(q, link.user_id, card!, ctx)));
        } else if (link.kind === "personal") {
          for (const [field, value] of personal) saved.push(await db.tx((q) => vault.putPersonal(q, link.user_id, field, value, ctx)));
        } else {
          if (link.kind === "login") saved.push(await db.tx((q) => vault.putLogin(q, link.user_id, site, { username: (body.username ?? "").trim(), password: body.password }, ctx)));
          if (body.seed?.trim()) saved.push(await db.tx((q) => vault.putTotpSeed(q, link.user_id, site, body.seed, ctx)));
        }
      } catch {
        // Even a failed call can have reached the external vault. Do not claim it saved nothing.
        req.log.error({ event: "vault_write_unconfirmed", confirmedWrites: saved.length }, "Vault write confirmation unavailable");
        if (link.kind === "login" && saved.some((ref) => ref.startsWith("vault://login/")) && body.seed?.trim()) {
          try {
            const retry = await issueLink(db, cfg.publicUrl, { userId: link.user_id, kind: "totp", site, taskId: await activeTask(link) ? link.task_id! : undefined });
            return send(reply, 503, vaultStatus(lang, cfg.publicUrl, t.partialTitle, t.partial, { href: retry.url, label: t.retryTotp }));
          } catch {
            return send(reply, 503, vaultStatus(lang, cfg.publicUrl, t.partialTitle, t.partialNoLink));
          }
        }
        await releaseLink(db, token);
        return send(reply, 503, vaultStatus(lang, cfg.publicUrl, saved.length ? t.partialOtherTitle : t.downTitle, saved.length ? t.partialOther : t.down, { href: `/v/${token}`, label: t.retry }));
      }

      // La page parle la langue du navigateur ; le fil, celle de la conversation (un iPhone réglé en anglais
      // envoyait « Got it 🔒 » au milieu d'un fil en français, le 18/10).
      const threadLang: VaultLanguage = (await db.query<{ lang: string }>(`SELECT lang FROM users WHERE id = $1`, [link.user_id])).rows[0]?.lang === "en" ? "en" : "fr";
      const c = COPY[threadLang];
      const what = link.kind === "card" ? `${c.cardWhat} ${cardLabel(saved[0])}` : link.kind === "personal" ? c.personalWhat : `${site}${saved.some((r) => r.startsWith("vault://totp/")) ? " (2FA)" : ""}`;
      let notified = true;
      try {
        // Une nouvelle carte pour cette tâche abandonne le paiement resté en attente de la banque (code jamais reçu) :
        // la tâche redevient payable, avec cette carte (19/10).
        if (link.kind === "card" && link.task_id) await bankResult(db, link.task_id, false);
        const resume = await activeTask(link);
        await db.tx(async (q) => {
          await enqueue(q, [{ userId: link.user_id, kind: "text", text: resume ? c.resumed(what) : c.confirm(what) }]);
          if (resume) await createJob(q, cfg, link.user_id, `[système] L'utilisateur vient de ranger au coffre : ${saved.join(", ")}. Reprends la tâche ${link.task_id} là où elle attendait ces informations. L'enregistrement ne confirme pas une connexion réussie.`);
        });
      } catch {
        notified = false;
        req.log.error({ event: "vault_notification_failed" }, "Vault saved; conversation notification unavailable");
      }
      return send(reply, 200, vaultStatus(lang, cfg.publicUrl, t.doneTitle, notified ? t.done : t.notificationFailed));
    });
  });
}
