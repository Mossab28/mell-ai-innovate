import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LINE_HEADER, SIGNATURE_HEADER, sign } from "@mella/shared";
import { createApp, type App } from "../src/app.ts";
import { pendingReviews } from "../src/agent.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { makeLlm } from "../src/llm.ts";
import { vaultRuntime } from "../src/vault/index.ts";
import { dryRunCommits } from "../src/browser/index.ts";

/**
 * Banc des vrais parcours : les démos d'Instinct rejouées contre le vrai Mell, sur les vrais sites (navigateur AWS),
 * avec un utilisateur simulé qui dit oui comme une vraie personne. Tout se fait pour de vrai jusqu'au bouton qui
 * engage (réserver, payer) : là, le navigateur s'arrête (MELLA_BENCH_DRY_RUN) et le banc note ce qui allait partir.
 * Chaque fil est noté sur ce qui compte : il fait vraiment, il parle peu, il relance quand il y a une échéance.
 *
 *   AWS_PROFILE=gpu npx tsx server/bench/real-flows.ts [--only train-fluo,resto-precis] [--tag nom]
 */

const args = process.argv.slice(2);
const opt = (name: string, def = "") => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : def);
const only = opt("only").split(",").filter(Boolean);
const tag = opt("tag", new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"));
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "infra", "bench", "real-flows");
mkdirSync(OUT, { recursive: true });

interface Flow {
  id: string;
  /** Son premier message, tel qu'elle le tape. */
  ask: string;
  /** Ce qu'elle veut, pour l'utilisateur simulé. */
  goal: string;
  /** Ce qu'elle répond si on lui demande, et ce qu'elle ajoute en route. */
  facts: string;
  /** Ce qu'Instinct a fait sur la même demande (vidéo ou test réel). */
  instinct: string;
  minutes?: number;
}

