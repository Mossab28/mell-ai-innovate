/**
 * Contrat entre le relais (un Mac qui tient une ligne iMessage) et le serveur.
 * Le relais ne reçoit jamais de connexion entrante : il pousse les messages reçus
 * et vient chercher les envois en long-polling. Un Mac derrière une box suffit.
 */

/** Les six réactions iMessage classiques (associated_message_type 2000 à 2005). */
export const TAPBACKS = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const;
export type Tapback = (typeof TAPBACKS)[number];

/** Repli texte quand le relais ne sait pas poser une vraie réaction. */
export const TAPBACK_EMOJI: Record<Tapback, string> = {
  love: "❤️",
  like: "👍",
  dislike: "👎",
  laugh: "😂",
  emphasize: "‼️",
  question: "❓",
};

/**
 * Pièce jointe déjà convertie par le relais : photo en JPEG (1600 px au plus), mémo vocal en WAV
 * 16 kHz mono. `file` : autre chose (PDF, vidéo), le nom seulement. Le serveur la lit puis l'efface.
 */
export interface InboundAttachment {
  kind: "image" | "audio" | "file";
  mime: string;
  /** Contenu en base64 (absent pour `file`, et pour un vocal déjà transcrit). */
  data?: string;
  /** Vocal transcrit sur le Mac de la ligne : le son ne voyage pas. */
  transcript?: string;
  name?: string;
}

/** Un message reçu par la ligne. `guid` est l'identifiant iMessage, unique et stable. */
export interface InboundMessage {
  guid: string;
  /** Numéro (E.164) ou adresse mail de l'expéditeur. */
  from: string;
  /** Horodatage ISO du message côté Messages. */
  sentAt: string;
  text?: string;
  /** Présent si le message est une réaction posée sur un autre message. */
  tapback?: { kind: Tapback | string; targetGuid?: string; removed?: boolean };
  service?: "iMessage" | "SMS";
  attachments?: InboundAttachment[];
  /** Fichiers bruts lus dans chat.db, avant conversion. Usage interne du relais. */
  files?: Array<{ path: string; mime?: string; name?: string; audio?: boolean }>;
  /** Identifiant de la conversation côté Messages (ex. « iMessage;-;+33... »). Usage interne du relais. */
  chatGuid?: string;
}

export interface InboundBatch {
  lineId: string;
  messages: InboundMessage[];
}

/** « delete » : effacer de Messages le message `targetGuid` (un secret tapé dans le fil). */
/** « typing » : allumer les trois petits points ; « edit » : réécrire la bulle `targetGuid` (avancement). */
/** « call » : appeler la personne en FaceTime audio et lui dire `text` (réveil, rappel qui ne doit pas être raté). */
/** « contact » : envoyer une fiche contact (vCard dans `text`) pour que la personne ajoute Mell à ses contacts. */
/** « image » : envoyer la photo dont `text` donne l'adresse (https, servie par Mell) en pièce jointe. */
export type OutboundKind = "text" | "tapback" | "delete" | "typing" | "edit" | "call" | "contact" | "image" | "card";

/** Un envoi que le relais doit faire. Les bulles d'un même tour arrivent dans l'ordre. */
export interface OutboundMessage {
  id: number;
  to: string;
  kind: OutboundKind;
  text?: string;
  /** Pour kind = "tapback" : la réaction, ou un emoji libre. */
  tapback?: string;
  targetGuid?: string;
  /** Effet d'écran souhaité (confetti...). Ignoré si le relais ne sait pas le faire. */
  effect?: "confetti" | "loud";
  /** Répondre dans le fil de ce message (guid iMessage). Ignoré sans l'API privée. */
  replyTo?: string;
  /** Pour kind = "card" : l'adresse de l'image ; `text` porte la légende (lien). */
  image?: string;
}

export interface OutboxResponse {
  messages: OutboundMessage[];
}

export interface AckRequest {
  lineId: string;
  /** guid : identifiant iMessage de la bulle envoyée, quand le relais le connaît (BlueBubbles). */
  results: Array<{ id: number; ok: boolean; error?: string; guid?: string }>;
}
