import { TAPBACKS } from "@mella/shared";

/**
 * Mise en forme façon Instinct : peu de bulles, denses, et parfois une simple réaction
 * plutôt qu'une réponse. Les gardes ci-dessous rattrapent ce que le modèle laisse passer.
 */
export interface Rendered {
  bubbles: string[];
  /** Réaction à poser sur le dernier message de l'utilisateur. */
  react?: string;
  /** Effet d'écran sur la première bulle : confettis pour une bonne nouvelle, « fort » pour une alerte. */
  effect?: "confetti" | "loud";
}

/** Instinct tient 29 tours sur 39 en une bulle et n'en envoie jamais plus de quatre (infra/voice/instinct-lines.md). */
const MAX_BUBBLES = 3;
const REACT = /^\s*\[react:([a-z]+|[^\]\s]{1,8})\]\s*$/imu;
const REACT_INLINE = /\[react:([a-z]+|[^\]\s]{1,8})\]\s*/iu;
/** Un emoji seul (👀, 🫡, 🙏) : posé en vraie réaction par l'extension de Messages. */
const EMOJI = /^\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*$/u;
const EFFECT = /\[effet:(confetti|fort)\]\s*/i;

/** Une réaction posable : un nom de Tapback (love, like...) ou un emoji seul (👀, ✅, 🫡). */
export function isReaction(value: string): boolean {
  return (TAPBACKS as readonly string[]).includes(value) || EMOJI.test(value);
}
/** « Rien à répondre » : le modèle choisit de se taire (une réaction qui n'appelle rien). */
const SILENCE = /^\s*\[rien\]\s*$/i;
/** Bulle qui finit par un lien : le texte, puis l'adresse (sans la ponctuation collée derrière). */
const ENDS_WITH_URL = /^([\s\S]*?\S)\s+(https?:\/\/\S+?)[.,;!?)]*$/;

/** Phrases de remplissage qu'Instinct n'écrit jamais : retirées quand il reste autre chose à dire. */
const FILLER: RegExp[] = [
  /^(?:just )?let me know if (?:you need|there'?s|you'?d like) anything\b[^.!?]*[.!]?$/i,
  /^feel free to [^.!?]*[.!]?$/i,
  /^(?:i )?hope (?:this|that) helps[.!]?$/i,
  /^(?:is there )?anything else(?: i can [^?]*)?\?$/i,
  /^n'h[ée]site pas [^.!?]*[.!]?$/i,
  /^(?:dis-moi )?si tu as besoin d'autre chose[^.!?]*[.!?]?$/i,
  /^autre chose\s*\?$/i,
  /^great question[.!]?$/i,
];

function stripFiller(bubble: string): string {
  return bubble
    .split("\n")
    .map((line) =>
      line
        .split(/(?<=[.!?])[ \t]+/)
        .filter((s) => !FILLER.some((r) => r.test(s.trim())))
        .join(" "),
    )
    .filter((line) => line.trim())
    .join("\n")
    .trim();
}

export function render(text: string | null | undefined): Rendered {
  // [rien] est une balise, jamais une bulle : écrite après une phrase (« Je m'en occupe. » puis [rien]), elle partait
  // telle quelle dans le fil (banc du 19/10).
  let body = (text ?? "").replace(/^[ \t]*\[rien\][ \t]*$/gim, "").trim();
  if (!body || SILENCE.test(body)) return { bubbles: [] };
  let react: string | undefined;
  let effect: Rendered["effect"];
  const fx = body.match(EFFECT);
  if (fx) {
    effect = fx[1].toLowerCase() === "fort" ? "loud" : "confetti";
    body = body.replace(EFFECT, "").trim();
  }
  // La balise de réaction se lit où qu'elle soit, seule sur sa ligne ou devant le texte (« [react:👍] Compris. ») :
  // le 19/10 elle est partie en toutes lettres dans le fil.
  const m = body.match(REACT) ?? body.match(REACT_INLINE);
  if (m && ((TAPBACKS as readonly string[]).includes(m[1]) || EMOJI.test(m[1]))) {
    react = m[1];
    body = body.replace(m[0], "").trim();
  }
  // Pas de tirets longs, jamais.
  body = body.replace(/\s*[\u2014\u2013]\s*/g, " - ");
  // iMessage n'affiche pas le markdown : les ** et les # resteraient tels quels dans la bulle.
  body = body.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,6}\s+/gm, "");
  let bubbles = body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const kept = bubbles.map(stripFiller).filter(Boolean);
  if (kept.length) bubbles = kept;
  if (bubbles.length > MAX_BUBBLES) {
    bubbles = [...bubbles.slice(0, MAX_BUBBLES - 1), bubbles.slice(MAX_BUBBLES - 1).join("\n\n")];
  }
  // Un lien seul dans sa bulle devient une carte d'aperçu dans iMessage, comme chez Instinct.
  bubbles = bubbles.flatMap((b) => {
    const link = b.match(ENDS_WITH_URL);
    return link ? [link[1], link[2]] : [b];
  });
  return { bubbles, react, effect: bubbles.length ? effect : undefined };
}
