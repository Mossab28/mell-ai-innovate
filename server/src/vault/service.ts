import type { Db } from "../db.ts";
import { parseRef } from "./refs.ts";
import type { CardSecret, ConnectionSecret, LoginSecret, Vault, VaultKind, VaultRef } from "./types.ts";

type Q = Pick<Db, "query">;

export type Actor = "user_link" | "thread" | "agent" | "system";
export interface AccessCtx {
  actor: Actor;
  taskId?: string;
  detail?: string;
}

export interface VaultEntry {
  ref: VaultRef;
  kind: VaultKind;
  name: string;
  updated_at: Date;
}

/**
 * Le coffre tel que le reste de Mell le voit : la brique (OpenBao ou mémoire) plus, dans
 * Postgres, un index sans secret et un journal d'accès. Toute écriture, injection ou
 * suppression passe par ici et laisse une ligne de journal.
 */
export class VaultService {
  constructor(readonly backend: Vault) {}

  async putLogin(q: Q, userId: string, site: string, login: LoginSecret, ctx: AccessCtx): Promise<VaultRef> {
    const ref = await this.backend.putLogin(userId, site, login);
    await this.index(q, userId, ref, ctx);
    return ref;
  }

  async putTotpSeed(q: Q, userId: string, site: string, seed: string, ctx: AccessCtx): Promise<VaultRef> {
    const ref = await this.backend.putTotpSeed(userId, site, seed);
    await this.index(q, userId, ref, ctx);
    return ref;
  }

  async putPersonal(q: Q, userId: string, field: string, value: string, ctx: AccessCtx): Promise<VaultRef> {
    const ref = await this.backend.putPersonal(userId, field, value);
    await this.index(q, userId, ref, ctx);
    return ref;
  }

  async putCard(q: Q, userId: string, card: CardSecret, ctx: AccessCtx): Promise<VaultRef> {
    const ref = await this.backend.putCard(userId, card);
    await this.index(q, userId, ref, ctx);
    return ref;
  }

  /** Ce que la personne a au coffre. Aucune valeur, jamais. */
  async list(q: Q, userId: string): Promise<VaultEntry[]> {
    return (
      await q.query<VaultEntry>(`SELECT ref, kind, name, updated_at FROM vault_entries WHERE user_id = $1 ORDER BY kind, name`, [userId])
    ).rows;
  }

  async has(q: Q, userId: string, ref: string): Promise<boolean> {
    return (await q.query(`SELECT 1 FROM vault_entries WHERE user_id = $1 AND ref = $2`, [userId, ref])).rows.length > 0;
  }

  /**
   * Seule porte de sortie d'une valeur, et seulement vers l'injecteur (inject.ts).
   * Ne jamais rendre ce résultat au modèle.
   */
  async reveal(
    q: Q,
    userId: string,
    ref: VaultRef,
    ctx: AccessCtx,
  ): Promise<{ login?: LoginSecret; code?: string; value?: string; card?: CardSecret } | undefined> {
    const { kind, name } = parseRef(ref);
    const out =
      kind === "login"
        ? { login: await this.backend.getLoginForInjection(userId, name) }
        : kind === "totp"
          ? { code: await this.backend.totpCode(userId, name) }
          : kind === "card"
            ? { card: await this.backend.getCardForInjection(userId, name) }
            : { value: await this.backend.getPersonalForInjection(userId, name) };
    const found = !!(out.login ?? out.code ?? out.value ?? out.card);
    await this.log(q, userId, ref, found ? "inject" : "refused", { ...ctx, detail: found ? ctx.detail : "entrée absente" });
    return found ? out : undefined;
  }

  async deleteEntry(q: Q, userId: string, ref: VaultRef, ctx: AccessCtx): Promise<boolean> {
    const existed = await this.backend.deleteEntry(userId, ref);
    await q.query(`DELETE FROM vault_entries WHERE user_id = $1 AND ref = $2`, [userId, ref]);
    await this.log(q, userId, ref, "delete", ctx);
    return existed;
  }

  /**
   * Secret d'une connexion (jeton de rafraîchissement Google). Pas d'entrée dans vault_entries :
   * le modèle n'en voit même pas la référence. Journalisé sous `oauth://<fournisseur>`.
   */
  async putConnection(q: Q, userId: string, provider: string, secret: ConnectionSecret, ctx: AccessCtx): Promise<void> {
    await this.backend.putConnection(userId, provider, secret);
    await this.log(q, userId, `oauth://${provider}`, "put", ctx);
  }

  async deleteConnection(q: Q, userId: string, provider: string, ctx: AccessCtx): Promise<boolean> {
    const existed = await this.backend.deleteConnection(userId, provider);
    await this.log(q, userId, `oauth://${provider}`, "delete", ctx);
    return existed;
  }

  /** « Déconnecter = supprimer » : la brique d'abord (clé détruite), puis l'index et les liens. */
  async deleteUser(q: Q, userId: string, ctx: AccessCtx): Promise<void> {
    await this.backend.deleteUser(userId);
    await q.query(`DELETE FROM vault_entries WHERE user_id = $1`, [userId]);
    await q.query(`DELETE FROM vault_links WHERE user_id = $1`, [userId]);
    await this.log(q, userId, null, "delete_all", ctx);
  }

  async log(q: Q, userId: string, ref: string | null, action: string, ctx: AccessCtx): Promise<void> {
    await q.query(`INSERT INTO vault_access_log (user_id, ref, action, actor, task_id, detail) VALUES ($1, $2, $3, $4, $5, $6)`, [
      userId,
      ref,
      action,
      ctx.actor,
      ctx.taskId ?? null,
      ctx.detail?.slice(0, 300) ?? null,
    ]);
  }

  private async index(q: Q, userId: string, ref: VaultRef, ctx: AccessCtx): Promise<void> {
    const { kind, name } = parseRef(ref);
    await q.query(
      `INSERT INTO vault_entries (user_id, ref, kind, name) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, ref) DO UPDATE SET updated_at = now()`,
      [userId, ref, kind, name],
    );
    await this.log(q, userId, ref, "put", ctx);
  }
}
