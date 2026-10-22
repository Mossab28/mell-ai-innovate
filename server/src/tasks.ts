import type { Db } from "./db.ts";

/**
 * Autorisation par tâche. L'agent annonce une tâche et son périmètre (actions, plafond de
 * dépense) ; l'utilisateur dit oui une fois ; chaque étape dans le périmètre passe ensuite
 * sans redemander. Tout ce qui sort du périmètre redemande. Le paiement lui-même reste
 * soumis au 3-D Secure de la banque : c'est le dernier verrou, et il n'est pas à nous.
 *
 * Cette décision vit dans le code, pas dans le prompt : le modèle ne peut ni s'autoriser
 * lui-même, ni dépasser le plafond, quoi qu'un mail ou une page web lui raconte.
 */

export const ACTIONS = [
  "search_web",
  "read_email",
  "send_email",
  "calendar_write",
  "book",
  "buy",
  "pay",
  "message_contact",
  "cancel_subscription",
  // Écriture sur une app connectée (Notion, Slack, Trello...) via Composio.
  "app_write",
  // Coffre : se connecter avec ses identifiants (et son code 2FA), remplir ses infos perso.
  "log_in",
  "fill_personal",
] as const;
export type Action = (typeof ACTIONS)[number];

/** Actions qui engagent de l'argent : le montant compte contre le plafond. */
const SPENDING: ReadonlySet<string> = new Set(["buy", "pay", "book"]);

export interface Task {
  id: string;
  user_id: string;
  title: string;
  actions: string[];
  spend_cap_cents: number;
  currency: string;
  spent_cents: number;
  /** Destinataires prévus (adresses mail, en minuscules). Un envoi ou une invitation ne part qu'à eux. */
  recipients?: string[];
  status: "proposed" | "authorized" | "awaiting_bank" | "done" | "cancelled" | "expired";
  authorized_at: Date | null;
  expires_at: Date | null;
}

export type StepDecision =
  | { decision: "allowed" }
  | { decision: "awaiting_bank" }
  | { decision: "needs_approval"; reason: string };

/** Adresse mail réduite à sa forme comparable : « Paul <Paul@Exemple.fr> » -> « paul@exemple.fr ». */
export function normalizeEmail(input: string): string {
  const s = (/<([^<>]+)>\s*$/.exec(input)?.[1] ?? input).trim().toLowerCase();
  if (!/^[^\s@<>(),;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) throw new Error(`adresse invalide : ${input.slice(0, 80)}`);
  return s;
}

/**
 * Le cœur de la politique, pur et testable. `recipients` : à qui l'étape écrit (mail, invitation),
 * déjà normalisés. Chacun doit figurer dans le périmètre validé, sinon on redemande.
 */
export function decideStep(task: Task, action: string, amountCents: number, now = new Date(), recipients: string[] = []): StepDecision {
  if (task.status === "proposed") return { decision: "needs_approval", reason: "la tâche n'est pas encore validée" };
  if (task.status === "cancelled" || task.status === "done") return { decision: "needs_approval", reason: `la tâche est ${task.status === "done" ? "terminée" : "annulée"}` };
  if (task.status === "expired" || (task.expires_at && new Date(task.expires_at) <= now)) {
    return { decision: "needs_approval", reason: "l'autorisation a expiré" };
  }
  if (task.status === "awaiting_bank") return { decision: "needs_approval", reason: "un paiement attend déjà la validation de la banque" };
  if (!task.actions.includes(action)) return { decision: "needs_approval", reason: `l'action « ${action} » n'était pas prévue` };
  if (amountCents < 0) return { decision: "needs_approval", reason: "montant invalide" };
  if (recipients.length) {
    const allowed = new Set(task.recipients ?? []);
    const outside = recipients.filter((r) => !allowed.has(r));
    if (outside.length) return { decision: "needs_approval", reason: `${outside.join(", ")} n'était pas prévu comme destinataire` };
  }
  if (SPENDING.has(action) && task.spent_cents + amountCents > task.spend_cap_cents) {
    return { decision: "needs_approval", reason: `dépasse le plafond de ${formatMoney(task.spend_cap_cents, task.currency)}` };
  }
  if (action === "pay") return { decision: "awaiting_bank" };
  return { decision: "allowed" };
}

export function formatMoney(cents: number, currency = "EUR"): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(cents / 100);
}

