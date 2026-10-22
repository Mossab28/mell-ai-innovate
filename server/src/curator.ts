import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Llm, ToolSpec } from "./llm.ts";
import { runReview, TOOLS } from "./review.ts";

type Q = Pick<Db, "query">;

/**
 * Le curateur (docs/SELF-IMPROVEMENT.md, étape 4, repris de agent/curator.py de Hermes Agent) : la bibliothèque des modes
 * d'emploi reste courte et juste au lieu de grossir d'un cas par travail. Deux passages :
 * - le cycle de vie, mécanique, à chaque heure : périmé après 14 jours sans usage ni correction, archivé après 30, jamais
 *   supprimé ; un mode d'emploi périmé sert encore quand le navigateur revient sur son site, et redevient actif ;
 * - une fois par semaine, quand rien ne tourne, le même modèle relit la bibliothèque partagée et fusionne ce qui sert la
 *   même classe de tâches (une seule règle par leçon, l'absorbé archivé).
 * Les leçons en attente d'accord (`pending`) et les modes d'emploi d'une personne ne sont jamais touchés ici.
 */

export const STALE_DAYS = 14;
export const ARCHIVE_DAYS = 30;
const EVERY_DAYS = 7;
/** En dessous, il n'y a rien à fusionner. */
const MIN_TO_CONSOLIDATE = 4;

// Dernière activité : un usage, ou une correction par la revue.
const ANCHOR = "greatest(coalesce(last_used_at, created_at), updated_at)";
// Ses leçons à elle sont lues à chaque message : elles ne vieillissent pas, elles se corrigent.
const AGES = "NOT (scope = 'user' AND domains = '{}')";

export async function applyTransitions(q: Q): Promise<{ stale: number; archived: number; reactivated: number }> {
  const archived = await q.query(
    `UPDATE skills SET status = 'archived' WHERE status IN ('active', 'stale') AND ${AGES} AND ${ANCHOR} < now() - make_interval(days => $1) RETURNING id`,
    [ARCHIVE_DAYS],
  );
  const stale = await q.query(`UPDATE skills SET status = 'stale' WHERE status = 'active' AND ${AGES} AND ${ANCHOR} < now() - make_interval(days => $1) RETURNING id`, [STALE_DAYS]);
  const reactivated = await q.query(`UPDATE skills SET status = 'active' WHERE status = 'stale' AND ${ANCHOR} >= now() - make_interval(days => $1) RETURNING id`, [STALE_DAYS]);
  return { stale: stale.rows.length, archived: archived.rows.length, reactivated: reactivated.rows.length };
}

export const CURATOR_SYSTEM = `Tu es le curateur des modes d'emploi de Mell, un assistant personnel qui agit pour les gens (réserver, acheter, chercher, écrire). Une fois par semaine, tu relis la bibliothèque partagée pour qu'elle reste courte et juste. Le but : des modes d'emploi par classe de tâches (réserver un restaurant, acheter un billet de train) et par site (TheFork, SNCF Connect), chacun avec ses règles toujours valables. Une pile de petits modes d'emploi nés chacun d'un seul travail est un échec : l'agent les trouve par leur description, et un seul mode d'emploi large avec des sous-parties se trouve mieux que cinq voisins.

Ce que tu fais :
- Repère les familles : mêmes mots dans le nom, même site, même classe de tâches (« reserver-restaurant » et « reservation-restaurant »). Pour chacune, demande-toi si un humain qui tient cette bibliothèque en écrirait un seul. Si oui, garde le plus large (ou crée-le), reprends-y ce que les autres apprennent, puis archive les autres.
- Fusionner, c'est distiller : chaque règle à l'impératif avec son pourquoi en une proposition ; une même leçon écrite deux fois devient une seule règle ; une règle contredite par une plus récente disparaît ; ni récit, ni date, ni prix du jour.
- Un site garde son mode d'emploi à son nom, avec son domaine. Une classe de tâches renvoie aux sites par leur nom au lieu de recopier leurs règles.
- Le nombre d'usages ne dit rien de la valeur : les compteurs sont jeunes. Juge sur le contenu.

Règles :
- Lis avant d'agir : skill_view sur chaque mode d'emploi que tu corriges ou archives (obligatoire).
- Archive (action archive) seulement ce qui est entièrement repris ailleurs. Tu ne supprimes jamais rien.
- Jamais de donnée personnelle (nom, mail, téléphone, carte, adresse) dans ce que tu écris.
- Ne retiens jamais « tel site ou tel outil ne marche pas » : retire ces phrases si tu en trouves, elles deviennent des refus.
- Ne touche pas aux leçons en attente d'accord (statut pending).

Méthode : skills_list, puis skill_view sur chaque famille, puis skill_manage. Termine par une ligne par geste (fusionné, corrigé, archivé). Si la bibliothèque est déjà propre, réponds exactement « Rien à faire. ».`;

const CURATOR_TOOLS: ToolSpec[] = TOOLS.map((t) =>
  t.name !== "skill_manage"
    ? t
    : {
        ...t,
        description: `${t.description} archive : retirer un mode d'emploi entièrement repris dans un autre (récupérable, jamais supprimé). Ici, seulement scope global.`,
        parameters: {
          ...t.parameters,
          properties: { ...(t.parameters as any).properties, action: { type: "string", enum: ["create", "patch", "rewrite", "archive"] } },
        },
      },
);

/** La fusion par le modèle, sur la bibliothèque partagée. Rend son dernier mot (ce qu'il a fait). */
export async function consolidate(db: Q, cfg: Pick<Config, "models">, llm: Llm): Promise<string | undefined> {
  const n = Number(
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM skills WHERE scope = 'global' AND status IN ('active', 'stale')`)).rows[0]?.n ?? 0,
  );
  if (n < MIN_TO_CONSOLIDATE) return "Rien à faire.";
  return runReview(db, cfg, llm, null, `La bibliothèque partagée compte ${n} modes d'emploi actifs ou périmés. Relis-la et range-la.`, {
    system: CURATOR_SYSTEM,
    tools: CURATOR_TOOLS,
    steps: 30,
  });
}

/**
 * Le passage horaire : le cycle de vie toujours ; la fusion si la dernière date d'au moins une semaine et qu'aucun travail
 * de fond n'a tourné depuis 10 minutes (le curateur ne prend pas le modèle à quelqu'un qui attend). `force` : depuis /admin.
 */
export async function runCurator(db: Q, cfg: Pick<Config, "models" | "llm">, llm: Llm, force = false): Promise<{ transitions: Awaited<ReturnType<typeof applyTransitions>>; consolidated?: string }> {
  const transitions = await applyTransitions(db);
  if (cfg.llm === "fake" && !force) return { transitions };
  if (!force && (await db.query(`SELECT 1 FROM jobs WHERE status = 'running' OR finished_at > now() - interval '10 minutes' LIMIT 1`)).rows.length) return { transitions };
  const claimed = (
    await db.query(
      `INSERT INTO maintenance (name, last_run_at) VALUES ('curator', now())
       ON CONFLICT (name) DO UPDATE SET last_run_at = now() WHERE maintenance.last_run_at < now() - make_interval(days => $1) OR $2
       RETURNING name`,
      [EVERY_DAYS, force],
    )
  ).rows.length > 0;
  if (!claimed) return { transitions };
  return { transitions, consolidated: await consolidate(db, cfg, llm) };
}