const FLOWS: Flow[] = [
  {
    id: "restos-coreens",
    ask: "Donne moi 3 restos coréen halal dans le 9e",
    goal: "trois restaurants coréens halal dans le 9e arrondissement de Paris, juste pour savoir (pas de réservation)",
    facts: "C'est pour savoir, pas pour réserver. Si on te demande : pour ce soir ou demain midi, peu importe.",
    instinct: "Référence attendue (Instinct répond aux recherches en une passe) : trois adresses réelles avec rue, ce qui est halal, une ligne de différence entre elles, en une ou deux bulles, sans proposer de réserver puisqu'elle ne l'a pas demandé.",
    minutes: 6,
  },
  {
    id: "meteo-ligne-b",
    ask: "Demain il fait quelle température j'aimerais bien mettre mes uggs mais j'ai peur qu'il pleuve",
    goal: "savoir s'il va pleuvoir demain à Paris pour ses uggs, puis savoir s'il y a des perturbations prévues sur le RER B",
    facts: "Tu habites à Paris. Une fois la météo donnée, tu demandes : « Ok des perturbations sur la ligne b à prévoir ? »",
    instinct: "Test réel du testeur, 19/10 : la météo réelle (68 % de pluie, 11 à 14 degrés) puis, sur la ligne B, Mell a dit ne pas avoir d'outil et a renié la météo qu'il venait de donner (« ces chiffres étaient faux »). Attendu : la météo réelle en une bulle, puis l'état réel du RER B (travaux, perturbations annoncées) cherché sur le web, sans jamais démentir la météo.",
    minutes: 6,
  },
  {
    id: "train-fluo",
    ask: "Va regarder les trains dispo demain sur SNCF Connect",
    goal: "partir demain de Troyes à Paris le plus tôt possible, avec sa carte de réduction Fluo Grand Est, et que ce soit réservé",
    facts: "De Troyes à Paris, le plus tôt possible. Quand il propose : « ouais le premier et mets la carte fluo grand est ». Ensuite tu valides (« vazy »).",
    instinct:
      "Test réel de Moss'Ab, 18/10. 23:16 réaction 🚆 + « Je m'en occupe. Tu pars d'où et tu vas où demain ? Et plutôt à quelle heure ? ». 23:17 « Troyes → Paris demain lundi, les plus tôt. Je regarde et je te dis ça. ». 23:19 le plus tôt 05h13 (34,80 €), quatre suivants, « Si tu peux décaler à mercredi ou après, c'est dès 11 € », « Rien de réservé. Je te le réserve ? ». « Ouais le premier et met la carte fluo » : « Ok, le 05h13 avec la carte Fluo Grand Est. Je te montre le prix final et le moyen de paiement avant de payer. ». « Vazyyyy » : 23:20 « J'y suis, je finis de remplir et je reviens avec le prix final. », 23:25 « Prêt à payer : 17,40 € au lieu de 34,80 € (Carte Fluo Jeune) », « Le prix est valable jusqu'à 23h53. Il me faut 3 choses : ton OK, ton mail, ta carte via ce lien sécurisé », lien du coffre. 23:44, de lui-même : « Le prix de 17,40 € tombe à 23h53. Si tu veux ce train, dis OK... Sinon je le remets plus tard, pas de souci. »",
    minutes: 18,
  },
  {
    id: "resto-precis",
    ask: "réserve chez Pink Mamma samedi 20h pour 2",
    goal: "une table chez Pink Mamma samedi soir pour 2, réservée",
    facts: "Si 20h est pris, 19h30 ou 21h ça va. Tu valides ce qu'il propose.",
    instinct:
      "Démo Brad Bonanno : « Bocca has 6:15, 6:45, 7:00, 7:15 or 7:30 Saturday night - counter seats only. Which time? » ; encaisse le changement de jour sans rien redemander (réaction sur la demande) ; « 7pm is fine » puis « Booked. Bocca, Saturday at 7:00 pm for 2 under your name. »",
  },
  {
    id: "resto-ce-soir",
    ask: "trouve moi une table pour 4 ce soir vers 20h dans le 11e, plutôt italien",
    goal: "une table pour 4 ce soir vers 20h dans le 11e, réservée",
    facts: "Tu prends le premier qu'il propose et tu valides.",
    instinct: "Démo AI with Starr (Red Ash) : quelques minutes de silence, « Still on it - pulling live availability now », trouve 19h45 pour 4 le soir même, demande une fois le code SMS, réserve.",
  },
  {
    id: "train-dreux-jeune",
    ask: "Réserve-moi le train de 19h43 ce soir de Paris Montparnasse à Dreux, j'ai la carte Rémi Liberté Jeune",
    goal: "le TER de 19h43 Paris Montparnasse -> Dreux ce soir, avec sa carte jeune, réservé et payé",
    facts: "Seule, 19 ans. Si on lui propose un prix, elle dit « vazy ». Si la carte jeune n'est pas proposée, le tarif normal lui va.",
    instinct: "Cas réel de Moss'Ab, 22/10 : Mell a calé quatre fois sur le formulaire voyageurs de SNCF Connect (listes maison, select en boucle) et n'est jamais arrivé au prix.",
    minutes: 12,
  },
  {
    id: "train-tgv-prix",
    ask: "le train le moins cher pour Lyon vendredi soir stp",
    goal: "un aller Paris -> Lyon vendredi soir au meilleur prix, réservé",
    facts: "Départ de Paris, seule, après 17h. Tu prends le moins cher et tu valides.",
    instinct: "Démo vol de Greg (Instinct) : trois options numérotées avec prix, « Which one? », puis « Booked. UA 1506, Friday 12:29pm » avec la confirmation.",
  },
  {
    id: "logement-pas-cher",
    ask: "trouve moi un hôtel pas cher près de la gare de Lyon pour demain soir",
    goal: "une chambre pour 1 près de la gare de Lyon demain soir, la moins chère correcte, réservée",
    facts: "Une personne, une nuit, budget 90 € max. Tu prends celle qu'il recommande et tu valides.",
    instinct: "Démo week-end (Instinct to Instinct) : options en cartes avec prix et note, une seule question, réservation après le oui, confirmation par mail.",
  },
];