type Q = Pick<Db, "query">;

export async function proposeTask(
  db: Q,
  userId: string,
  p: { title: string; actions: string[]; spendCapCents: number; currency?: string; recipients?: string[] },
): Promise<Task> {
  const actions = p.actions.filter((a) => (ACTIONS as readonly string[]).includes(a));
  if (!actions.length) throw new Error("aucune action reconnue");
  const recipients = [...new Set((p.recipients ?? []).map(normalizeEmail))].slice(0, 20);
  // Une nouvelle proposition remplace les anciennes encore en attente : un « ok » ne vaut que pour la dernière.
  await db.query(`UPDATE tasks SET status = 'cancelled' WHERE user_id = $1 AND status = 'proposed'`, [userId]);
  const { rows } = await db.query<Task>(
    `INSERT INTO tasks (user_id, title, actions, spend_cap_cents, currency, recipients) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [userId, p.title.slice(0, 200), actions, Math.max(0, Math.round(p.spendCapCents)), p.currency ?? "EUR", recipients],
  );
  return rows[0];
}

/**
 * Tâche validée d'emblée : la personne a touché le bouton d'une carte (« Envoyer », « Réserver · 18 € »).
 * Ce geste est son accord pour cette action précise, dans ce périmètre et sous ce plafond.
 */
export async function authorizeNow(
  db: Q,
  userId: string,
  p: { title: string; actions: string[]; spendCapCents: number; currency?: string; recipients?: string[] },
  hours: number,
): Promise<Task> {
  const actions = p.actions.filter((a) => (ACTIONS as readonly string[]).includes(a));
  const recipients = [...new Set((p.recipients ?? []).map(normalizeEmail))].slice(0, 20);
  const { rows } = await db.query<Task>(
    `INSERT INTO tasks (user_id, title, actions, spend_cap_cents, currency, recipients, status, authorized_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'authorized', now(), now() + make_interval(hours => $7)) RETURNING *`,
    [userId, p.title.slice(0, 200), actions, Math.max(0, Math.round(p.spendCapCents)), p.currency ?? "EUR", recipients, hours],
  );
  return rows[0];
}

/** Résumé que l'utilisateur valide. C'est ce texte qui définit ce qu'il autorise. */
export function describeScope(t: Task): string {
  const money = t.spend_cap_cents > 0 ? `, ${formatMoney(t.spend_cap_cents, t.currency)} max` : "";
  const to = t.recipients?.length ? `, à ${t.recipients.join(", ")}` : "";
  return `${t.title} (${t.actions.map(actionLabel).join(", ")}${to}${money})`;
}

function actionLabel(a: string): string {
  const labels: Record<string, string> = {
    search_web: "recherche",
    read_email: "lecture des mails",
    send_email: "envoi de mails",
    calendar_write: "agenda",
    book: "réservation",
    buy: "commande",
    pay: "paiement",
    message_contact: "message à un tiers",
    cancel_subscription: "résiliation",
    log_in: "connexion avec tes identifiants",
    fill_personal: "tes infos perso",
  };
  return labels[a] ?? a;
}

/** Mots qui, seuls ou combinés, valent un « oui » (« oui vas-y », « ok go »). Rien d'autre dans le message. */
const APPROVAL_WORDS = new Set([
  "ok", "okay", "oki", "oui", "ouais", "ouai", "yes", "yep", "yup", "yeah", "go", "vas-y", "vasy", "let's", "lets",
  "c'est", "bon", "d'accord", "dac", "daccord", "valide", "validé", "parfait", "fais-le", "fais", "le", "do", "it",
  "sure", "carrément", "top", "nickel", "👍", "👌", "✅",
]);

export function isApprovalText(text: string | undefined): boolean {
  if (!text) return false;
  const words = text
    .toLowerCase()
    .replace(/[.!,;:?]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || words.length > 5) return false;
  return words.every((w) => APPROVAL_WORDS.has(w));
}

export function isApprovalTapback(kind: string | undefined): boolean {
  return kind === "like" || kind === "love" || kind === "emphasize" || kind === "👍";
}

/**
 * Appelé avant le modèle, sur le message de l'utilisateur lui-même : si c'est un « oui » et
 * qu'une tâche attend, elle est autorisée. Le modèle n'a pas ce pouvoir.
 */
export async function authorizePending(db: Q, userId: string, hours: number): Promise<Task | undefined> {
  const { rows } = await db.query<Task>(
    `UPDATE tasks SET status = 'authorized', authorized_at = now(), expires_at = now() + make_interval(hours => $2)
     WHERE id = (SELECT id FROM tasks WHERE user_id = $1 AND status = 'proposed' AND created_at > now() - interval '24 hours'
                 ORDER BY created_at DESC LIMIT 1)
     RETURNING *`,
    [userId, hours],
  );
  return rows[0];
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}]+/gu, " ")
    .trim();

/**
 * C'est l'agent qui lit son accord, en citant ses mots. Le code vérifie seulement que la citation vient d'elle : un de
 * ses messages des 30 dernières minutes la contient, ou elle vient de mettre une réaction positive. Une page web ou un
 * mail ne peut pas fabriquer un message d'elle : c'est la garde contre l'injection, pas un jugement.
 */
export async function saidByHer(db: Q, userId: string, words: string): Promise<boolean> {
  const want = fold(String(words ?? ""));
  if (!want) return false;
  const { rows } = await db.query<{ text: string | null; tapback: string | null }>(
    `SELECT text, tapback FROM messages WHERE user_id = $1 AND direction = 'in' AND sent_at > now() - interval '30 minutes' ORDER BY id DESC LIMIT 12`,
    [userId],
  );
  return rows.some((r) => (r.text && fold(r.text).includes(want)) || (!r.text && r.tapback && isApprovalTapback(r.tapback)));
}

/** Valide une tâche proposée précise, quand ses mots la couvrent (vérifiés par saidByHer). */
export async function authorizeTask(db: Q, userId: string, taskId: string, hours: number): Promise<Task | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) return undefined;
  const { rows } = await db.query<Task>(
    `UPDATE tasks SET status = 'authorized', authorized_at = now(), expires_at = now() + make_interval(hours => $3)
     WHERE id = $1 AND user_id = $2 AND status = 'proposed' RETURNING *`,
    [taskId, userId, hours],
  );
  return rows[0];
}

export async function getTask(db: Q, userId: string, id: string): Promise<Task | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  return (await db.query<Task>(`SELECT * FROM tasks WHERE id = $1 AND user_id = $2`, [id, userId])).rows[0];
}

export async function listOpenTasks(db: Q, userId: string): Promise<Task[]> {
  return (
    await db.query<Task>(
      `SELECT * FROM tasks WHERE user_id = $1 AND status IN ('proposed', 'authorized', 'awaiting_bank') ORDER BY created_at DESC LIMIT 10`,
      [userId],
    )
  ).rows;
}

/** Tente une étape : décide, journalise, et applique l'effet (dépense, attente banque). */
/**
 * `count` : l'étape dépense pour de vrai (le clic du navigateur sur « Commander », « Payer »). L'agent qui annonce une
 * étape d'achat avec perform_step ne fait que la vérifier : sinon la même dépense comptait deux fois, une fois à
 * l'annonce, une fois au clic, et le clic dépassait le plafond (14 € sous un plafond de 20 € refusés, 19/10).
 */
export async function recordStep(
  db: Q,
  task: Task,
  step: { action: string; amountCents: number; detail?: string; recipients?: string[] },
  opts: { count?: boolean; bank?: boolean } = {},
): Promise<StepDecision> {
  const count = opts.count ?? true;
  const recipients = (step.recipients ?? []).map(normalizeEmail);
  let d = decideStep(task, step.action, step.amountCents, new Date(), recipients);
  // `bank: false` : le clic « Payer » du navigateur. L'attente de la banque ne commence que si la page en affiche une.
  if (opts.bank === false && d.decision === "awaiting_bank") d = { decision: "allowed" };
  const detail = [step.detail, recipients.length ? `à ${recipients.join(", ")}` : undefined].filter(Boolean).join(" ; ");
  await db.query(`INSERT INTO task_steps (task_id, action, amount_cents, detail, decision, reason) VALUES ($1, $2, $3, $4, $5, $6)`, [
    task.id,
    step.action,
    step.amountCents,
    detail ? detail.slice(0, 500) : null,
    d.decision,
    d.decision === "needs_approval" ? d.reason : null,
  ]);
  if (!count) return d;
  if (d.decision === "allowed" && SPENDING.has(step.action)) {
    await db.query(`UPDATE tasks SET spent_cents = spent_cents + $2 WHERE id = $1`, [task.id, step.amountCents]);
  }
  if (d.decision === "awaiting_bank") {
    await db.query(`UPDATE tasks SET status = 'awaiting_bank', spent_cents = spent_cents + $2 WHERE id = $1`, [task.id, step.amountCents]);
  }
  return d;
}

/** La page affiche vraiment une validation de sa banque : la tâche attend sa réponse. */
export async function markAwaitingBank(db: Q, taskId: string): Promise<void> {
  await db.query(`UPDATE tasks SET status = 'awaiting_bank' WHERE id = $1 AND status = 'authorized'`, [taskId]);
}

/**
 * Un paiement cliqué pendant ce passage qui n'a pas abouti (erreur, code jamais reçu, page fermée) : la tâche redevient
 * payable et la dépense est rendue, sinon toute nouvelle tentative était refusée (plafond ou attente de la banque).
 */
export async function releasePayment(db: Q, taskId: string, since: Date): Promise<void> {
  const step = (
    await db.query<{ id: number; amount_cents: number }>(
      `SELECT id, amount_cents FROM task_steps WHERE task_id = $1 AND action = 'pay' AND decision IN ('awaiting_bank', 'allowed') AND created_at >= $2 ORDER BY id DESC LIMIT 1`,
      [taskId, since],
    )
  ).rows[0];
  if (!step) {
    await db.query(`UPDATE tasks SET status = 'authorized' WHERE id = $1 AND status = 'awaiting_bank'`, [taskId]);
    return;
  }
  await db.query(`UPDATE task_steps SET decision = 'released' WHERE id = $1`, [step.id]);
  await db.query(`UPDATE tasks SET status = CASE WHEN status = 'awaiting_bank' THEN 'authorized' ELSE status END, spent_cents = greatest(0, spent_cents - $2) WHERE id = $1`, [taskId, step.amount_cents]);
}

/** Retour de la banque (3-D Secure) : validé, le paiement est fait ; refusé, la dépense est rendue. */
export async function bankResult(db: Q, taskId: string, approved: boolean): Promise<Task | undefined> {
  if (approved) return (await db.query<Task>(`UPDATE tasks SET status = 'authorized' WHERE id = $1 AND status = 'awaiting_bank' RETURNING *`, [taskId])).rows[0];
  // Refusé : la dépense du dernier paiement est rendue, et son étape marquée rendue pour ne jamais la rendre deux fois.
  const waiting = (await db.query<Task>(`SELECT * FROM tasks WHERE id = $1 AND status = 'awaiting_bank'`, [taskId])).rows[0];
  if (!waiting) return undefined;
  const step = (
    await db.query<{ id: number; amount_cents: number }>(
      `SELECT id, amount_cents FROM task_steps WHERE task_id = $1 AND action = 'pay' AND decision IN ('awaiting_bank', 'allowed') ORDER BY id DESC LIMIT 1`,
      [taskId],
    )
  ).rows[0];
  if (step) await db.query(`UPDATE task_steps SET decision = 'released' WHERE id = $1`, [step.id]);
  return (
    await db.query<Task>(`UPDATE tasks SET status = 'authorized', spent_cents = greatest(0, spent_cents - $2) WHERE id = $1 RETURNING *`, [taskId, step?.amount_cents ?? 0])
  ).rows[0];
}

export async function setTaskStatus(db: Q, userId: string, id: string, status: "done" | "cancelled"): Promise<boolean> {
  const { rows } = await db.query(`UPDATE tasks SET status = $3 WHERE id = $1 AND user_id = $2 AND status NOT IN ('done', 'cancelled') RETURNING id`, [
    id,
    userId,
    status,
  ]);
  return rows.length > 0;
}
