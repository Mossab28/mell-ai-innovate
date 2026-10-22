import { DatabaseSync } from "node:sqlite";
import type { InboundMessage } from "@mella/shared";
import { decodeAttributedBody } from "./attributed.ts";

/** Lecture seule de la base de Messages (~/Library/Messages/chat.db). Jamais d'écriture. */

const APPLE_EPOCH_S = 978_307_200; // 2001-01-01 en secondes Unix
const TAPBACK_KINDS = ["love", "like", "dislike", "laugh", "emphasize", "question"];

interface Row {
  rowid: number;
  guid: string;
  text: string | null;
  attributedBody: Uint8Array | null;
  is_from_me: number;
  date: number;
  service: string | null;
  handle: string | null;
  associated_message_type: number | null;
  associated_message_guid: string | null;
  associated_message_emoji?: string | null;
  cache_roomnames: string | null;
  item_type: number | null;
  chat_guid: string | null;
  is_audio_message?: number | null;
}

export class ChatDb {
  private readonly db: DatabaseSync;
  private readonly hasEmoji: boolean;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { readOnly: true });
    const cols = this.db.prepare(`PRAGMA table_info(message)`).all() as Array<{ name: string }>;
    this.hasEmoji = cols.some((c) => c.name === "associated_message_emoji");
  }

  maxRowId(): number {
    return Number((this.db.prepare(`SELECT max(ROWID) AS m FROM message`).get() as { m: number | null }).m ?? 0);
  }

  /**
   * Messages après `afterRowId`, tous sens confondus (pour avancer le curseur),
   * avec ceux à transmettre : reçus, en conversation à deux, hors événements système.
   */
  readAfter(afterRowId: number, limit = 200): { lastRowId: number; messages: InboundMessage[] } {
    const rows = this.db
      .prepare(
        // date est en nanosecondes : trop grand pour un nombre JS, on la ramène en secondes côté SQLite.
        `SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.is_from_me,
                CASE WHEN m.date > 1000000000000 THEN m.date / 1000000000.0 ELSE m.date END AS date, m.service,
                h.id AS handle, m.associated_message_type, m.associated_message_guid,
                ${this.hasEmoji ? "m.associated_message_emoji" : "NULL AS associated_message_emoji"},
                m.cache_roomnames, m.item_type, m.is_audio_message,
                (SELECT c.guid FROM chat_message_join cmj JOIN chat c ON c.ROWID = cmj.chat_id
                  WHERE cmj.message_id = m.ROWID LIMIT 1) AS chat_guid
         FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
         WHERE m.ROWID > ? ORDER BY m.ROWID LIMIT ?`,
      )
      .all(afterRowId, limit) as unknown as Row[];
    let lastRowId = afterRowId;
    const messages: InboundMessage[] = [];
    for (const r of rows) {
      lastRowId = Math.max(lastRowId, Number(r.rowid));
      if (r.is_from_me || !r.handle || r.cache_roomnames || (r.item_type ?? 0) !== 0) continue;
      const msg = toInbound(r, this.files(Number(r.rowid), !!r.is_audio_message));
      if (msg) messages.push(msg);
    }
    return { lastRowId, messages };
  }

  /** Pièces jointes d'un message : chemin sur le disque (avec ~), type, nom d'origine. */
  private files(rowid: number, audio: boolean): NonNullable<InboundMessage["files"]> {
    const rows = this.db
      .prepare(
        `SELECT a.filename, a.mime_type, a.transfer_name FROM message_attachment_join j
         JOIN attachment a ON a.ROWID = j.attachment_id WHERE j.message_id = ? LIMIT 6`,
      )
      .all(rowid) as Array<{ filename: string | null; mime_type: string | null; transfer_name: string | null }>;
    return rows
      .filter((r) => r.filename)
      .map((r) => ({ path: r.filename!, mime: r.mime_type ?? undefined, name: r.transfer_name ?? undefined, audio: audio || undefined }));
  }

  close(): void {
    this.db.close();
  }
}

export function appleDateToIso(date: number): string {
  // Nanosecondes depuis High Sierra, secondes avant.
  const seconds = date > 1e12 ? date / 1e9 : date;
  return new Date((seconds + APPLE_EPOCH_S) * 1000).toISOString();
}

function toInbound(r: Row, files: NonNullable<InboundMessage["files"]> = []): InboundMessage | undefined {
  const base = {
    guid: r.guid,
    from: r.handle!,
    sentAt: appleDateToIso(Number(r.date)),
    service: r.service === "SMS" ? ("SMS" as const) : ("iMessage" as const),
    chatGuid: r.chat_guid ?? undefined,
  };
  const t = r.associated_message_type ?? 0;
  if (t >= 2000 && t <= 3006) {
    const removed = t >= 3000;
    const idx = t % 1000;
    const kind = idx === 6 ? (r.associated_message_emoji ?? "emoji") : (TAPBACK_KINDS[idx] ?? "unknown");
    // associated_message_guid ressemble à « p:0/GUID » ou « bp:GUID ».
    const targetGuid = r.associated_message_guid?.replace(/^(p:\d+\/|bp:)/, "") ?? undefined;
    return { ...base, tapback: { kind, targetGuid, removed } };
  }
  const text = (r.text ?? decodeAttributedBody(r.attributedBody))?.replace(/\uFFFC/g, "").trim();
  if (!text && !files.length) return undefined;
  return { ...base, ...(text ? { text } : {}), ...(files.length ? { files } : {}) };
}
