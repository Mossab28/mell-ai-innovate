import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import type { InboundAttachment, InboundMessage } from "@mella/shared";

const run = promisify(execFile);

/**
 * Prépare les pièces jointes d'un message avec les outils du Mac, sans rien installer :
 * `sips` met une photo (HEIC compris) en JPEG de 1600 px, `afconvert` met un mémo vocal en
 * WAV 16 kHz mono, le format que la transcription attend. Le reste part avec son nom seul.
 */

const IMAGE = /^image\//;
const AUDIO = /^audio\//;
const IMAGE_EXT = new Set([".heic", ".heif", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".tiff"]);
const AUDIO_EXT = new Set([".caf", ".m4a", ".mp3", ".aac", ".amr", ".wav", ".opus"]);
/** Au-delà, on n'envoie pas : un vocal de 5 min fait déjà 9,6 Mo en WAV 16 kHz. */
const MAX_BYTES = 12 * 1024 * 1024;

async function waitFor(path: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  // Messages écrit la ligne avant d'avoir fini de télécharger le fichier : on lui laisse un peu de temps.
  while (Date.now() < until) {
    if (existsSync(path) && (await stat(path)).size > 0) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * whisper.cpp sur le Mac (Homebrew) si MELLA_WHISPER_MODEL est donné ; undefined sinon ou en cas d'échec.
 * Avec le modèle de détection de voix (Silero, à côté du modèle Whisper ou MELLA_WHISPER_VAD), seuls les passages
 * parlés sont transcrits : un silence ou un bruit ne donne plus un texte inventé (« The The The The », le 18/10).
 * Rien de parlé : « [inaudible] », pour que Mell le dise au lieu de se taire.
 */
async function transcribeHere(wav: string): Promise<string | undefined> {
  const model = process.env.MELLA_WHISPER_MODEL;
  if (!model) return undefined;
  const vad = process.env.MELLA_WHISPER_VAD ?? join(dirname(model), "ggml-silero-v5.1.2.bin");
  const withVad = await access(vad).then(() => true, () => false);
  try {
    const args = ["-m", model, "-f", wav, "-l", "auto", "-nt", "-np", ...(withVad ? ["--vad", "-vm", vad] : [])];
    const { stdout } = await run(process.env.MELLA_WHISPER_BIN ?? "/opt/homebrew/bin/whisper-cli", args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const text = stdout.replace(/\s+/g, " ").trim();
    if (/[\p{L}\p{N}]/u.test(text)) return text;
    return withVad ? "[inaudible]" : undefined;
  } catch {
    return undefined;
  }
}

export async function prepareAttachments(files: NonNullable<InboundMessage["files"]>, waitMs = 15_000): Promise<InboundAttachment[]> {
  const out: InboundAttachment[] = [];
  const dir = await mkdtemp(join(tmpdir(), "mell-pj-"));
  try {
    for (const [i, f] of files.slice(0, 4).entries()) {
      const path = f.path.replace(/^~(?=\/)/, homedir());
      const ext = extname(path).toLowerCase();
      const kind = f.audio || AUDIO.test(f.mime ?? "") || AUDIO_EXT.has(ext) ? "audio" : IMAGE.test(f.mime ?? "") || IMAGE_EXT.has(ext) ? "image" : "file";
      const name = f.name ?? path.split("/").pop();
      if (kind === "file" || !(await waitFor(path, waitMs))) {
        out.push({ kind: "file", mime: f.mime ?? "application/octet-stream", name });
        continue;
      }
      try {
        const target = join(dir, `${i}.${kind === "image" ? "jpg" : "wav"}`);
        if (kind === "image") await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", "1600", path, "--out", target], { timeout: 30_000 });
        else await run("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", path, target], { timeout: 60_000 });
        // Un vocal se transcrit ici, sur la puce Apple du Mac (quelques secondes) : le serveur ne reçoit que le texte.
        if (kind === "audio") {
          const text = await transcribeHere(target);
          if (text) {
            out.push({ kind, mime: "audio/wav", transcript: text, name });
            continue;
          }
        }
        const data = await readFile(target);
        if (data.length > MAX_BYTES) {
          out.push({ kind: "file", mime: kind === "image" ? "image/jpeg" : "audio/wav", name: `${name} (trop lourd)` });
          continue;
        }
        out.push({ kind, mime: kind === "image" ? "image/jpeg" : "audio/wav", data: data.toString("base64"), name });
      } catch {
        out.push({ kind: "file", mime: f.mime ?? "application/octet-stream", name });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return out;
}
