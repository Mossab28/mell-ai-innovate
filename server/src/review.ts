import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { ChatMessage, Llm, ToolSpec } from "./llm.ts";
import { formatSkill, listSkills, manageSkill, viewSkill, type ManageArgs } from "./skills.ts";
import { coerceArgs, parseArgs, resolveToolName } from "./tool-args.ts";

type Q = Pick<Db, "query">;

/**
 * La revue après un travail de fond : le même modèle relit ce qui vient de se passer et met à jour les modes d'emploi,
 * pour que la prochaine fois l'erreur ne revienne pas. Adapté des consignes de revue de Hermes Agent
 * (agent/background_review.py) : des leçons, pas un journal ; ne jamais retenir une panne passagère ni « tel outil ne
 * marche pas » ; relire avant de corriger.
 */

export const REVIEW_SYSTEM = `Tu es la revue de Mell, un assistant personnel qui agit pour les gens (réserver, acheter, chercher, écrire). Tu relis un travail qu'il vient de faire et tu mets à jour ses modes d'emploi, pour que la prochaine fois il fasse juste du premier coup. Sois actif : la plupart des travaux apprennent au moins une petite chose.

Ce qu'est un mode d'emploi : la meilleure façon de faire une classe de tâches ou de mener un site (SNCF Connect, TheFork, Doctolib, Booking, une boutique). Une ligne de description, puis :
- Quand s'en servir.
- Marche à suivre : les étapes dans l'ordre, avec les écrans, champs et boutons qui comptent, et les points de décision.
- Pièges : chacun est une règle générale à l'impératif, plus le pourquoi en une proposition (« Choisis la gare dans les suggestions, pas un lieu du même nom : la recherche partirait d'un café, à pied, sans prix. »).
- Vérifier : comment savoir que c'est réussi.

Règles d'écriture :
- Des leçons, pas un journal : ni date, ni nom de personne, ni prix du jour, ni récit de ce qui s'est passé. La règle doit tenir sans l'histoire.
- Une même leçon apprise deux fois reste une seule règle : renforce ou précise celle qui existe.
- Un mode d'emploi faux se corrige à la phrase qui trompait ; jamais « en fait... » ajouté en dessous.
- Un site = un mode d'emploi à son nom, avec son domaine dans domains. Une classe de tâches (réserver un restaurant) porte dans domains les sites où elle passe : le navigateur la relit en y arrivant. Une leçon sur la façon de se comporter avec les gens (parler moins, ne pas redemander) va dans un mode d'emploi sans domaine : partagée, elle attend l'accord d'un humain avant de servir.
- Un mode d'emploi partagé (scope global) ne contient jamais rien de la personne : ni nom, ni mail, ni téléphone, ni numéro de carte, ni adresse. Sa façon de faire à elle (ses préférences, ses reprises) va en scope user, sans domaine : Mell la lit en entier à chaque message, elle tient en 2500 caractères pour tout, alors garde un seul mode d'emploi pour elle et corrige-le au lieu d'en ajouter un autre.

Ce qui mérite une mise à jour :
- La personne l'a repris sur sa méthode ou sa façon de parler (« non, ma carte bancaire », « tout stop », « trop de messages », « ça n'a aucun sens »).
- Un obstacle sur un site a été franchi par une voie qui marche (le bon champ, le bon bouton, l'ordre qui passe).
- Un mode d'emploi relu pendant ce travail s'est révélé faux ou incomplet : corrige-le maintenant.

Ne retiens jamais :
- « Tel outil ou tel site ne marche pas » : ces phrases deviennent des refus pendant des mois, longtemps après que le problème a disparu.
- Une panne passagère (page lente, session perdue, réseau) : si réessayer a marché, la leçon est la reprise, pas la panne.
- Un blocage anti-robot ou un échec non résolu présenté comme méthode : sans voie qui marche, ne retiens rien.
- Une tâche unique sans classe derrière.

Méthode : skills_list pour voir ce qui existe ; skill_view avant de corriger un mode d'emploi existant (obligatoire) ; skill_manage pour créer ou corriger. S'il n'y a vraiment rien à apprendre, réponds exactement « Rien à retenir. ».`;

