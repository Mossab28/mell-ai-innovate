import type { Config, RouteClass } from "./config.ts";

/**
 * Tri des messages par l'API Decisions d'OpenAI (gpt-6-luna) : une question à choix, une réponse
 * typée avec sa confiance, environ 0,27 s au lieu de 0,75 s pour un appel de génération, et un
 * coût quasi nul (0,10 $ le million de jetons d'entrée, rien en sortie). Banc du 16/10 : 97 % de
 * bons tris sur 60 messages étiquetés, les deux ratés étaient hésitants (confiance sous 0,5) et la
 * règle « dans le doute, le chemin plus lourd » les rattrape. En bêta : à la moindre erreur, le
 * routeur repasse sur le modèle de génération.
 */

const ROUTE = {
  type: "choice",
  name: "route",
  instructions:
    "Mell est un assistant personnel par SMS. Quel chemin faut-il pour répondre au nouveau message de l'utilisateur ? Dans le doute entre deux, prends le plus lourd.",
  choices: [
    { value: "react", description: "Un merci, un ok, un emoji, une info qui n'appelle aucune réponse : une réaction iMessage suffit. Jamais pour une question ni pour une demande (retiens, note, rappelle, appelle, préviens)." },
    { value: "quick", description: "Une question ou une discussion qui se règle par une réponse directe, sans rien faire ni rien retenir." },
    {
      value: "tool",
      description: "Retenir une info sur lui (« retiens que », « note que »), oublier, programmer un rappel, un réveil ou une routine, l'appeler au téléphone (« appelle-moi »), consulter ce qu'il sait, ses mails ou son agenda, la météo, inviter un proche, valider ou annuler une tâche, répondre par une réaction à une question de Mell. Rapide mais avec outils.",
    },
    { value: "task", description: "Un vrai travail qui prend du temps : chercher sur le web (un produit, un cadeau, un logement, un artisan), comparer, réserver, acheter, résilier ou annuler un abonnement, plusieurs étapes. Aussi un « oui », « vas-y », « go » qui accepte ce que Mell vient de proposer de faire (réserver, acheter, chercher)." },
  ],
};

const TAPBACK = {
  type: "choice",
  name: "tapback",
  instructions: "Si Mell répond seulement par une réaction iMessage, laquelle va le mieux ?",
  choices: [
    { value: "love", description: "Un merci, une bonne nouvelle, de l'affection." },
    { value: "like", description: "Un ok, un accord, une info prise en compte." },
    { value: "laugh", description: "Une blague, un message drôle." },
    { value: "emphasize", description: "Une chose importante ou impressionnante." },
  ],
};

const LANG = {
  type: "choice",
  name: "lang",
  instructions: "Dans quelle langue l'utilisateur a-t-il écrit son nouveau message ? « unclear » s'il est trop court pour trancher (ok, lol, hey, un emoji, un nom propre) ou s'il mélange les deux.",
  choices: [
    { value: "fr", description: "Français, même familier, abrégé ou sans accents." },
    { value: "en", description: "Anglais, même familier ou abrégé." },
    { value: "unclear", description: "Trop court, un emoji, un nom, ou un mélange : on ne peut pas dire." },
  ],
};

const NEEDS_ACTION = {
  type: "predicate",
  name: "needs_action",
  instructions:
    "Pour bien répondre à ce que l'utilisateur vient d'écrire, compte tenu des derniers échanges (un « oui », « vas-y », « go » qui accepte une proposition d'agir de l'assistant est une demande d'action), l'assistant doit-il agir avec un outil (l'appeler au téléphone, programmer un rappel ou un réveil, retenir ou oublier une info, surveiller quelque chose, regarder ses mails ou son agenda, la météo, chercher sur le web, réserver, envoyer, inviter quelqu'un) plutôt que simplement répondre ? Oui aussi si la bonne réponse contient une information du moment qu'il faudrait vérifier en ligne : un prix, un horaire, une disponibilité, une heure d'ouverture, une date de livraison.",
};

const CLAIMS_ACTION = {
  type: "predicate",
  name: "claims_action",
  instructions:
    "La réponse de l'assistant affirme-t-elle avoir fait, programmé, noté, lancé ou envoyé quelque chose (un appel, un rappel, une note, une surveillance, un lien, une réservation, un message), ou contient-elle une fausse étiquette entre crochets à la place d'un vrai contenu ?",
};

