import type { Db } from "./db.ts";
import { getPersonal } from "./personal.ts";

type Q = Pick<Db, "query">;

/**
 * Les modes d'emploi que Mell apprend en faisant (docs/SELF-IMPROVEMENT.md, repris de Hermes Agent). La revue les écrit
 * après un travail de fond ; le navigateur relit ceux du site où il arrive ; l'agent voit leur liste. Stockés chez nous,
 * exportables au format SKILL.md : ils servent à n'importe quel modèle.
 */

export interface Skill {
  id: number;
  scope: "global" | "user";
  user_id: string | null;
  name: string;
  description: string;
  body: string;
  domains: string[];
  status: "active" | "pending" | "stale" | "archived";
  version: number;
  uses: number;
}

const MAX_BODY = 6000;
/**
 * Ses leçons à elle (portée user, sans site) : sa façon de faire, tirée de ses reprises. Toujours sous les yeux de l'agent,
 * donc bornées comme la fiche de Hermes (USER.md) : quand c'est plein, la revue regroupe au lieu d'empiler.
 */
export const PROFILE_BUDGET = 2500;

/** Les modes d'emploi utilisables pour elle : les partagés actifs et les siens. */
export async function listSkills(q: Q, userId: string, limit = 40): Promise<Skill[]> {
  return (
    await q.query<Skill>(
      `SELECT * FROM skills WHERE status = 'active' AND (scope = 'global' OR user_id = $1) ORDER BY scope DESC, lower(name) LIMIT $2`,
      [userId, limit],
    )
  ).rows;
}

/** Ses leçons à elle, en entier, pour le contexte de l'agent (le 19/10, la seule apprise n'avait jamais été ouverte). */
export async function lessonsForHer(q: Q, userId: string): Promise<string | undefined> {
  const mine = (
    await q.query<Skill>(`SELECT * FROM skills WHERE status = 'active' AND scope = 'user' AND user_id = $1 AND domains = '{}' ORDER BY id`, [userId])
  ).rows;
  if (!mine.length) return undefined;
  const text = mine.map((s) => `${s.description}\n${s.body}`).join("\n\n").slice(0, PROFILE_BUDGET);
  return `Ce que tu as appris de sa façon à elle, à ses reprises (à suivre) :\n${text}`;
}

/** La liste pour le contexte de l'agent : nom, description, sites. Ordre stable (cache du prompt). Ses leçons à elle sont déjà en entier à côté. */
export async function skillsIndex(q: Q, userId: string): Promise<string | undefined> {
  const all = (await listSkills(q, userId)).filter((s) => !(s.scope === "user" && !s.domains.length));
  if (!all.length) return undefined;
  return `Modes d'emploi que tu as appris (skill_view pour en lire un) :\n${all.map((s) => `- ${s.name} : ${s.description}${s.domains.length ? ` (${s.domains.join(", ")})` : ""}`).join("\n")}`;
}

/** Un mode d'emploi par son nom ; compte l'usage. */
export async function viewSkill(q: Q, userId: string | null, name: string, opts: { count?: boolean } = {}): Promise<Skill | undefined> {
  const s = (
    await q.query<Skill>(
      `SELECT * FROM skills WHERE lower(name) = lower($2) AND status IN ('active', 'pending', 'stale') AND (scope = 'global' OR user_id = $1)
       ORDER BY (user_id IS NOT NULL) DESC LIMIT 1`,
      [userId, name.trim()],
    )
  ).rows[0];
  if (s && opts.count !== false) await q.query(`UPDATE skills SET uses = uses + 1, last_used_at = now(), status = CASE WHEN status = 'stale' THEN 'active' ELSE status END WHERE id = $1`, [s.id]);
  return s;
}

/**
 * Les modes d'emploi d'un site (domaine exact ou parent : « www.sncf-connect.com » trouve « sncf-connect.com »). Un mode
 * d'emploi marqué périmé par le curateur sert encore quand le navigateur revient sur son site, et redevient actif.
 */
export async function skillsForHost(q: Q, userId: string, host: string): Promise<Skill[]> {
  const h = host.toLowerCase().replace(/^www\./, "");
  const all = (
    await q.query<Skill>(`SELECT * FROM skills WHERE status IN ('active', 'stale') AND (scope = 'global' OR user_id = $1) AND domains <> '{}' ORDER BY scope DESC, lower(name)`, [userId])
  ).rows;
  const found = all.filter((s) => s.domains.some((d) => h === d || h.endsWith(`.${d}`)));
  for (const s of found) await q.query(`UPDATE skills SET uses = uses + 1, last_used_at = now(), status = 'active' WHERE id = $1`, [s.id]);
  return found;
}

export const formatSkill = (s: Pick<Skill, "name" | "description" | "body">) => `# ${s.name}\n${s.description}\n\n${s.body}`;

/**
 * Un mode d'emploi partagé ne contient rien d'une personne : ni ses infos perso, ni une adresse mail, ni un numéro
 * de téléphone ou de carte. Ce sont des formats qu'on lit, pas un jugement.
 */