export const TOOLS: ToolSpec[] = [
  { name: "skills_list", description: "Les modes d'emploi existants : nom, description, domaines, statut.", parameters: { type: "object", properties: {} } },
  { name: "skill_view", description: "Lire un mode d'emploi en entier (obligatoire avant de le corriger).", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  {
    name: "skill_manage",
    description:
      "Créer (create : name, description, body, domains, scope) ou corriger un mode d'emploi : patch (old_string = passage exact du corps actuel, new_string = son remplacement) ou rewrite (body entier). scope = global (partagé, rien de personnel) ou user (sa façon de faire à elle). domains = sites concernés (sncf-connect.com).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "patch", "rewrite"] },
        name: { type: "string" },
        description: { type: "string" },
        body: { type: "string" },
        domains: { type: "array", items: { type: "string" } },
        scope: { type: "string", enum: ["global", "user"] },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["action", "name"],
    },
  },
];

/** Ce qui s'est passé pendant un travail : la demande, ce qu'elle a écrit, les outils et leurs résultats, la réponse. */
async function transcript(q: Q, job: { id: string; user_id: string; request: string; created_at: Date; result?: string | null }): Promise<string> {
  const msgs = (
    await q.query<{ direction: string; text: string | null }>(
      `SELECT direction, text FROM messages WHERE user_id = $1 AND sent_at > $2::timestamptz - interval '20 minutes' AND text IS NOT NULL ORDER BY id LIMIT 40`,
      [job.user_id, job.created_at],
    )
  ).rows;
  const tools = (
    await q.query<{ name: string; args: string; result: string }>(
      `SELECT name, left(args, 600) AS args, left(result, 1500) AS result FROM tool_calls WHERE user_id = $1 AND created_at >= $2 AND name <> 'progress' ORDER BY id LIMIT 40`,
      [job.user_id, job.created_at],
    )
  ).rows;
  const runs = (
    await q.query<{ status: string; reason: string | null; answer: string | null; pages: string }>(
      `SELECT status, left(reason, 600) AS reason, left(answer, 800) AS answer, pages::text AS pages FROM browser_runs WHERE user_id = $1 AND created_at >= $2 ORDER BY created_at LIMIT 10`,
      [job.user_id, job.created_at],
    )
  ).rows;
  return [
    `Demande du travail : ${job.request.slice(0, 1500)}`,
    `Le fil autour (Personne / Mell) :\n${msgs.map((m) => `${m.direction === "in" ? "Personne" : "Mell"} : ${String(m.text).slice(0, 400)}`).join("\n")}`,
    `Outils appelés et résultats :\n${tools.map((t) => `- ${t.name} ${t.args} => ${t.result}`).join("\n") || "aucun"}`,
    runs.length ? `Passages du navigateur :\n${runs.map((r) => `- ${r.status} ${r.reason ?? ""} ${r.answer ?? ""} pages ${r.pages.slice(0, 300)}`).join("\n")}` : "",
    job.result ? `Réponse finale de Mell : ${job.result.slice(0, 800)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** La revue d'un travail terminé. Ne lève jamais : apprendre ne doit pas casser le service. Rend le dernier mot du modèle. */
export async function reviewJob(db: Q, cfg: Pick<Config, "models">, llm: Llm, job: { id: string; user_id: string; request: string; created_at: Date; result?: string | null }): Promise<string | undefined> {
  try {
    return await runReview(db, cfg, llm, job.user_id, await transcript(db, job));
  } catch {
    return undefined;
  }
}

/**
 * La revue d'une conversation qui s'est calmée : ce qu'elle a écrit depuis la dernière revue, ce que Mell a répondu et
 * fait. C'est là que ses corrections deviennent des leçons (« non, ma carte bancaire », « trop de messages »).
 */
export async function reviewConversation(db: Q, cfg: Pick<Config, "models">, llm: Llm, userId: string, since: Date): Promise<string | undefined> {
  try {
    const msgs = (
      await db.query<{ direction: string; text: string | null }>(
        `SELECT direction, text FROM messages WHERE user_id = $1 AND sent_at > $2 AND text IS NOT NULL ORDER BY id LIMIT 80`,
        [userId, since],
      )
    ).rows;
    if (!msgs.some((m) => m.direction === "in")) return undefined;
    const tools = (
      await db.query<{ name: string; args: string; result: string }>(
        `SELECT name, left(args, 400) AS args, left(result, 800) AS result FROM tool_calls WHERE user_id = $1 AND created_at > $2 AND name <> 'progress' ORDER BY id LIMIT 40`,
        [userId, since],
      )
    ).rows;
    const text = [
      "Une conversation qui vient de se calmer. Regarde d'abord si elle a repris Mell (sa méthode, sa façon de parler, le nombre de messages) : chaque reprise est une leçon, sa façon à elle en scope user.",
      `Le fil (Personne / Mell) :\n${msgs.map((m) => `${m.direction === "in" ? "Personne" : "Mell"} : ${String(m.text).slice(0, 400)}`).join("\n")}`,
      `Outils appelés et résultats :\n${tools.map((t) => `- ${t.name} ${t.args} => ${t.result}`).join("\n") || "aucun"}`,
    ].join("\n\n");
    return await runReview(db, cfg, llm, userId, text);
  } catch {
    return undefined;
  }
}

/**
 * La boucle de revue, commune à la revue d'un travail, d'une conversation et au curateur. `userId` absent : le curateur,
 * qui ne voit et ne touche que la bibliothèque partagée.
 */
export async function runReview(
  db: Q,
  cfg: Pick<Config, "models">,
  llm: Llm,
  userId: string | null,
  material: string,
  o: { system?: string; tools?: ToolSpec[]; steps?: number } = {},
): Promise<string | undefined> {
  const viewed = new Set<string>();
  const messages: ChatMessage[] = [
    { role: "system", content: o.system ?? REVIEW_SYSTEM },
    { role: "user", content: material },
  ];
  for (let step = 0; step < (o.steps ?? 8); step++) {
    const reply = await llm.chat({ model: cfg.models.task, purpose: "review", messages, tools: o.tools ?? TOOLS, maxTokens: 2000, signal: AbortSignal.timeout(90_000) });
    if (!reply.toolCalls.length) return reply.text ?? undefined;
    messages.push({ role: "assistant", content: reply.text, tool_calls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      let out: string;
      try {
        const tools = o.tools ?? TOOLS;
        const name = resolveToolName(call.function.name, tools.map((t) => t.name)) ?? call.function.name;
        const a = coerceArgs(tools.find((t) => t.name === name), parseArgs(call.function.arguments) ?? {}) as any;
        if (name === "skills_list") {
          const all = (
            await db.query<{ name: string; description: string; domains: string[]; status: string; scope: string; uses: number; last_used_at: Date | null; created_at: Date }>(
              `SELECT name, description, domains, status, scope, uses, last_used_at, created_at FROM skills WHERE status <> 'archived' AND (scope = 'global' OR user_id = $1) ORDER BY lower(name) LIMIT 80`,
              [userId],
            )
          ).rows;
          const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : "jamais");
          out = all.length
            ? all.map((s) => `- ${s.name} [${s.scope}, ${s.status}, ${s.uses} usages, dernier ${day(s.last_used_at)}, créé ${day(s.created_at)}] : ${s.description}${s.domains.length ? ` (${s.domains.join(", ")})` : ""}`).join("\n")
            : "aucun mode d'emploi pour l'instant";
        } else if (name === "skill_view") {
          const s = await viewSkill(db, userId, String(a.name ?? ""), { count: false });
          if (s) viewed.add(s.name.toLowerCase());
          out = s ? formatSkill(s) : "introuvable";
        } else if (name === "skill_manage") {
          out = await manageSkill(db, userId, a as ManageArgs, viewed);
        } else out = "outil inconnu";
      } catch (e) {
        out = `erreur : ${e instanceof Error ? e.message : String(e)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: out });
    }
  }
  return undefined;
}

