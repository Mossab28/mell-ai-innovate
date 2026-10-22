import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Db } from "./db.ts";
import type { Config } from "./config.ts";
import type { Llm } from "./llm.ts";
import type { User } from "./users.ts";

const run = promisify(execFile);
type Q = Pick<Db, "query">;

/**
 * Ce que la personne envoie en image ou en vocal devient du texte, avant tout le reste : le
 * vocal est transcrit sur notre machine (whisper.cpp, libre, rien ne sort), la photo est décrite
 * par le petit modèle avec son texte recopié. Ensuite le routeur, l'historique et les travaux
 * de fond ne voient que du texte, et le fichier est effacé.
 */

const DESCRIBE = `Tu prépares, pour un assistant personnel, ce que montre une image envoyée par la personne qu'il aide. En français, 1200 caractères au plus, sans introduction :
- Recopie mot pour mot le texte qui compte : expéditeur, objet et corps d'un mail, dates, heures, montants, adresses, références, numéros de commande ou de vol, noms.
- Sinon décris ce qu'on voit en une ou deux phrases utiles (un plat, un produit et sa marque, un lieu, un document).
- Rien d'autre : pas d'avis, pas de conseil.`;

interface Row {
  id: number;
  message_id: number;
  kind: "image" | "audio" | "file";
  mime: string;
  name: string | null;
  data: Uint8Array | null;
  transcript: string | null;
}

/** Transcription d'un WAV 16 kHz par whisper-cli. Rend undefined si l'outil n'est pas installé ou échoue. */
export async function transcribe(cfg: Pick<Config, "whisper">, wav: Uint8Array): Promise<string | undefined> {
  if (!cfg.whisper.model) return undefined;
  const dir = await mkdtemp(join(tmpdir(), "mell-vocal-"));
  try {
    const file = join(dir, "v.wav");
    await writeFile(file, wav);
    // Repli seulement (le Mac de la ligne transcrit d'habitude) : borné, pour ne jamais bloquer le tour plus d'une minute.
    const { stdout } = await run(cfg.whisper.bin, ["-m", cfg.whisper.model, "-f", file, "-l", "auto", "-nt", "-np"], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const text = stdout.replace(/\s+/g, " ").trim();
    return text || undefined;
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function describeImage(cfg: Pick<Config, "models">, llm: Llm, jpeg: Uint8Array): Promise<string | undefined> {
  try {
    const r = await llm.chat({
      model: cfg.models.quick,
      purpose: "vision",
      maxTokens: 700,
      messages: [
        { role: "system", content: DESCRIBE },
        { role: "user", content: "Voici l'image.", images: [{ format: "jpeg", bytes: jpeg }] },
      ],
      signal: AbortSignal.timeout(60_000),
    });
    return r.text?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Transforme les pièces jointes des messages en attente en texte ajouté au message, puis les efface.
 * Rend, par message, le nouveau texte (pour mettre à jour le tour en cours).
 */
export async function readAttachments(db: Q, cfg: Pick<Config, "whisper" | "models">, llm: Llm, user: User, messageIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!messageIds.length) return out;
  const rows = (
    await db.query<Row>(`SELECT id::int, message_id::int, kind, mime, name, data, transcript FROM attachments WHERE message_id = ANY($1::bigint[]) ORDER BY id`, [messageIds])
  ).rows;
  if (!rows.length) return out;
  const fr = user.lang !== "en";
  const added = new Map<number, string[]>();
  await Promise.all(
    rows.map(async (a) => {
      let line: string;
      if (a.kind === "audio" && a.transcript) {
        line = `[vocal] ${a.transcript}`;
      } else if (a.kind === "audio" && a.data) {
        const t = await transcribe(cfg, a.data);
        line = t ? `[vocal] ${t}` : fr ? "[vocal que je n'ai pas pu écouter]" : "[voice note I couldn't play]";
      } else if (a.kind === "image" && a.data) {
        const d = await describeImage(cfg, llm, a.data);
        line = d ? `[photo] ${d}` : fr ? "[photo que je n'ai pas pu lire]" : "[photo I couldn't read]";
      } else {
        line = `[fichier ${a.name ?? ""} : pas encore lisible]`;
      }
      added.set(a.message_id, [...(added.get(a.message_id) ?? []), line]);
    }),
  );
  for (const [id, lines] of added) {
    const prev = (await db.query<{ text: string | null }>(`SELECT text FROM messages WHERE id = $1`, [id])).rows[0]?.text;
    const text = [prev?.trim(), ...lines].filter(Boolean).join("\n");
    await db.query(`UPDATE messages SET text = $2 WHERE id = $1`, [id, text]);
    out.set(id, text);
  }
  await db.query(`DELETE FROM attachments WHERE message_id = ANY($1::bigint[])`, [messageIds]);
  return out;
}