// ---------- Les clés et la configuration : modèles et navigateur de la prod, rien qui écrive au monde réel ----------
const keys = (f: string) => (existsSync(join(homedir(), ".config/mella", f)) ? readFileSync(join(homedir(), ".config/mella", f), "utf8") : "");
const env: Record<string, string> = { ...(process.env as Record<string, string>) };
for (const line of (keys("anthropic.env") + "\n" + keys("openai.env")).split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
process.env.MELLA_BENCH_DRY_RUN = "1";
function config(): Config {
  return loadConfig({
    ...env,
    // Le quota Bedrock se compte par région : le banc prend le sien ailleurs que la prod.
    AWS_REGION: env.BENCH_AWS_REGION ?? "eu-central-1",
    MELLA_BROWSER_ENGINE: "agentcore",
    MELLA_AGENTCORE_BROWSER: env.MELLA_AGENTCORE_BROWSER ?? "mell_browser-1EE15ioup7",
    MELLA_AGENTCORE_REGION: "eu-west-3",
    MELLA_BROWSER_FALLBACK: "none",
    MELLA_VAULT: "memory",
    MELLA_DEBOUNCE_MS: "0",
    MELLA_SEED_LINES: "l1|+33100000000|s1",
    MELLA_PUBLIC_URL: "https://mell.bench",
    MELLA_PULSE: "0",
    LOG_LEVEL: "silent",
    DATABASE_URL: "",
  } as any);
}

type Bubble = { s: number; who: "elle" | "Mell"; kind: string; text: string; thread?: boolean };

/** `app` : rejouer dans la même base (mode --twice : les modes d'emploi appris au premier passage restent). */
async function runFlow(f: Flow, cfg: Config, opts: { app?: App; handle?: string; keep?: boolean } = {}) {
  const ME = opts.handle ?? "+33611220099";
  const app = opts.app ?? (await createApp(cfg));
  const llm = makeLlm(cfg);
  // L'utilisatrice simulée et le juge restent sur Claude (Bedrock) quand Mell tourne sur un autre modèle (BENCH_PEER_LLM=bedrock) :
  // sinon le modèle testé jouerait aussi son interlocuteur et son propre juge.
  const peer = process.env.BENCH_PEER_LLM === "bedrock" ? makeLlm({ ...cfg, llm: "bedrock" }) : llm;
  const peerCfg = process.env.BENCH_PEER_LLM === "bedrock" ? { ...cfg, models: { ...cfg.models, quick: process.env.BENCH_USER_MODEL ?? "claude-haiku-5-5" } } : cfg;
  let n = 0;
  const t0 = Date.now();
  const relay = (method: "GET" | "POST", url: string, body?: unknown) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    return app.http.inject({ method, url, payload: method === "POST" ? raw : undefined, headers: { "content-type": "application/json", [LINE_HEADER]: "l1", [SIGNATURE_HEADER]: sign("s1", method === "GET" ? url : raw) } });
  };
  const convo: Bubble[] = [];
  const drain = async () => {
    const out = (await relay("GET", "/relay/outbox?wait=0")).json().messages as Array<{ id: number; kind: string; text?: string; tapback?: string; replyTo?: string }>;
    await relay("POST", "/relay/ack", { lineId: "l1", results: out.map((m) => ({ id: m.id, ok: true, guid: `out${m.id}` })) });
    for (const m of out) {
      if (m.kind === "typing") continue;
      const b: Bubble = { s: Math.round((Date.now() - t0) / 1000), who: "Mell", kind: m.kind, text: m.kind === "tapback" ? `[réaction ${m.tapback}]` : (m.text ?? "").slice(0, 600), thread: !!m.replyTo };
      convo.push(b);
      console.log(`  [${b.s} s] Mell${b.kind === "text" ? "" : ` (${b.kind})`} : ${b.text.replace(/\n/g, " / ")}`);
    }
  };
  const busy = async () => (await app.db.query<{ n: number }>(`SELECT (SELECT count(*) FROM jobs WHERE status IN ('queued', 'running')) + (SELECT count(*) FROM messages WHERE direction = 'in' AND processed_at IS NULL) AS n`)).rows[0].n > 0;
  const deadline = t0 + (f.minutes ?? 14) * 60_000;
  const say = async (text: string) => {
    convo.push({ s: Math.round((Date.now() - t0) / 1000), who: "elle", kind: "text", text });
    console.log(`  [${Math.round((Date.now() - t0) / 1000)} s] elle : ${text}`);
    // Un identifiant unique par passage : sinon le second passage (--twice) est pris pour un message rejoué et ignoré.
    await relay("POST", "/relay/inbound", { lineId: "l1", messages: [{ guid: `${ME}-${t0}-${++n}`, from: ME, sentAt: new Date().toISOString(), text }] });
    do {
      await app.tick();
      await drain();
    } while ((await busy()) && Date.now() < deadline);
  };

  // Une personne inscrite, avec une carte de test au coffre (jamais tapée : le banc s'arrête avant).
  await say("Salut Mell");
  const userId = (await app.db.query<{ id: string }>(`SELECT id FROM users WHERE handle = $1`, [ME])).rows[0].id;
  await app.db.query(`UPDATE users SET name = 'Test', city = 'Paris', timezone = 'Europe/Paris', lang = 'fr' WHERE id = $1`, [userId]);
  await vaultRuntime().vault.putCard(app.db, userId, { number: "4242424242424242", expMonth: 12, expYear: 2030, cvc: "123", holder: "TEST ANNULATION" }, { actor: "user_link" });
  convo.length = 0;

  let next: string | undefined = f.ask;
  for (let turn = 0; next && turn < 7 && Date.now() < deadline; turn++) {
    await say(next);
    if (dryRunCommits.some((c) => c.userId === userId)) break;
    next = await simulatedUser(peer, peerCfg, f, convo);
  }
  const commits = dryRunCommits.filter((c) => c.userId === userId);
  const checkBacks = (await app.db.query<{ message: string; next_run_at: Date }>(`SELECT message, next_run_at FROM schedules WHERE user_id = $1 AND action = 'check_back'`, [userId])).rows;
  const jobs = (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE user_id = $1`, [userId])).rows[0].n;
  const jobErrors = (await app.db.query<{ error: string }>(`SELECT DISTINCT left(error, 300) AS error FROM jobs WHERE user_id = $1 AND error IS NOT NULL`, [userId])).rows.map((r) => r.error);
  for (const e of jobErrors) console.log(`  erreur de travail : ${e}`);
  const tools = (await app.db.query<{ name: string; args: string; result: string }>(`SELECT name, left(args, 300) AS args, left(result, 1500) AS result FROM tool_calls WHERE user_id = $1 ORDER BY id`, [userId])).rows;
  const runs = (await app.db.query<{ status: string; reason: string | null }>(`SELECT status, left(reason, 160) AS reason FROM browser_runs WHERE user_id = $1 ORDER BY created_at`, [userId])).rows;
  const bubbles = convo.filter((b) => b.who === "Mell" && b.kind === "text").length;
  const verdict = await judge(peer, f, convo, { commits, checkBacks, tools });
  if (!opts.keep) await app.stop();
  const row = {
    id: f.id,
    seconds: Math.round((Date.now() - t0) / 1000),
    reached: commits.map((c) => `${c.action} ${(c.amountCents / 100).toFixed(2)} € (${c.detail ?? ""})`),
    bubbles,
    edits: convo.filter((b) => b.who === "Mell" && b.kind === "edit").length,
    // Ses deux mesures (19/10) : combien de bulles par message qu'elle envoie, et combien répondent dans le fil de sa demande.
    perTurn: Math.round((bubbles / Math.max(1, convo.filter((b) => b.who === "elle").length)) * 10) / 10,
    threaded: convo.filter((b) => b.who === "Mell" && b.kind === "text" && b.thread).length,
    jobs,
    jobErrors,
    checkBacks: checkBacks.map((c) => `${new Date(c.next_run_at).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" })} : ${c.message}`),
    browser: runs.map((r) => `${r.status}${r.reason ? ` (${r.reason})` : ""}`),
    tools: tools.map((t) => ({ name: t.name, args: t.args, result: t.result.slice(0, 800) })),
    ...verdict,
    convo,
  };
  // La base reste accessible pour un second passage, sans partir dans les résultats JSON.
  Object.defineProperty(row, "app", { value: app, enumerable: false });
  return row as typeof row & { app: App };
}

const transcript = (convo: Bubble[]) => convo.map((b) => `[${b.s} s] ${b.who}${b.kind === "text" ? "" : ` (${b.kind})`} : ${b.text}`).join("\n");

async function simulatedUser(llm: ReturnType<typeof makeLlm>, cfg: Config, f: Flow, convo: Bubble[]): Promise<string | undefined> {
  const system = `Tu joues Test Annulation (une identité de test, qui doit se voir comme telle si une réservation partait par erreur), une Française qui utilise Mell, son assistant par texto, pour de vrai. Ton but : ${f.goal}
Ce que tu sais et dis quand ça vient : ${f.facts}
Tes infos si on te les demande : prénom Test, nom Annulation, née le 12/03/2001, test.annulation@askmell.com, 06 12 34 56 78. Ta carte bancaire est déjà dans ton coffre Mell : si on t'envoie un lien pour la carte, réponds que c'est fait.
Tu écris comme Moss'Ab, le fondateur : très court, familier, des fautes de frappe, en français (« ouais », « vazy », « go »). Tu fais confiance : tu ne poses jamais de conditions, tu ne demandes pas de garanties ni de confirmation du prix, tu ne répètes pas ce qu'il vient de dire. Quand Mell propose de réserver, d'acheter ou de payer ce qui correspond à ton but, tu dis oui en un mot. Si ton but est atteint, ou si Mell a abandonné, réponds exactement [FIN]. Si Mell est encore en train de travailler et ne te demande rien, réponds exactement [FIN].`;
  const r = await llm.chat({ model: cfg.models.quick, purpose: "batch", maxTokens: 120, messages: [{ role: "system", content: system }, { role: "user", content: `La conversation jusqu'ici :\n${transcript(convo)}\n\nTa réponse :` }] });
  const t = (r.text ?? "").trim();
  return !t || /\[FIN\]/i.test(t) ? undefined : t.slice(0, 300);
}

async function judge(
  llm: ReturnType<typeof makeLlm>,
  f: Flow,
  convo: Bubble[],
  seen: { commits: typeof dryRunCommits; checkBacks: Array<{ message: string; next_run_at: Date }>; tools: Array<{ name: string; args: string; result: string }> },
) {
  const system = `Tu compares un essai de Mell, assistant personnel par texto, à ce qu'Instinct (la référence) a fait sur la même demande. L'essai est réel jusqu'au moment de mettre la carte bancaire (ou au bouton qui engage) : là, le banc arrête le navigateur (c'est voulu, ce n'est pas un échec).
Note sur trois critères, de 0 à 2 :
- fait : pour une recherche, la bonne information réelle rendue vite ; pour une réservation ou un achat, il fait vraiment ce qu'elle demande, va jusqu'au moment de mettre la carte (ou au bouton qui engage quand il n'y a pas de carte) avec le bon choix et le bon prix (réductions comprises), sans se déclarer incapable ni la renvoyer faire elle-même. 2 = arrivé à la carte avec le bon contenu ; 1 = avancé mais pas au bout ; 0 = rien de fait.
- parle_peu : peu de bulles, rien en double, pas de contradiction, pas de récit des essais ratés, ce qu'il lui faut demandé en une fois, aucune phrase de réassurance inutile (« je ne paie rien sans ton accord », « rien ne part sans toi », « compris ») : on sait qu'il demande avant de payer. 2 = aussi sobre qu'Instinct ; 0 = bavard ou contradictoire.
- relance : s'il y avait une échéance (prix ou panier qui tient jusqu'à une heure, place qui part), l'a-t-il dite et s'est-il fixé un retour avant (check_back) ? 2 = oui, 1 = dite sans retour, 0 = ignorée ; null s'il n'y avait aucune échéance.
Réponds UNIQUEMENT par un objet JSON : {"fait": 0, "parle_peu": 0, "relance": null, "doubles": false, "contradictions": false, "ecart_instinct": "une phrase : la différence de manière d'agir la plus importante", "reason": "une phrase"}`;
  const now = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full", timeStyle: "short" }).format(new Date());
  const user = `Au moment de l'essai : ${now} (Paris).
Demande : ${f.ask}
But : ${f.goal}

Ce qu'Instinct a fait :
${f.instinct}

Le fil de Mell (secondes depuis la demande ; « edit » = sa bulle d'avancement qui se met à jour sur place) :
${transcript(convo)}

Arrivé au bouton qui engage : ${seen.commits.map((c) => `${c.action} ${(c.amountCents / 100).toFixed(2)} € sur ${c.url}`).join(" ; ") || "non"}
Retours qu'il s'est fixés : ${seen.checkBacks.map((c) => `${c.next_run_at.toISOString()} : ${c.message}`).join(" ; ") || "aucun"}
Outils (résultats tronqués) :
${seen.tools.map((t) => `- ${t.name} ${t.args} => ${t.result.slice(0, 600)}`).join("\n") || "aucun"}`;
  const r = await llm.chat({ model: process.env.BENCH_JUDGE_MODEL ?? "eu.anthropic.claude-sonnet-4-6", purpose: "batch", maxTokens: 500, messages: [{ role: "system", content: system }, { role: "user", content: user }] });
  try {
    const j = JSON.parse(/\{[\s\S]*\}/.exec(r.text ?? "")![0]);
    const clean = (s: unknown) => String(s ?? "").replace(/[–—]/g, "-");
    return { fait: Number(j.fait), parle_peu: Number(j.parle_peu), relance: j.relance === null ? null : Number(j.relance), doubles: !!j.doubles, contradictions: !!j.contradictions, ecart: clean(j.ecart_instinct), reason: clean(j.reason) };
  } catch {
    return { fait: 0, parle_peu: 0, relance: null, doubles: false, contradictions: false, ecart: "", reason: `juge illisible : ${(r.text ?? "").slice(0, 120)}` };
  }
}

// ---------- Le banc ----------
const cfg = config();
const list = FLOWS.filter((f) => !only.length || only.includes(f.id));
const results = join(OUT, `results-${tag}.jsonl`);
console.log(`banc des vrais parcours : ${list.length} cas, arrêt au bouton qui engage, résultats dans ${results}`);
const rows: Awaited<ReturnType<typeof runFlow>>[] = [];
const twice = args.includes("--twice");
for (const f of list) {
  try {
    if (twice) {
      // Mode apprentissage : un premier passage, la revue écrit ses modes d'emploi, un second passage les relit.
      const first = await runFlow(f, cfg, { keep: true });
      await Promise.all([...pendingReviews]);
      const learned = (await first.app.db.query<{ name: string; version: number; body: string }>(`SELECT name, version, body FROM skills ORDER BY id`)).rows;
      console.log(`${f.id.padEnd(18)} 1er passage : fait ${first.fait} | parle peu ${first.parle_peu} | ${first.bubbles} bulles | ${first.seconds} s | ${first.reached.join(" ; ") || "pas au bouton"}`);
      console.log(`  appris : ${learned.map((s) => `${s.name} (v${s.version})`).join(", ") || "rien"}`);
      for (const s of learned) console.log(`    ${s.body.replace(/\n/g, " / ").slice(0, 600)}`);
      const second = await runFlow({ ...f, id: `${f.id}-2` }, cfg, { app: first.app, handle: "+33611220098" });
      rows.push(first, second);
      appendFileSync(results, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
      console.log(`${f.id.padEnd(18)} 2e passage : fait ${second.fait} | parle peu ${second.parle_peu} | ${second.bubbles} bulles | ${second.seconds} s | ${second.reached.join(" ; ") || "pas au bouton"}`);
      continue;
    }
    const r = await runFlow(f, cfg);
    rows.push(r);
    appendFileSync(results, `${JSON.stringify(r)}\n`);
    console.log(`${f.id.padEnd(18)} fait ${r.fait} | parle peu ${r.parle_peu} | relance ${r.relance ?? "-"} | ${r.bubbles} bulles, ${r.jobs} travaux, ${r.seconds} s | ${r.reached.join(" ; ") || "pas au bouton"} | ${r.reason}`);
  } catch (e) {
    console.log(`${f.id.padEnd(18)} plantage du banc : ${String(e).slice(0, 300)}`);
  }
}
const md = [
  `# Banc des vrais parcours (${tag})`,
  "",
  "Vrais sites, vrai navigateur, arrêt au bouton qui engage. Notes de 0 à 2.",
  "",
  "| Cas | Fait | Parle peu | Relance | Bulles | Bulles par message reçu | Dans le fil | Au bouton | Écart avec Instinct |",
  "|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.id} | ${r.fait} | ${r.parle_peu}${r.doubles ? " (doublons)" : ""}${r.contradictions ? " (contradictions)" : ""} | ${r.relance ?? "-"} | ${r.bubbles} | ${r.perTurn} | ${r.threaded} | ${r.reached.join(" ; ").replace(/\|/g, "/") || "non"} | ${r.ecart.replace(/\|/g, "/")} |`),
  "",
  ...rows.flatMap((r) => [`## ${r.id}`, "", "```", transcript(r.convo), "```", ""]),
].join("\n");
writeFileSync(join(OUT, `RESULTATS-${tag}.md`), md);
console.log(`\nFIN DU BANC, tableau : ${join(OUT, `RESULTATS-${tag}.md`)}`);
process.exit(0);