/**
 * Les conversations calmées depuis au moins 10 minutes (et de moins de 6 heures) qui n'ont pas encore été relues.
 * Deux au plus par passage ; la date de relecture est posée avant, pour ne jamais relire deux fois la même chose.
 */
export async function reviewQuietConversations(db: Q, cfg: Pick<Config, "models">, llm: Llm): Promise<number> {
  const candidates = (
    await db.query<{ id: string; last_in: Date; reviewed_at: Date | null }>(
      `SELECT u.id, l.last_in, u.reviewed_at FROM users u
       JOIN (SELECT user_id, max(sent_at) AS last_in FROM messages WHERE direction = 'in' GROUP BY user_id) l ON l.user_id = u.id
       WHERE l.last_in < now() - interval '10 minutes' AND l.last_in > now() - interval '6 hours'
         AND (u.reviewed_at IS NULL OR u.reviewed_at < l.last_in)
       ORDER BY l.last_in LIMIT 2`,
    )
  ).rows;
  let n = 0;
  for (const c of candidates) {
    // La date de relecture est posée avant : jamais deux revues pour la même conversation.
    const claimed = await db.query(`UPDATE users SET reviewed_at = now() WHERE id = $1 AND (reviewed_at IS NULL OR reviewed_at < $2) RETURNING id`, [c.id, c.last_in]);
    if (!claimed.rows.length) continue;
    n++;
    await reviewConversation(db, cfg, llm, c.id, c.reviewed_at ? new Date(c.reviewed_at) : new Date(Date.now() - 6 * 3_600_000));
  }
  return n;
}

export { listSkills };
