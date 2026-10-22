import type { Db } from "./db.ts";
import { logoTilePng } from "./web/da.ts";
import { attachToInviter, redeemInvite } from "./invites.ts";

export interface User {
  id: string;
  handle: string;
  line_id: string;
  name: string | null;
  timezone: string;
  lang: string;
  city: string | null;
  attribution_code: string | null;
  /** Rien de proactif avant cette heure (« pas avant lundi »). */
  quiet_until: Date | null;
  /** Comment elle écrit, lu par le modèle (voice.ts), et le nombre de messages reçus à ce moment-là. */
  voice_note: string | null;
  voice_note_msgs: number;
  /** La fiche de reprise du fil au-delà des derniers messages (compaction.ts). */
  thread_summary: string | null;
  thread_summary_upto: number | string;
  thread_summary_at: Date | string | null;
  /** Ses heures de passage (rhythm.ts) : { morning, midday, evening } en heure locale, ou null = par défaut. */
  pulse_times: unknown;
  pulse_times_at: Date | null;
  /** « less » : Mell n'écrit de lui-même que pour ce qui compte vraiment. */
  proactive: "normal" | "less";
  status: "active" | "waitlist";
  /** Partie avant @ de son adresse Mell, créée au premier besoin (mail/address.ts). */
  mail_alias?: string | null;
}

/** Code glissé dans le texte pré-rempli du bouton : `Hi Mell! (k7q2)`. */
const ATTRIBUTION = /\(([a-z0-9]{4,8})\)\s*$/i;

export function parseAttribution(text: string | undefined): string | undefined {
  return text?.trim().match(ATTRIBUTION)?.[1]?.toLowerCase();
}

export function guessLang(text: string | undefined): "fr" | "en" {
  return /\b(salut|bonjour|coucou|bonsoir|cc|slt|wesh|merci)\b/i.test(text ?? "") ? "fr" : "en";
}

/**
 * Trouve l'utilisateur derrière un numéro, ou le crée sur la ligne où il a écrit.
 * `created` dit s'il faut lancer l'accueil.
 */
export async function findOrCreateUser(
  db: Pick<Db, "query">,
  handle: string,
  lineId: string,
  firstText: string | undefined,
  opts: { inviteOnly?: boolean } = {},
): Promise<{ user: User; created: boolean }> {
  const existing = (await db.query<User>(`SELECT * FROM users WHERE handle = $1`, [handle])).rows[0];
  if (existing) return { user: existing, created: false };
  const code = parseAttribution(firstText);
  // Sur invitation : un code encore valable fait entrer (et en consomme une), sinon la liste d'attente.
  const redeemed = code ? await redeemInvite(db, code) : undefined;
  const status = !opts.inviteOnly || redeemed ? "active" : "waitlist";
  const { rows } = await db.query<User>(
    `INSERT INTO users (handle, line_id, lang, attribution_code, status, admitted_at) VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'active' THEN now() END)
     ON CONFLICT (handle) DO NOTHING RETURNING *`,
    [handle, lineId, guessLang(firstText), code ?? null, status],
  );
  if (rows[0]) {
    if (redeemed) await attachToInviter(db, rows[0].id, redeemed);
    return { user: rows[0], created: true };
  }
  // Course entre deux messages simultanés : l'autre l'a créé.
  return { user: (await db.query<User>(`SELECT * FROM users WHERE handle = $1`, [handle])).rows[0], created: false };
}

export async function getUser(db: Pick<Db, "query">, id: string): Promise<User> {
  return (await db.query<User>(`SELECT * FROM users WHERE id = $1`, [id])).rows[0];
}

/** Échappe un champ vCard (virgule, point-virgule, retour ligne). */
function vcf(value: string): string {
  return value.replace(/[\\,;]/g, (c) => `\\${c}`).replace(/\r?\n/g, "\\n");
}

/**
 * Fiche contact de Mell (vCard) à ajouter en un toucher. Une fois Mell dans les contacts, iMessage
 * affiche l'aperçu des cartes tout seul. On met le numéro (ou l'adresse) de la ligne sur laquelle elle écrit.
 */
export function mellVCard(handle: string, lang: string): string {
  const note = lang === "en" ? "Your personal assistant. Text me here." : "Ton assistant perso. Écris-moi ici.";
  const line = handle.includes("@") ? `EMAIL;type=INTERNET;type=pref:${vcf(handle)}` : `TEL;type=CELL;type=pref:${vcf(handle)}`;
  // La photo : le logo m. sur sa tuile noire, pour que Mell ait un visage dans Contacts et dans le fil.
  const photo = `PHOTO;ENCODING=b;TYPE=PNG:${logoTilePng().toString("base64")}`;
  return ["BEGIN:VCARD", "VERSION:3.0", "N:Mell;;;;", "FN:Mell", "ORG:Murmell", line, photo, `NOTE:${vcf(note)}`, "END:VCARD", ""].join("\r\n");
}

/** Le texte qui précède la fiche contact à l'inscription. */
export function addContactBubble(lang: string): string {
  // Étape d'accueil importante : sans Mell dans les contacts, iMessage masque l'aperçu de ses liens
  // (« Toucher pour charger »). On la présente comme le premier geste à faire, pas une option.
  return lang === "en" ? "Save me to your contacts 👇" : "Ajoute-moi à tes contacts 👇";
}

/**
 * Accueil façon Instinct (« You're in! 🎉 » / « Welcome » / des exemples) : trois bulles brèves,
 * confettis sur la première, pas de liste de fonctions. Pas de modèle, pas d'attente.
 */
export function welcomeBubbles(lang: string): Array<{ text: string; effect?: "confetti" }> {
  if (lang === "fr") {
    return [
      { text: "Tu es dedans ! 🎉", effect: "confetti" },
      { text: "Moi c'est Mell. Un truc que tu repousses ?" },
    ];
  }
  return [
    { text: "You're in! 🎉", effect: "confetti" },
    { text: "I'm Mell. Anything you've been putting off?" },
  ];
}

/** L'accueil complet, dans l'ordre : « tu es dedans », la fiche contact, puis la question à laquelle elle répond. */
export function welcomeItems(userId: string, lang: string, lineHandle: string | undefined) {
  const [hello, ...rest] = welcomeBubbles(lang);
  return [
    { userId, kind: "text" as const, text: hello.text, effect: hello.effect, dedupeKey: `welcome:${userId}:0` },
    ...(lineHandle
      ? [
          { userId, kind: "text" as const, text: addContactBubble(lang), dedupeKey: `welcome-contact-intro:${userId}` },
          { userId, kind: "contact" as const, text: mellVCard(lineHandle, lang), dedupeKey: `welcome-contact:${userId}` },
        ]
      : []),
    ...rest.map((b, i) => ({ userId, kind: "text" as const, text: b.text, dedupeKey: `welcome:${userId}:${i + 1}` })),
  ];
}
