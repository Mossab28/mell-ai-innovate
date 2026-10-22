import { TAPBACKS } from "@mella/shared";

/**
 * Client minimal de l'API REST de BlueBubbles Server (qui tourne sur le même Mac).
 * Avec son API privée (SIP désactivé), il fait ce qu'AppleScript ne sait pas faire :
 * indicateur de frappe, vraies réactions, accusés de lecture, effets d'écran.
 */

const EFFECTS: Record<string, string> = {
  confetti: "com.apple.messages.effect.CKConfettiEffect",
  loud: "com.apple.MobileSMS.expressivesend.loud",
};

export class BlueBubbles {
  constructor(
    private readonly base: string,
    private readonly password: string,
  ) {}

  private async call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<any> {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${this.base}/api/v1${path}${sep}password=${encodeURIComponent(this.password)}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || (json.status && json.status >= 400)) throw new Error(`BlueBubbles ${method} ${path} : ${res.status} ${json.message ?? ""} ${json.error?.message ?? ""}`.trim());
    return json.data;
  }

  /** Vrai si le serveur répond et que l'API privée est branchée dans Messages. */
  async privateApiReady(): Promise<boolean> {
    try {
      const info = await this.call("GET", "/server/info");
      return !!(info?.private_api && info?.helper_connected);
    } catch {
      return false;
    }
  }

  /**
   * Rend le guid iMessage de la bulle envoyée : c'est lui que la personne cible quand elle réagit. Une personne qui n'a
   * jamais écrit à la ligne n'a pas encore de conversation (« Chat does not exist », accès accordé le 22/10) : le premier
   * message la crée (/chat/new), les suivants passent par elle.
   */
  async sendText(chatGuid: string, text: string, effect?: string, replyTo?: string): Promise<string | undefined> {
    const tempGuid = `mella-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const data = await this.call("POST", "/message/text", {
        chatGuid,
        tempGuid,
        message: text,
        method: "private-api",
        ...(effect && EFFECTS[effect] ? { effectId: EFFECTS[effect] } : {}),
        ...(replyTo ? { selectedMessageGuid: replyTo, partIndex: 0 } : {}),
      });
      return typeof data?.guid === "string" ? data.guid : undefined;
    } catch (e) {
      const address = /chat does not exist/i.test(String(e)) ? chatGuid.match(/^[^;]+;-;(.+)$/)?.[1] : undefined;
      if (!address) throw e;
      const chat = await this.call("POST", "/chat/new", { addresses: [address], message: text, service: "iMessage", method: "private-api", tempGuid });
      const guid = chat?.lastMessage?.guid ?? chat?.messages?.[0]?.guid;
      return typeof guid === "string" ? guid : undefined;
    }
  }

  /** Les six réactions classiques seulement : l'API ne sait pas poser un emoji libre. */
  canReact(kind: string): boolean {
    return (TAPBACKS as readonly string[]).includes(kind);
  }

  react(chatGuid: string, targetGuid: string, kind: string): Promise<unknown> {
    return this.call("POST", "/message/react", { chatGuid, selectedMessageGuid: targetGuid, reaction: kind, partIndex: 0 });
  }

  /** Réécrit une bulle déjà envoyée (macOS 13+) : sert à la bulle d'avancement. */
  edit(messageGuid: string, text: string): Promise<unknown> {
    return this.call("POST", `/message/${encodeURIComponent(messageGuid)}/edit`, { editedMessage: text, backwardsCompatibilityMessage: text, partIndex: 0 });
  }

  typing(chatGuid: string, on: boolean): Promise<unknown> {
    return this.call(on ? "POST" : "DELETE", `/chat/${encodeURIComponent(chatGuid)}/typing`);
  }

  /** Efface un message de la conversation (API privée). Ne touche pas au reste du fil. */
  deleteMessage(chatGuid: string, messageGuid: string): Promise<unknown> {
    return this.call("DELETE", `/chat/${encodeURIComponent(chatGuid)}/${encodeURIComponent(messageGuid)}`);
  }

  markRead(chatGuid: string): Promise<unknown> {
    return this.call("POST", `/chat/${encodeURIComponent(chatGuid)}/read`);
  }

  /** Téléverse un fichier et rend son identifiant (le dossier du chemin rendu), pour un envoi multipart. */
  async uploadAttachment(name: string, bytes: Buffer, contentType: string): Promise<string> {
    const form = new FormData();
    form.set("name", name);
    form.set("attachment", new Blob([new Uint8Array(bytes)], { type: contentType }), name);
    const res = await fetch(`${this.base}/api/v1/attachment/upload?password=${encodeURIComponent(this.password)}`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
    const json = (await res.json().catch(() => ({}))) as any;
    const path = json?.data?.path;
    if (!res.ok || typeof path !== "string" || !path.includes("/")) throw new Error(`upload : ${res.status} ${json?.error?.message ?? ""}`.trim());
    return path.split("/")[0];
  }

  /** Image + légende dans le MÊME message (multipart) : l'image s'affiche, le lien de la légende est cliquable. */
  async sendCard(chatGuid: string, name: string, bytes: Buffer, contentType: string, caption: string): Promise<string | undefined> {
    const uuid = await this.uploadAttachment(name, bytes, contentType);
    const parts: Array<Record<string, unknown>> = [{ partIndex: 0, attachment: uuid, name }];
    if (caption.trim()) parts.push({ partIndex: 1, text: caption });
    const data = await this.call("POST", "/message/multipart", { chatGuid, tempGuid: `mella-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, parts });
    return typeof data?.guid === "string" ? data.guid : undefined;
  }

  /** Envoie un fichier joint (ex. une fiche contact .vcf) : il s'affiche dans Messages, prêt à être ajouté. */
  async sendAttachment(chatGuid: string, name: string, bytes: Buffer, contentType: string): Promise<string | undefined> {
    const form = new FormData();
    form.set("chatGuid", chatGuid);
    form.set("tempGuid", `mella-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    form.set("name", name);
    form.set("method", "private-api");
    form.set("attachment", new Blob([new Uint8Array(bytes)], { type: contentType }), name);
    const res = await fetch(`${this.base}/api/v1/message/attachment?password=${encodeURIComponent(this.password)}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || (json.status && json.status >= 400)) throw new Error(`BlueBubbles attachment : ${res.status} ${json.message ?? ""} ${json.error?.message ?? ""}`.trim());
    return typeof json.data?.guid === "string" ? json.data.guid : undefined;
  }
}
