import type { Db } from "../db.ts";
import type { Config } from "../config.ts";
import { enqueue, requestDeletion } from "../outbox.ts";
import type { User } from "../users.ts";
import { SECRET_MARK, screenSecret, type Caught } from "./detect.ts";
import { issueLink } from "./links.ts";
import type { VaultService } from "./service.ts";

type Q = Pick<Db, "query">;

/** Slot d'attente quand le site n'est pas dit : « C'est pour quel site ? », puis vault_assign_pending. */
export const PENDING_SITE = "_pending";

export interface InboundScreen {
  /** Texte à enregistrer dans `messages` : le secret n'y figure plus. */
  text: string | undefined;
  /** true : le message ne contenait que le secret, Mell répond seule, pas de tour d'agent. */
  handled: boolean;
  caught?: Caught;
}

/** À appeler sur chaque message entrant AVANT de l'enregistrer. Pur, sans effet. */
export function screenInbound(text: string | undefined): InboundScreen {
  const s = screenSecret(text);
  if (!s.caught) return { text, handled: false };
  return { text: s.text, handled: !s.hasRequest, caught: s.caught };
}

/**
 * Après l'enregistrement du message expurgé : range le secret au coffre, remplace le repère par
 * la référence, et répond sans modèle. Le secret n'est jamais répété, même en cas d'échec.
 */
export async function stashCaughtSecret(
  q: Q,
  vault: VaultService,
  cfg: Pick<Config, "publicUrl">,
  user: User,
  p: { messageId: number; guid: string; caught: Caught },
): Promise<void> {
  const fr = user.lang !== "en";
  const ctx = { actor: "thread" as const, detail: "tapé dans le fil" };
  const c = p.caught;
  const bubbles: string[] = [];
  let mark: string;

  if (c.kind === "card") {
    // Une carte tapée dans le fil n'y reste pas : retirée de nos messages, et le lien sécurisé prend le relais.
    mark = fr ? "[numéro de carte retiré du fil]" : "[card number removed from the thread]";
    const link = await issueLink(q, cfg.publicUrl, { userId: user.id, kind: "card" });
    bubbles.push(
      fr
        ? "Pas de carte dans le fil, je l'ai retirée de mon côté. Supprime aussi ton message : appui long dessus, « Plus… », puis la corbeille."
        : "No cards in the thread, I've removed it on my side. Please delete your message too: long-press it, tap More, then the trash can.",
      fr ? `Range-la plutôt ici, c'est chiffré et ça ne sert qu'une fois : ${link.url}` : `Add it here instead, it's encrypted and works only once: ${link.url}`,
    );
  } else {
    const site = c.site ?? PENDING_SITE;
    try {
      let ref: string;
      // Une graine 2FA ne se relit jamais : sans site, impossible de la reclasser plus tard. Lien sécurisé.
      if (c.kind === "totp" && !c.site) throw new Error("site inconnu pour une clé 2FA");
      if (c.kind === "totp") {
        ref = await vault.putTotpSeed(q, user.id, site, c.secret, ctx);
      } else {
        // Un mot de passe seul met à jour l'entrée existante sans perdre l'identifiant.
        const prev = await vault.backend.getLoginForInjection(user.id, site).catch(() => undefined);
        ref = await vault.putLogin(q, user.id, site, { username: c.username ?? prev?.username ?? "", password: c.secret }, ctx);
      }
      mark = fr ? `[${c.kind === "totp" ? "clé 2FA" : "mot de passe"} rangé au coffre : ${ref}]` : `[${c.kind === "totp" ? "2FA key" : "password"} stored in vault: ${ref}]`;
      const what = c.site ? (fr ? ` pour ${c.site}` : ` for ${c.site}`) : "";
      bubbles.push(fr ? `Rangé au coffre 🔒${what}. Je ne le répéterai jamais.` : `Stored in your vault 🔒${what}. I'll never repeat it.`);
      bubbles.push(
        fr
          ? "Supprime ton message pour qu'il ne traîne pas : appui long dessus, « Plus… », puis la corbeille."
          : "Delete your message so it doesn't linger: long-press it, tap More, then the trash can.",
      );
      if (!c.site) bubbles.push(fr ? "C'est pour quel site ?" : "Which site is it for?");
    } catch {
      // Coffre injoignable, ou clé 2FA sans site : on ne garde rien et on propose le lien sécurisé.
      mark = fr ? "[secret retiré du fil, non conservé]" : "[secret removed, not kept]";
      const link = await issueLink(q, cfg.publicUrl, { userId: user.id, kind: c.kind === "totp" ? "totp" : "login", site: c.site });
      const why = c.kind === "totp" && !c.site ? (fr ? "Il me manque le site" : "I need the site") : fr ? "Je n'ai pas pu le ranger" : "I couldn't store it";
      bubbles.push(
        fr ? `${why}, je ne l'ai pas gardé. Renvoie-le ici, c'est chiffré : ${link.url}` : `${why} and didn't keep it. Send it here instead, it's encrypted: ${link.url}`,
        fr ? "Et supprime ton message : appui long dessus, « Plus… », puis la corbeille." : "And delete your message: long-press it, tap More, then the trash can.",
      );
    }
  }

  await q.query(`UPDATE messages SET text = replace(text, $2, $3) WHERE id = $1`, [p.messageId, SECRET_MARK, mark]);
  // Le message d'origine ne doit pas rester non plus dans Messages, sur le Mac de la ligne.
  await requestDeletion(q, user.id, p.guid);
  await enqueue(
    q,
    bubbles.map((text, i) => ({ userId: user.id, kind: "text" as const, text, dedupeKey: `vault-caught:${p.guid}:${i}` })),
  );
}