/**
 * Juge d'une réponse écrite sans outil : fallait-il agir, et la réponse prétend-elle avoir agi ?
 * C'est le modèle qui en décide, pas une liste de mots : on ne peut pas prévoir ce que les gens
 * écriront. Rend des probabilités, ou undefined si l'API ne répond pas.
 */
export async function judgeReply(cfg: Pick<Config, "decisions">, userText: string, reply: string, recent = ""): Promise<{ needsAction: number; claimsAction: number } | undefined> {
  const d = cfg.decisions;
  if (!d.key) return undefined;
  try {
    const res = await fetch(`${d.base.replace(/\/+$/, "")}/decisions`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: d.model, input: `${recent ? `Derniers échanges :\n${recent}\n\n` : ""}Message de l'utilisateur :\n${userText}\n\nRéponse de l'assistant, écrite sans aucun outil :\n${reply}`, questions: [NEEDS_ACTION, CLAIMS_ACTION] }),
      signal: AbortSignal.timeout(d.timeoutMs),
    });
    if (!res.ok) return undefined;
    const j: any = await res.json();
    const p = (name: string) => Number(j.answers?.find((a: any) => a.name === name)?.probability ?? 0);
    return { needsAction: p("needs_action"), claimsAction: p("claims_action") };
  } catch {
    return undefined;
  }
}

const CONSENT = {
  type: "predicate",
  name: "consent",
  instructions:
    "D'après les derniers échanges et son dernier message, la personne a-t-elle déjà demandé ou accepté clairement que l'assistant fasse cette tâche-là maintenant (par un ordre direct, ou un oui, un mot ou une réaction, à la proposition de l'assistant) ? Non si un choix reste ouvert (lequel, quand, combien) ou si le prix ou le périmètre de la tâche dépasse ce qu'elle a accepté.",
};

/** Sa demande ou son oui couvre-t-il déjà la tâche ? Probabilité, ou undefined si l'API ne répond pas. */
export async function judgeConsent(cfg: Pick<Config, "decisions">, recent: string, task: string): Promise<number | undefined> {
  const d = cfg.decisions;
  if (!d.key) return undefined;
  try {
    const res = await fetch(`${d.base.replace(/\/+$/, "")}/decisions`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: d.model, input: `Derniers échanges (le plus récent en bas) :\n${recent}\n\nTâche que l'assistant s'apprête à faire :\n${task}`, questions: [CONSENT] }),
      signal: AbortSignal.timeout(d.timeoutMs),
    });
    if (!res.ok) return undefined;
    const j: any = await res.json();
    return Number(j.answers?.find((a: any) => a.name === "consent")?.probability ?? 0);
  } catch {
    return undefined;
  }
}

export interface DecisionRoute {
  class: RouteClass;
  tapback?: string;
  confidence: number;
  inputTokens: number;
  /** Langue du message selon le modèle, absente s'il ne peut pas trancher. */
  lang?: "fr" | "en";
}

export async function decideRoute(cfg: Pick<Config, "decisions">, text: string, recent: string): Promise<DecisionRoute> {
  const d = cfg.decisions;
  if (!d.key) throw new Error("pas de clé OpenAI");
  const res = await fetch(`${d.base.replace(/\/+$/, "")}/decisions`, {
    method: "POST",
    headers: { authorization: `Bearer ${d.key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: d.model, input: `${recent ? `Derniers échanges :\n${recent}\n\n` : ""}Nouveau message :\n${text}`, questions: [ROUTE, TAPBACK, LANG] }),
    signal: AbortSignal.timeout(d.timeoutMs),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Decisions ${res.status}`);
  const route = j.answers?.find((a: any) => a.name === "route");
  const tap = j.answers?.find((a: any) => a.name === "tapback");
  const lang = j.answers?.find((a: any) => a.name === "lang")?.choice;
  if (!["react", "quick", "tool", "task"].includes(route?.choice)) throw new Error("réponse Decisions illisible");
  return { class: route.choice, tapback: route.choice === "react" ? tap?.choice : undefined, confidence: Number(route.confidence ?? 0.5), inputTokens: Number(j.usage?.input_tokens ?? 0), ...(lang === "fr" || lang === "en" ? { lang } : {}) };
}
