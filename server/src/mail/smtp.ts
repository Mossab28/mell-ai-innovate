import { SMTPServer } from "smtp-server";
import type { Db } from "../db.ts";
import type { Config } from "../config.ts";
import { userForRecipient } from "./address.ts";
import { ingestMail, type AuthCheck, type Stored } from "./ingest.ts";

/**
 * Réception des mails (port 25), en code maison sur smtp-server (Nodemailer, MIT-0). Un destinataire
 * inconnu est refusé dès l'adresse : pas de mail perdu ni de retour à un faux expéditeur. Le mail n'est
 * accepté qu'une fois rangé en base ; une panne répond « réessaie plus tard » et l'expéditeur réessaie.
 */

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_RCPTS = 20;

const smtpError = (code: number, message: string) => Object.assign(new Error(message), { responseCode: code });

export function startSmtp(
  db: Db,
  cfg: Config,
  o: { onStored?: (s: Stored[]) => void; log?: (msg: string, err?: unknown) => void; auth?: AuthCheck } = {},
): { port: () => number; close: () => Promise<void> } {
  const server = new SMTPServer({
    name: cfg.mail.hostname,
    banner: "Mell",
    authOptional: true,
    disabledCommands: ["AUTH"],
    size: MAX_BYTES,
    maxClients: 100,
    logger: false,
    socketTimeout: 60_000,
    onRcptTo(address, session, cb) {
      if (session.envelope.rcptTo.length >= MAX_RCPTS) return cb(smtpError(452, "4.5.3 Trop de destinataires"));
      userForRecipient(db, cfg, address.address)
        .then((u) => cb(u ? undefined : smtpError(550, "5.1.1 Adresse inconnue")))
        .catch(() => cb(smtpError(451, "4.3.0 Réessaie plus tard")));
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= MAX_BYTES) chunks.push(c);
      });
      stream.on("end", () => {
        if ((stream as any).sizeExceeded) return cb(smtpError(552, "5.3.4 Mail trop gros"));
        const env = {
          ip: session.remoteAddress,
          helo: session.hostNameAppearsAs,
          mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : undefined,
          rcpts: session.envelope.rcptTo.map((r) => r.address),
        };
        ingestMail(db, cfg, Buffer.concat(chunks), env, o.auth)
          .then((stored) => {
            cb();
            if (stored.length) o.onStored?.(stored);
          })
          .catch((e) => {
            o.log?.("mail entrant non rangé", e);
            cb(smtpError(451, "4.3.0 Réessaie plus tard"));
          });
      });
    },
  });
  server.on("error", (e) => o.log?.("serveur mail", e));
  server.listen(cfg.mail.port, "0.0.0.0");
  return {
    port: () => ((server as any).server?.address?.() as { port: number } | null)?.port ?? cfg.mail.port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
