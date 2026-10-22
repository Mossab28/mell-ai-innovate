import type { Db } from "./db.ts";
import { getLine } from "./lines.ts";
import { enqueue, outboxEvents } from "./outbox.ts";
import { getUser, welcomeItems } from "./users.ts";

/** Mell écrit en premier à une personne admise : « tu es dedans », sa fiche contact, puis une question. */
export async function sendWelcome(db: Db, userId: string): Promise<void> {
  const u = await getUser(db, userId);
  const line = await getLine(db, u.line_id);
  await enqueue(db, welcomeItems(userId, u.lang, line?.handle));
  outboxEvents.emit(u.line_id);
}
