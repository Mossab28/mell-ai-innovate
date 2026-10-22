import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { makeLlm } from "../src/llm.ts";
import { consolidate } from "../src/curator.ts";

/**
 * Banc du curateur : une bibliothèque en désordre, comme les bancs d'apprentissage en laissent (deux noms pour la même
 * classe de tâches, un mode d'emploi trop étroit, une phrase « ne marche pas »), rangée par le vrai modèle. Sert aussi
 * à comparer un autre modèle (MELLA_MODEL, MELLA_LLM=openai).
 *
 *   npx tsx server/bench/curator.ts [--tag nom]
 */

const args = process.argv.slice(2);
const tag = args.includes("--tag") ? args[args.indexOf("--tag") + 1] : new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const keys = (f: string) => (existsSync(join(homedir(), ".config/mella", f)) ? readFileSync(join(homedir(), ".config/mella", f), "utf8") : "");
const env: Record<string, string> = { ...(process.env as Record<string, string>) };
for (const line of (keys("anthropic.env") + "\n" + keys("openai.env")).split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const cfg = loadConfig({ ...env, MELLA_SEED_LINES: "l1|+33100000000|s1", MELLA_PULSE: "0", LOG_LEVEL: "silent", DATABASE_URL: "" } as any);
// La base seule : le curateur est appelé à la main, avec le vrai modèle.
const app = await createApp(loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", LOG_LEVEL: "silent" } as any));
const llm = makeLlm(cfg);

const LIBRARY: Array<{ name: string; description: string; domains: string[]; body: string }> = [
  {
    name: "reserver-restaurant",
    description: "Réserver une table dans un restaurant précis, quel que soit le site de réservation",
    domains: ["thefork.fr"],
    body: "## Quand s'en servir\nDès qu'on demande de réserver une table (restaurant, date, heure, nombre de personnes).\n\n## Marche à suivre\n1. Note les paramètres : restaurant et adresse, date complète, heure, nombre de couverts.\n2. Essaie d'abord TheFork. Si la fiche est introuvable, bloquée ou si la recherche expire, ne t'acharne pas.\n3. Trouve le vrai prestataire de réservation du restaurant : fiche Google Maps (bouton « Réserver »), site officiel.\n\n## Pièges\n- Le 15/10 TheFork a renvoyé une 403 sur Pink Mamma : TheFork ne marche pas pour les restaurants Big Mamma.\n\n## Vérifier\nUn créneau précis avec l'heure et le nombre de couverts.",
  },
  {
    name: "reservation-restaurant",
    description: "Trouver un créneau et réserver dans un restaurant demandé",
    domains: ["thefork.fr", "sevenrooms.com"],
    body: "## Quand s'en servir\nQuand quelqu'un veut une table (date, heure, nombre de couverts) dans un restaurant précis.\n\n## Marche à suivre\n1. Cherche le restaurant sur TheFork.\n2. Si TheFork bloque, ouvre le module du restaurant depuis son site ou sa fiche Google Maps.\n3. Affiche tous les horaires du jour, pas seulement ceux proches de l'heure demandée.\n4. Propose les deux créneaux les plus proches de l'heure voulue.\n\n## Pièges\n- Note les deux créneaux les plus proches avant de répondre : la personne veut choisir.\n\n## Vérifier\nLes créneaux rendus existent sur la page.",
  },
  {
    name: "thefork",
    description: "Lire les créneaux et réserver sur TheFork",
    domains: ["thefork.fr"],
    body: "## Marche à suivre\n1. Ouvre la fiche du restaurant.\n2. Choisis la date puis le nombre de personnes, puis l'heure.\n\n## Pièges\n- Ferme le bandeau de cookies avant de cliquer : il couvre le sélecteur de date.",
  },
  {
    name: "sevenrooms",
    description: "Lire les créneaux et réserver sur SevenRooms, le module de nombreux restaurants",
    domains: ["sevenrooms.com"],
    body: "## Marche à suivre\n1. Ouvre le module depuis le site officiel ou le bouton « Réserver une table » de Google Maps.\n2. Renseigne la date et le nombre de personnes, puis « Tous les horaires ».\n\n## Pièges\n- Sans « Tous les horaires », seuls trois créneaux autour de l'heure s'affichent : on croit à tort que c'est complet.",
  },
  {
    name: "booking-hotel-pas-cher-pres-d-un-lieu",
    description: "Trouver un hôtel pas cher près d'un lieu précis sur Booking",
    domains: ["booking.com"],
    body: "## Marche à suivre\n1. Cherche le lieu (gare, quartier) comme destination.\n2. Trie par prix croissant, filtre la distance (moins de 1 km).\n3. Écarte les dortoirs si elle veut une chambre privée.\n\n## Pièges\n- Le prix affiché est par nuit hors taxe de séjour : ajoute-la avant d'annoncer un total.",
  },
  {
    name: "hotel-gare-de-lyon",
    description: "Hôtel près de la gare de Lyon",
    domains: ["booking.com"],
    body: "## Marche à suivre\n1. Destination « Gare de Lyon, Paris ».\n2. Filtre chambre privée et budget max.\n\n## Pièges\n- Les appart-hôtels n'affichent pas toujours le prix dans la liste : ouvre la fiche avant de le dire.",
  },
];

for (const s of LIBRARY) {
  await app.db.query(`INSERT INTO skills (scope, name, description, body, domains, status) VALUES ('global', $1, $2, $3, $4, 'active')`, [s.name, s.description, s.body, s.domains]);
}
const t0 = Date.now();
const said = await consolidate(app.db, cfg, llm);
const after = (await app.db.query<{ name: string; status: string; version: number; domains: string[]; body: string }>(`SELECT name, status, version, domains, body FROM skills ORDER BY status, name`)).rows;
const active = after.filter((s) => s.status === "active");
const checks = {
  "moins de modes d'emploi actifs": active.length < LIBRARY.length,
  "une seule classe « réserver un restaurant »": active.filter((s) => /restaurant/i.test(s.name)).length === 1,
  "les sites gardent leur mode d'emploi": ["thefork", "sevenrooms"].every((n) => active.some((s) => s.name === n)),
  "plus de « ne marche pas »": !active.some((s) => /ne marche pas|ne fonctionne pas/i.test(s.body)),
  "plus de date ni de récit": !active.some((s) => /\b\d{1,2}\/\d{1,2}\b/.test(s.body)),
};
const md = [
  `# Banc du curateur (${tag}), modèle ${cfg.models.task}, ${Math.round((Date.now() - t0) / 1000)} s`,
  "",
  ...Object.entries(checks).map(([k, v]) => `- ${v ? "oui" : "NON"} : ${k}`),
  "",
  `Son dernier mot : ${said ?? "(rien)"}`,
  "",
  ...after.map((s) => `## ${s.name} [${s.status}, v${s.version}] ${s.domains.join(", ")}\n\n${s.status === "archived" ? "(archivé)" : s.body}\n`),
].join("\n");
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "infra", "bench", "curator");
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `RESULTATS-${tag}.md`), md);
console.log(md);
await app.stop();
process.exit(0);
