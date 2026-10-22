import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db.ts";
import { pickLine } from "../lines.ts";
import { appInfo } from "./catalog.ts";
import type { AppsService } from "./service.ts";
import { INK, esc, lockSvg, logoSvg, page, siteLang } from "../web/da.ts";

/**
 * Connexion d'une app à notre nom. La personne touche askmell.com/connect/<jeton> dans le fil (jamais
 * l'écran Composio en clair), donne ses droits chez le fournisseur, et Composio la ramène sur
 * askmell.com/connected/<jeton> : « C'est connecté », un bouton, retour dans Messages.
 */
export async function registerConnectRoutes(http: FastifyInstance, deps: { db: Db; apps?: AppsService }): Promise<void> {
  const html = (reply: FastifyReply, code: number, body: string) =>
    reply.code(code).headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" }).send(body);
  // La langue du site, comme toutes les autres pages (siteLang).
  const lang = (req: { headers: Record<string, unknown>; query?: unknown }): "fr" | "en" => siteLang(req);

  http.get("/connect/:token", async (req, reply) => {
    const en = lang(req) === "en";
    const p = deps.apps ? await deps.apps.pendingByToken(deps.db, String((req.params as { token: string }).token ?? "")) : undefined;
    if (!p || p.expired) {
      return html(reply, 404, page({ lang: en ? "en" : "fr", title: "Mell", body: `<a class="corner l" href="/" aria-label="Mell">${logoSvg(INK, 30).replace("<svg ", '<svg class="m" ')}</a><div class="doc form"><div class="lock">${lockSvg(30, INK)}</div><h1>${esc(en ? "Link expired" : "Lien expiré")}</h1><p>${esc(en ? "Ask Mell for a new one in the thread." : "Redemande-le à Mell dans le fil.")}</p></div>` }));
    }
    // Un temps, pas plus : la promesse, et on passe chez le fournisseur (tout seul, ou au toucher).
    const name = appInfo(p.service).name;
    const title = en ? `Connect ${name} to Mell` : `Connecte ${name} à Mell`;
    const text = en
      ? `Secured by Composio. You sign in on ${name}'s own page; Mell never sees your password, and you can revoke it anytime.`
      : `Sécurisé par Composio. Tu te connectes sur la page de ${name} ; Mell ne voit jamais ton mot de passe, et tu peux retirer l'accès quand tu veux.`;
    return reply
      .code(200)
      .headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", refresh: `1; url=${p.url}` })
      .send(
        page({
          lang: en ? "en" : "fr",
          title,
          lock: true,
          body: `<a class="corner l" href="/" aria-label="Mell">${logoSvg(INK, 30).replace("<svg ", '<svg class="m" ')}</a><div class="doc form"><div class="lock">${lockSvg(30, INK)}</div><h1>${esc(title)}</h1><p class="safe">${esc(text)}</p><a class="action" href="${esc(p.url)}">${esc(en ? "Continue" : "Continuer")}</a><p class="assurance">${esc(en ? "Taking you there…" : "On y va…")}</p></div><script>setTimeout(function(){location.replace(${JSON.stringify(p.url)})},900)</script>`,
        }),
      );
  });

  http.get("/connected/:token", async (req, reply) => {
    const en = lang(req) === "en";
    const p = deps.apps ? await deps.apps.pendingByToken(deps.db, String((req.params as { token: string }).token ?? "")) : undefined;
    const name = p ? appInfo(p.service).name : undefined;
    // Retour vers SA ligne (celle qui lui écrit), pas la première venue.
    const own = p ? (await deps.db.query<{ handle: string }>(`SELECT l.handle FROM users u JOIN lines l ON l.id = u.line_id WHERE u.id = $1`, [p.userId])).rows[0] : undefined;
    const line = own ?? (await pickLine(deps.db));
    const sms = line ? `sms:${line.handle}` : undefined;
    const title = name ? (en ? `Connected to your ${name}` : `Connecté à ton ${name}`) : en ? "Connected" : "C'est connecté";
    const text = en ? "Secured by Composio. Mell can use it now; go back to the thread, Mell will confirm." : "Sécurisé par Composio. Mell peut s'en servir ; retourne dans le fil, Mell te le confirme.";
    return html(
      reply,
      200,
      page({
        lang: en ? "en" : "fr",
        title,
        lock: true,
        body: `<a class="corner l" href="/" aria-label="Mell">${logoSvg(INK, 30).replace("<svg ", '<svg class="m" ')}</a><div class="doc form"><div class="lock">${lockSvg(30, INK)}</div><h1>${esc(title)}</h1><p class="safe">${esc(text)}</p>${sms ? `<a class="action" href="${esc(sms)}">${esc(en ? "Back to Mell" : "Retour vers Mell")}</a>` : ""}<p class="assurance">${esc(en ? "Access you can revoke anytime." : "Accès révocable à tout moment.")}</p></div>`,
      }),
    );
  });
}