export async function personalLeak(q: Q, userId: string | null, text: string): Promise<string | undefined> {
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(text)) return "une adresse mail";
  if (/(?:\+33|0)\s?[1-9](?:[\s.-]?\d{2}){4}/.test(text)) return "un numéro de téléphone";
  if (/\b(?:\d[ -]?){13,19}\b/.test(text)) return "un numéro de carte";
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const t = fold(text);
  for (const [field, value] of Object.entries(userId ? await getPersonal(q, userId) : {})) {
    for (const part of String(value ?? "").split(/[\s,;]+/).filter((p) => p.length >= 4)) if (t.includes(fold(part))) return `ses infos perso (${field})`;
  }
  return undefined;
}

export interface ManageArgs {
  action: "create" | "patch" | "rewrite" | "archive";
  name: string;
  description?: string;
  body?: string;
  domains?: string[];
  scope?: "global" | "user";
  old_string?: string;
  new_string?: string;
}

/**
 * Créer ou corriger un mode d'emploi, pour la revue. On ne corrige qu'un mode d'emploi relu pendant cette revue
 * (`viewed`) : la règle de Hermes, qui évite d'écrire à côté de ce qui existe. `userId` absent : le curateur, qui ne
 * touche qu'à la bibliothèque partagée. Archiver (le curateur, après une fusion) ne supprime jamais. Rend un texte pour le modèle.
 */
export async function manageSkill(q: Q, userId: string | null, a: ManageArgs, viewed: Set<string>): Promise<string> {
  const name = String(a.name ?? "").trim().slice(0, 80);
  if (!name) return "erreur : nom manquant";
  if (a.scope === "user" && !userId) return "erreur : ici, seulement la bibliothèque partagée (scope global)";
  const scope = a.scope === "user" ? "user" : "global";
  const existing = (
    await q.query<Skill>(`SELECT * FROM skills WHERE lower(name) = lower($1) AND coalesce(user_id::text, '') = $2`, [name, scope === "user" ? userId : ""])
  ).rows[0];
  const domains = (a.domains ?? existing?.domains ?? []).map((d) => String(d).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")).filter(Boolean).slice(0, 8);

  if (a.action === "archive") {
    if (!existing) return `erreur : « ${name} » n'existe pas`;
    if (existing.status === "pending") return `erreur : « ${name} » attend l'accord d'un humain, n'y touche pas`;
    if (!viewed.has(name.toLowerCase())) return `erreur : relis d'abord « ${name} » avec skill_view, pour être sûr que ce qu'il apprend est repris ailleurs`;
    await q.query(`UPDATE skills SET status = 'archived', updated_at = now() WHERE id = $1`, [existing.id]);
    return `archivé : « ${name} » (récupérable dans /admin)`;
  }
  let body: string;
  let description = String(a.description ?? existing?.description ?? "").trim().slice(0, 240);
  if (a.action === "create") {
    if (existing) return `erreur : « ${name} » existe déjà ; relis-le (skill_view) puis corrige-le (patch)`;
    body = String(a.body ?? "").trim();
    if (!body || !description) return "erreur : il faut une description d'une ligne et un corps";
  } else {
    if (!existing) return `erreur : « ${name} » n'existe pas ; crée-le (create)`;
    if (!viewed.has(name.toLowerCase())) return `erreur : relis d'abord « ${name} » avec skill_view pendant cette revue, puis corrige à partir de ce qu'il dit`;
    if (a.action === "patch") {
      const from = String(a.old_string ?? "");
      if (!from || !existing.body.includes(from)) return "erreur : old_string doit être un passage exact du corps actuel";
      body = existing.body.replace(from, String(a.new_string ?? ""));
    } else body = String(a.body ?? "").trim();
  }
  if (body.length > MAX_BODY) return `erreur : corps trop long (${body.length} caractères, ${MAX_BODY} au plus) : garde les règles, pas le récit`;
  if (scope === "user" && !domains.length) {
    const others = Number(
      (
        await q.query<{ n: number }>(
          `SELECT coalesce(sum(length(description) + length(body)), 0)::int AS n FROM skills WHERE scope = 'user' AND user_id = $1 AND domains = '{}' AND status = 'active' AND lower(name) <> lower($2)`,
          [userId, name],
        )
      ).rows[0]?.n ?? 0,
    );
    if (others + description.length + body.length > PROFILE_BUDGET)
      return `erreur : ses leçons à elle tiennent en ${PROFILE_BUDGET} caractères (il y en a déjà ${others}, celle-ci en fait ${description.length + body.length}) : regroupe-les dans une seule (skill_view puis rewrite), plus courte, au lieu d'ajouter`;
  }
  if (scope === "global") {
    const leak = await personalLeak(q, userId, `${name}\n${description}\n${body}`);
    if (leak) return `refusé : un mode d'emploi partagé ne contient jamais ${leak}`;
  }
  // Un site : utile tout de suite. Une leçon de comportement pour tout le monde : attend l'accord dans /admin.
  const status = scope === "global" && !domains.length ? "pending" : "active";
  if (existing) {
    await q.query(`UPDATE skills SET description = $2, body = $3, domains = $4, version = version + 1, updated_at = now() WHERE id = $1`, [existing.id, description, body, domains]);
    return `corrigé : « ${name} » (version ${existing.version + 1})`;
  }
  await q.query(`INSERT INTO skills (scope, user_id, name, description, body, domains, status) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    scope,
    scope === "user" ? userId : null,
    name,
    description,
    body,
    domains,
    status,
  ]);
  return status === "pending" ? `créé en attente d'accord : « ${name} » (leçon de comportement partagée)` : `créé : « ${name} »`;
}
