import { execFile } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * « Mell t'appelle » : point de rendez-vous de l'extension MellCall, chargée dans FaceTime
 * (infra/aws-mac/call). Elle s'y connecte et passe les appels FaceTime audio qu'on lui demande ;
 * la voix est dite par `say` dans le micro virtuel BlackHole 2ch, l'entrée par défaut du Mac.
 * Sur 127.0.0.1 seulement. Sans extension reliée, ready() est faux et l'appel échoue proprement.
 */

export interface CallOutcome {
  answered: boolean;
  /** Secondes avant que la personne décroche. */
  pickupSeconds?: number;
}

const RING_MS = 35_000;
const MAX_CALL_MS = 40_000;
const DEVICE = process.env.MELLA_CALL_DEVICE ?? "BlackHole 2ch";

/** Le texte du rappel est dans sa langue : la voix suit (Thomas en français, Samantha en anglais). */
export function spoken(text: string): { voice: string; words: string } {
  const fr = /[éèêàùçôî]|\b(le|la|les|ton|ta|tes|tu|de|des|est|dans|pour|avec|rappel|demain|heure)\b/i.test(text);
  return fr
    ? { voice: process.env.MELLA_CALL_VOICE_FR ?? "Thomas", words: `Salut, c'est Mell. ${text}` }
    : { voice: process.env.MELLA_CALL_VOICE_EN ?? "Samantha", words: `Hi, it's Mell. ${text}` };
}

export class FaceTimeCalls {
  private socket?: Socket;
  private seq = 0;
  private buf = "";
  private busy = false;
  private readonly waiting = new Map<number, (r: any) => void>();

  constructor(port = 12347, private readonly log: (...a: unknown[]) => void = () => {}) {
    createServer((s) => {
      this.socket?.destroy();
      this.socket = s;
      log("[appels] extension de FaceTime reliée");
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
      .on("error", (e) => log("[appels] port indisponible :", e.message))
      .listen(port, "127.0.0.1");
  }

  ready(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  private ask(op: object, timeoutMs = 15_000): Promise<any> {
    const s = this.socket;
    if (!s) return Promise.reject(new Error("FaceTime non relié"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("pas de réponse de FaceTime en 15 s"));
      }, timeoutMs);
      this.waiting.set(id, (r) => {
        clearTimeout(timer);
        if (r.ok) resolve(r);
        else reject(new Error(r.error ?? "refusé par FaceTime"));
      });
      s.write(`${JSON.stringify({ id, ...op })}\n`);
    });
  }

  /**
   * Appelle `to`, attend qu'il décroche (35 s au plus), dit `text` deux fois, raccroche.
   * Rend answered=false s'il n'a pas décroché : l'appel a bien eu lieu, ce n'est pas un échec à refaire.
   */
  async call(to: string, text: string): Promise<CallOutcome> {
    if (!this.ready()) throw new Error("appels non installés sur ce Mac (infra/aws-mac/call/install.sh)");
    if (this.busy) throw new Error("un appel est déjà en cours");
    this.busy = true;
    const t0 = Date.now();
    try {
      await this.ask({ op: "dial", handle: to });
      let answered = false;
      while (Date.now() - t0 < RING_MS) {
        await sleep(1000);
        const st = await this.ask({ op: "status" }).catch(() => ({ calls: [] }));
        const calls: Array<{ connected: boolean; status: number }> = st.calls ?? [];
        if (calls.some((c) => c.connected)) {
          answered = true;
          break;
        }
        // Plus aucun appel en cours : refusé ou raccroché avant de décrocher.
        if (!calls.length && Date.now() - t0 > 4000) break;
      }
      if (!answered) return { answered: false };
      const pickupSeconds = Math.round((Date.now() - t0) / 1000);
      // Une seconde pour que l'audio s'établisse, puis le message, deux fois.
      await sleep(1200);
      const left = () => Math.max(1000, MAX_CALL_MS - (Date.now() - t0));
      const { voice, words } = spoken(text);
      for (let i = 0; i < 2; i++) {
        await run("say", ["-v", voice, "-a", DEVICE, i === 0 ? words : text], { timeout: left() }).catch(() => {});
        if (i === 0) await sleep(900);
      }
      return { answered: true, pickupSeconds };
    } finally {
      await this.ask({ op: "hangup" }).catch(() => {});
      this.busy = false;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
