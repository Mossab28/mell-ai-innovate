import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TAPBACK_EMOJI, type OutboundMessage, type Tapback } from "@mella/shared";

const run = promisify(execFile);

/**
 * Envoi par AppleScript. Le texte et le destinataire passent en arguments (argv), jamais
 * concaténés dans le script : aucun risque d'injection AppleScript.
 *
 * AppleScript ne sait pas poser de vraie réaction (tapback) ni d'effet d'écran : la réaction
 * part en emoji, l'effet est ignoré. Une version avec l'API privée viendra plus tard.
 */
const SCRIPTS = [
  // macOS 14+ : « participant » ; avant : « buddy ». Puis le SMS via l'iPhone relié.
  `on run argv
  tell application "Messages"
    set svc to 1st account whose service type = iMessage
    send (item 2 of argv) to participant (item 1 of argv) of svc
  end tell
end run`,
  `on run argv
  tell application "Messages"
    set svc to 1st service whose service type = iMessage
    send (item 2 of argv) to buddy (item 1 of argv) of svc
  end tell
end run`,
  `on run argv
  tell application "Messages"
    set svc to 1st account whose service type = SMS
    send (item 2 of argv) to participant (item 1 of argv) of svc
  end tell
end run`,
];

export function textFor(m: OutboundMessage): string | undefined {
  if (m.kind === "tapback") return TAPBACK_EMOJI[m.tapback as Tapback] ?? m.tapback;
  return m.text;
}

export async function sendMessage(m: OutboundMessage, dryRun: boolean): Promise<void> {
  const text = textFor(m);
  if (!text) return;
  if (dryRun) {
    console.log(`[envoi simulé] ${m.kind} #${m.id} -> ${m.to} (${text.length} caractères)`);
    return;
  }
  let lastErr: unknown;
  for (const script of SCRIPTS) {
    try {
      await run("osascript", ["-e", script, m.to, text], { timeout: 20_000 });
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  // L'erreur d'execFile recopie la ligne de commande, donc le texte du message : on ne garde
  // que la sortie d'erreur d'osascript, pour que rien du contenu n'arrive dans un journal.
  const stderr = String((lastErr as { stderr?: string })?.stderr ?? "").trim();
  throw new Error(`AppleScript : ${stderr.replace(/\s+/g, " ").slice(0, 200) || "échec"}`);
}
