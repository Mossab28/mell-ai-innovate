import { createServer, type Socket } from "node:net";

/**
 * Point de rendez-vous de l'extension MellTapback (chargée dans Messages, infra/aws-mac/tapback) :
 * elle s'y connecte et attend nos demandes : réactions emoji (👀, 🫡, 🙏) et cartes de lien cliquables,
 * que BlueBubbles ne sait pas faire. Sur 127.0.0.1 seulement. Sans extension connectée, ready() est faux et on se replie.
 */
export class EmojiTapbacks {
  private socket?: Socket;
  private seq = 0;
  private buf = "";
  private readonly waiting = new Map<number, (r: { ok: boolean; guid?: string; error?: string; note?: string }) => void>();
  private readonly log: (...a: unknown[]) => void;

  constructor(port = 12346, log: (...a: unknown[]) => void = () => {}) {
    this.log = log;
    createServer((s) => {
      this.socket?.destroy();
      this.socket = s;
      log("[réactions emoji] extension de Messages reliée");
      s.setEncoding("utf8");
      s.on("data", (chunk: string) => {
        this.buf += chunk;
        let i: number;
        while ((i = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          try {
            const r = JSON.parse(line);
            this.waiting.get(r.id)?.(r);
            this.waiting.delete(r.id);
          } catch {}
        }
      });
      s.on("close", () => {
        if (this.socket === s) this.socket = undefined;
      });
      s.on("error", () => {});
    })
      .on("error", (e) => log("[réactions emoji] port indisponible :", e.message))
      .listen(port, "127.0.0.1");
  }

  ready(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  /** Pose (ou retire) une réaction emoji sur un message. Rend le guid de la réaction. */
  react(chatGuid: string, messageGuid: string, emoji: string, remove = false): Promise<string | undefined> {
    return this.ask({ chatGuid, messageGuid, emoji, remove });
  }

  /**
   * Carte de lien cliquable : vrai lien iMessage avec son aperçu tout fait (titre + photo fournis par nous, Apple ne
   * télécharge rien). La photo doit déjà être sous ~/Library/Messages/Attachments (le relais l'y pose). Rend le guid.
   */
  linkCard(chatGuid: string, url: string, title: string, image?: { path: string; mime: string }): Promise<string | undefined> {
    return this.ask({ op: "link", chatGuid, url, title: title.slice(0, 200), ...(image ? { image: image.path, mime: image.mime } : {}) }, 20_000);
  }

  private ask(req: Record<string, unknown>, timeoutMs = 15_000): Promise<string | undefined> {
    const s = this.socket;
    if (!s) return Promise.reject(new Error("extension de Messages non reliée"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`pas de réponse de l'extension en ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.waiting.set(id, (r) => {
        clearTimeout(timer);
        if (r.note) this.log("[extension]", r.note); // ex. carte partie sans photo, et pourquoi
        if (r.ok) resolve(r.guid || undefined);
        else reject(new Error(r.error ?? "demande refusée"));
      });
      s.write(`${JSON.stringify({ id, ...req })}\n`);
    });
  }
}
