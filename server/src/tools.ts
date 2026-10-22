import type { Db } from "./db.ts";
import type { ToolSpec } from "./llm.ts";
import type { User } from "./users.ts";
import { remember, updateFact, forget } from "./memory.ts";
import { setPersonal } from "./personal.ts";
import { createCheckBack, createOnce, createRecurring, cancelSchedule } from "./schedules.ts";
import { ACTIONS, proposeTask, describeScope, getTask, recordStep, setTaskStatus, authorizeTask, saidByHer } from "./tasks.ts";
import { searxSearch, webSearch } from "./web-search.ts";
import { formatSkill, viewSkill } from "./skills.ts";
import { zonedToUtc, formatLocal, isValidTimezone } from "./time.ts";
import { readUrl, wrapUntrusted } from "./untrusted.ts";
import { enqueue } from "./outbox.ts";
import { progress } from "./progress.ts";
import { vaultRuntime } from "./vault/index.ts";
import { fillFromVault } from "./vault/inject.ts";
import { issueLink, type LinkKind } from "./vault/links.ts";
import { makeRef, parseRef, normalizeSite } from "./vault/refs.ts";
import { PENDING_SITE } from "./vault/thread.ts";
import type { VaultRef } from "./vault/types.ts";
import { browseForUser, browserRuntime } from "./browser/index.ts";
import { openSiteResults, siteSearchForUser, SITE_NAMES, type SiteName, type SiteQuery } from "./browser/sites/index.ts";
import { GOOGLE_TOOL_SPECS, runGoogleTool } from "./google/tools.ts";
import { searchHistory } from "./history.ts";
import { isReaction, render } from "./style.ts";
import { coerceArgs, parseArgs, resolveToolName } from "./tool-args.ts";
import { previewUrl, publicHost } from "./preview.ts";
import { MAIL_TOOL_SPECS, runMailTool } from "./mail/tools.ts";
import { APP_TOOL_SPECS, APP_TOOLS, runAppTool } from "./apps/index.ts";
import { findPlace, forecast } from "./weather.ts";
import { cancelWatch, createWatch } from "./watches.ts";
import { inviteOf } from "./invites.ts";

type Q = Pick<Db, "query">;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

/**
 * Écrire à la personne quand le passage est silencieux par défaut (veille, retour qu'il s'était fixé) : là, son texte
 * final reste une note pour lui. Sans ça, son raisonnement partait dans le fil (« Je ne la dérange pas », 19/10).
 */
export const SEND_MESSAGE: ToolSpec = {
  name: "send_message",
  description:
    "Lui écrire maintenant, dans son fil. Pendant ce passage, c'est le seul moyen qu'elle lise quelque chose : ton texte final reste pour toi et ne lui parvient pas. Une ligne vide sépare deux bulles.",
  parameters: { type: "object", properties: { text: { type: "string", description: "Ce qu'elle lira, tel quel." } }, required: ["text"] },
};

export const TOOL_SPECS: Record<string, ToolSpec> = {
  remember: {
    name: "remember",
    description: "Retenir un fait durable et utile sur l'utilisateur (préférence, proche, habitude). Une phrase courte. Sa fiche est bornée (la place prise est dans ton contexte) : pleine, regroupe deux souvenirs proches (update_memory) ou oublie ce qui ne sert plus (forget).",
    parameters: obj({ fact: { type: "string" } }, ["fact"]),
  },
  personal_info: {
    name: "personal_info",
    description:
      "Retenir ou corriger ses infos perso dès qu'elle les donne ou qu'un échange les révèle : full_name, email, phone, address, birthdate (enregistrée en AAAA-MM-JJ, quelle que soit la façon dont elle l'écrit), discounts (ses cartes de réduction, abonnements et cartes de fidélité, avec leur numéro s'il est connu, toutes dans un seul texte : le navigateur les applique dans les formulaires de réservation, sans compte). null pour en oublier une. Elles sont dans ton contexte et servent à remplir les formulaires (réservation, livraison) sans rien lui redemander. Jamais de mot de passe ni de carte ici : ceux-là vont au coffre.",
    parameters: obj({ full_name: { type: ["string", "null"] }, email: { type: ["string", "null"] }, phone: { type: ["string", "null"] }, address: { type: ["string", "null"] }, birthdate: { type: ["string", "null"] }, discounts: { type: ["string", "null"] } }),
  },
  update_memory: {
    name: "update_memory",
    description: "Corriger un fait déjà retenu (id donné dans le contexte).",
    parameters: obj({ id: { type: "integer" }, fact: { type: "string" } }, ["id", "fact"]),
  },
  forget: {
    name: "forget",
    description: "Oublier un fait retenu (id donné dans le contexte). À faire dès que l'utilisateur le demande.",
    parameters: obj({ id: { type: "integer" } }, ["id"]),
  },
  set_reminder: {
    name: "set_reminder",
    description:
      "Programmer un rappel ponctuel qu'elle t'a demandé ou qu'elle vient d'accepter (pour revenir vers elle de toi-même, check_back). `at` = heure locale de l'utilisateur au format AAAA-MM-JJTHH:MM. `message` = le texte exact qui sera envoyé à l'heure dite, écrit maintenant, court et naturel (ex. « Ton RDV chez le dentiste est dans 30 min, 12 rue X. »). `follow_up` = pour une chose à faire, la relance envoyée si elle ne réagit pas au rappel (ex. « Tu as pu appeler le garagiste ? ») ; `follow_up_minutes` = délai avant cette relance (60 par défaut). `wake_up` = true pour un réveil : tu l'appelles (FaceTime audio) à l'heure dite et tu lui dis `message`. `call` = true pour un rappel qui ne doit pas être raté : le texto part à l'heure, et si elle n'a ni réagi ni répondu au bout de quelques minutes, tu l'appelles.",
    parameters: obj(
      {
        at: { type: "string" },
        message: { type: "string" },
        follow_up: { type: "string" },
        follow_up_minutes: { type: "integer" },
        wake_up: { type: "boolean" },
        call: { type: "boolean" },
      },
      ["at", "message"],
    ),
  },
  check_back: {
    name: "check_back",
    description:
      "Te fixer un moment pour revenir vers elle de toi-même, sans qu'elle te le demande, quand quelque chose a une échéance ou attend d'elle : un prix ou un panier qui tient jusqu'à une heure, une place qui peut partir, une info ou un dépôt qu'elle doit te donner, un résultat à revérifier. at = AAAA-MM-JJTHH:MM, son heure locale, assez tôt pour qu'elle ait le temps d'agir. why = pour toi : ce qui est en suspens, l'échéance, ce que tu veux vérifier ou lui dire. Rien n'est écrit d'avance : à l'heure dite tu relis le fil, tu as tes outils, et tu décides, un mot utile si c'est toujours en suspens, rien si c'est réglé.",
    parameters: obj({ at: { type: "string" }, why: { type: "string" } }, ["at", "why"]),
  },
  progress: {
    name: "progress",
    description:
      "Quand une demande prend du temps (plusieurs sites, une réservation, une comparaison), dire à l'utilisateur où tu en es en quelques mots (« Je regarde les trains de demain », « 3 options, je compare les prix ») : une seule bulle dans le fil, qui se met à jour à chaque appel, jamais une de plus. Inutile pour ce qui se fait en quelques secondes.",
    parameters: obj({ text: { type: "string" } }, ["text"]),
  },
  continue_in_background: {
    name: "continue_in_background",
    description:
      "Passer la demande au travail de fond, qui a tout en main : recherches sur les sites (trains, restaurants, médecins, logements), navigateur, réservation, achat, plusieurs étapes. À utiliser dès qu'il te manque ici un moyen de faire ce qu'elle demande, plutôt que de lui dire que tu ne peux pas. request = sa demande complète, avec ce que vous avez déjà trouvé dans le fil (horaires, prix, choix).",
    parameters: obj({ request: { type: "string" } }, ["request"]),
  },
  set_routine: {
    name: "set_routine",
    description:
      "Programmer une routine récurrente avec une expression cron à 5 champs lue dans le fuseau de l'utilisateur (ex. « 0 8 * * 1-5 » = 8 h en semaine). kind = text : le `message` est envoyé tel quel. kind = brief : un brief est rédigé à chaque occurrence, `message` est alors la consigne du brief.",
    parameters: obj({ cron: { type: "string" }, message: { type: "string" }, kind: { type: "string", enum: ["text", "brief"] } }, ["cron", "message"]),
  },
  cancel_schedule: {
    name: "cancel_schedule",
    description: "Annuler un rappel ou une routine (id donné dans le contexte).",
    parameters: obj({ id: { type: "string" } }, ["id"]),
  },
  set_profile: {
    name: "set_profile",
    description: "Enregistrer le prénom, le fuseau horaire IANA (ex. Europe/Paris), la langue (fr, en) ou la ville où vit l'utilisateur (sert à la météo du brief).",
    parameters: obj({ name: { type: "string" }, timezone: { type: "string" }, lang: { type: "string" }, city: { type: "string" } }),
  },
  watch_create: {
    name: "watch_create",
    description:
      "Surveiller quelque chose pour la personne et la prévenir d'elle-même quand ça arrive : un créneau plus tôt (source doctolib, args speciality/place), un train ou son prix (sncf, args from/to/date/time), une table qui se libère (thefork, args date/time/party_size/restaurant ou area), un logement ou son prix (booking, args place/checkin/checkout/adults), la pluie (weather, args place/date/days), une réponse Gmail (mail, args query en syntaxe Gmail), une réponse sur l'adresse propre de Mell (mell_mail, args from = adresse exacte, subject = objet, after = date ISO de l'envoi), une page (web, args url). Une surveillance informe seulement; elle ne réserve et ne paie jamais. condition = quand prévenir, précise (« un créneau avant le 30/10 », « réponse de Paul »). what = la phrase que la personne reconnaîtra. days = durée (14 par défaut).",
    parameters: obj(
      {
        what: { type: "string" },
        source: { type: "string", enum: ["doctolib", "sncf", "thefork", "booking", "weather", "mail", "mell_mail", "web"] },
        args: { type: "object" },
        condition: { type: "string" },
        days: { type: "integer" },
      },
      ["what", "source", "condition"],
    ),
  },
  call_me: {
    name: "call_me",
    description:
      "L'appeler tout de suite en FaceTime audio (« appelle-moi », « tu peux m'appeler ? ») et lui dire `message` de vive voix, court et naturel. Pas de question sur l'heure : maintenant. Pour plus tard, set_reminder avec wake_up.",
    parameters: obj({ message: { type: "string" } }, ["message"]),
  },
  invite_link: {
    name: "invite_link",
    description: "Envoyer dans le fil le lien d'invitation de la personne, à partager à ses proches (un nombre de places limité). Le lien part tout seul : ne le recopie pas.",
    parameters: obj({}),
  },
  watch_cancel: {
    name: "watch_cancel",
    description: "Arrêter une surveillance (id donné dans le contexte).",
    parameters: obj({ id: { type: "string" } }, ["id"]),
  },
  set_quiet: {
    name: "set_quiet",
    description:
      "Régler ce que Mell envoie de lui-même. until = AAAA-MM-JJTHH:MM heure locale : rien de proactif avant (briefs, surveillances ; ses rappels à elle partent quand même). less = true : seulement l'important ; false : revenir à la normale. clear = true : lever le silence.",
    parameters: obj({ until: { type: "string" }, less: { type: "boolean" }, clear: { type: "boolean" } }),
  },
  weather: {
    name: "weather",
    description:
      "Prévision météo réelle d'une ville, jour par jour : ciel, températures, pluie (mm, risque, heures probables), vent. place = la ville (sa ville enregistrée si elle ne précise pas). date = AAAA-MM-JJ du premier jour voulu (aujourd'hui par défaut), days = nombre de jours (1 à 7).",
    parameters: obj({ place: { type: "string" }, date: { type: "string" }, days: { type: "integer" } }),
  },
  propose_task: {
    name: "propose_task",
    description: `Poser une tâche à faire à sa place, avec son périmètre : rien qui engage (réserver, acheter, payer, envoyer, résilier) ne se fait sans tâche validée. Actions possibles : ${ACTIONS.join(", ")}. spend_cap_cents = plafond total en centimes (0 si rien à payer). recipients = adresses de chaque destinataire prévu (mail, invitation) : l'accord ne couvre qu'elles. her_words = quand sa demande ou sa réponse couvre déjà cette tâche (« réserve-le », « vazy », « ouais le premier »), recopie ses mots exacts : la tâche est validée tout de suite, sans lui redemander. Sinon, laisse-le vide et pose-lui une seule question, prix compris.`,
    parameters: obj(
      {
        title: { type: "string" },
        actions: { type: "array", items: { type: "string", enum: [...ACTIONS] } },
        spend_cap_cents: { type: "integer" },
        recipients: { type: "array", items: { type: "string" } },
        her_words: { type: "string" },
      },
      ["title", "actions", "spend_cap_cents"],
    ),
  },
  authorize_task: {
    name: "authorize_task",
    description:
      "Valider une tâche déjà proposée quand elle vient d'y dire oui, avec ses mots ou une réaction (« vazy », « ouais réserve », 👍). task_id = la tâche (contexte). her_words = ses mots exacts, recopiés de son message (« 👍 » pour une réaction). Ensuite, fais-la sans redemander.",
    parameters: obj({ task_id: { type: "string" }, her_words: { type: "string" } }, ["task_id", "her_words"]),
  },
  work_update: {
    name: "work_update",
    description:
      "Transmettre au travail de fond en cours (le contexte dit lequel) ce qu'elle vient d'ajouter : une précision (« mets ma carte de réduction »), un changement, ou un arrêt (« stop »). Il le lit à sa prochaine étape. text = ce qu'il doit savoir, avec ses mots. Pour une autre demande, sans rapport avec ce travail, utilise continue_in_background à la place.",
    parameters: obj({ text: { type: "string" } }, ["text"]),
  },
  skill_view: {
    name: "skill_view",
    description: "Lire un mode d'emploi que tu as appris (leur liste est dans ton contexte) avant de te lancer dans la tâche ou le site qu'il couvre.",
    parameters: obj({ name: { type: "string" } }, ["name"]),
  },
  react: {
    name: "react",
    description:
      "Poser tout de suite une réaction sur son dernier message, avant ta réponse ou pendant que tu travailles. reaction = love, like, laugh, emphasize, question, ou un emoji seul. Comme une personne qui lit : seulement quand une réaction dit quelque chose ; la plupart des messages n'en appellent pas.",
    parameters: obj({ reaction: { type: "string" } }, ["reaction"]),
  },
  history_search: {
    name: "history_search",
    description:
      "Retrouver ce qui s'est dit ou fait avec elle avant les messages de ton contexte : un nom, une adresse ou une date qu'elle a donnés, un resto, un prix ou un créneau que tu as trouvés, ce que tu lui avais promis. query = quelques mots qui devraient y figurer (« dentiste », « Pink Mamma », « cadeau maman »). Rend les passages datés avec le fil autour, et ce que tes outils avaient rendu.",
    parameters: obj({ query: { type: "string" } }, ["query"]),
  },
  web_search: {
    name: "web_search",
    description:
      "Chercher sur le web : adresses, restos, commerces, horaires d'ouverture, actualités, infos trafic, prix publics, avis, tout fait public ou du moment. Rapide (10 à 20 secondes), avec les sources. query = la recherche complète, lieu et date compris. À préférer au navigateur pour toute recherche ; le navigateur sert à agir sur un site. Les sources sont les pages d'où vient l'info : pour un lieu, un produit ou une vidéo trouvés, donne le lien direct de la page (iMessage en montre l'aperçu).",
    parameters: obj({ query: { type: "string" } }, ["query"]),
  },
  perform_step: {
    name: "perform_step",
    description:
      "Faire une étape d'une tâche validée. Le système vérifie qu'elle reste dans le périmètre et sous le plafond. Réponses : allowed (fais-la), needs_approval (redemande à l'utilisateur), awaiting_bank (paiement en attente de validation dans l'appli de sa banque).",
    parameters: obj(
      { task_id: { type: "string" }, action: { type: "string" }, amount_cents: { type: "integer" }, detail: { type: "string" } },
      ["task_id", "action"],
    ),
  },
  finish_task: {
    name: "finish_task",
    description: "Clore une tâche : done quand elle est finie, cancelled si l'utilisateur l'annule.",
    parameters: obj({ task_id: { type: "string" }, status: { type: "string", enum: ["done", "cancelled"] } }, ["task_id", "status"]),
  },
  browse: {
    name: "browse",
    description:
      "Faire une tâche web dans le navigateur de l'utilisateur (sa propre session, ses cookies) : disponibilités d'un restaurant, horaires et prix d'un train, prix et délai de livraison d'un produit, créneaux chez un médecin, hôtels. objective = la demande complète et précise (dates, nombre de personnes, budget, site si connu). Sans task_id : lecture seule, rien n'est réservé ni acheté. Avec le task_id d'une tâche validée : le navigateur peut faire les actions qu'elle couvre (connexion avec le coffre, réservation, paiement sous le plafond). Rend la réponse trouvée ou ce qui bloque. Prend une à cinq minutes.",
    parameters: obj(
      {
        objective: { type: "string" },
        start_url: { type: "string" },
        task_id: { type: "string" },
        from_search: {
          type: "object",
          description:
            "Pour réserver ou acheter ce qu'une recherche de site vient de trouver : { site: sncf | thefork | doctolib | booking, query: les mêmes paramètres que la recherche }. Le navigateur part de la page de résultats déjà remplie au lieu de refaire la recherche.",
        },
      },
      ["objective"],
    ),
  },
  // Parcours enregistrés : plus fiables et plus rapides que browse sur ces trois sites. À préférer.
  doctolib_search: {
    name: "doctolib_search",
    description:
      "Premiers créneaux disponibles sur Doctolib pour une spécialité et un lieu, en lecture seule (rien n'est réservé). À préférer à browse pour tout rendez-vous médical. speciality = ce que la personne cherche (« dermatologue », « médecin généraliste », « dentiste »). place = ville, arrondissement ou code postal (« Paris 11 », « Lyon », « 69003 »). Rend les praticiens triés par premier créneau. Prend 10 à 30 secondes.",
    parameters: obj({ speciality: { type: "string" }, place: { type: "string" }, telehealth: { type: "boolean" } }, ["speciality", "place"]),
  },
  sncf_search: {
    name: "sncf_search",
    description:
      "Chercher des trains sur SNCF Connect entre deux villes ou gares (la recherche seule : pour réserver, voir plus bas). À préférer à browse pour trouver un trajet en train en France. date = AAAA-MM-JJ dans le fuseau de l'utilisateur, time = HH:MM de départ souhaitée. Rend horaires, durée, direct ou non, prix, trains complets, et bookable quand le train se réserve en ligne. Sans prix rendu, n'en invente pas. Prend 15 à 30 secondes. Réserver un train trouvé : propose_task (book et pay, plafond = le prix), puis browse avec le task_id et from_search = { site: \"sncf\", query: les mêmes paramètres }.",
    parameters: obj({ from: { type: "string" }, to: { type: "string" }, date: { type: "string" }, time: { type: "string" } }, ["from", "to", "date"]),
  },
  live_login: {
    name: "live_login",
    description:
      "Prise en main exceptionnelle du navigateur, uniquement si la personne demande explicitement à piloter le navigateur distant. Pour connecter un compte à une tâche, utilise le connecteur officiel ou vault_request_link avec le domaine exact. Ne propose pas cette prise en main comme parcours de connexion par défaut. site = le nom du site, start_url = sa page de connexion, task_id = la tâche qui attend.",
    parameters: obj({ site: { type: "string" }, start_url: { type: "string" }, task_id: { type: "string" } }, ["site", "start_url"]),
  },
  booking_search: {
    name: "booking_search",
    description:
      "Logements sur Booking.com (hôtels, auberges, appartements) à une adresse, un quartier ou une ville, pour des dates et un nombre de personnes, en lecture seule. À préférer à browse pour tout logement. place = l'adresse ou le quartier (« rue d'Aboukir, Paris »). checkin, checkout = AAAA-MM-JJ dans son fuseau (checkout : le lendemain par défaut). adults = nombre de personnes. order = price (du moins cher, par défaut) ou popularity. Rend les logements avec prix, note, distance et lien direct. Prend 10 à 30 secondes.",
    parameters: obj(
      { place: { type: "string" }, checkin: { type: "string" }, checkout: { type: "string" }, adults: { type: "integer" }, order: { type: "string", enum: ["price", "popularity"] } },
      ["place", "checkin"],
    ),
  },
  thefork_search: {
    name: "thefork_search",
    description:
      "Créneaux de restaurant sur TheFork pour N personnes à une date, en lecture seule (rien n'est réservé). À préférer à browse pour réserver une table. Donne restaurant (nom) ou area (quartier, ville, adresse), ou les deux ; cuisine (« italien ») filtre un quartier. date = AAAA-MM-JJ, time = HH:MM souhaitée. Rend les restaurants avec leurs créneaux autour de cette heure et ceux qui sont complets. Prend 10 à 30 secondes.",
    parameters: obj(
      { date: { type: "string" }, time: { type: "string" }, party_size: { type: "integer" }, restaurant: { type: "string" }, area: { type: "string" }, cuisine: { type: "string" } },
      ["date", "party_size"],
    ),
  },
  browser_forget: {
    name: "browser_forget",
    description: "Effacer toutes les sessions web de l'utilisateur (cookies, connexions aux sites) quand il le demande.",
    parameters: obj({}),
  },
  read_url: {
    name: "read_url",
    description: "Lire le texte d'une page web. Le contenu revient enveloppé comme donnée non fiable.",
    parameters: obj({ url: { type: "string" } }, ["url"]),
  },
  // Coffre : tu ne vois jamais une valeur, seulement des références vault://...
  vault_list: {
    name: "vault_list",
    description: "Lister ce que l'utilisateur a rangé dans son coffre : des références (vault://login/resy.com, vault://totp/resy.com, vault://personal/address), jamais les valeurs.",
    parameters: obj({}),
  },
  vault_request_link: {
    name: "vault_request_link",
    description:
      "Envoyer le lien du coffre Mell à usage unique (30 min) pour un compte nécessaire à la demande de la personne, ses infos perso ou sa carte. Un compte n'est nécessaire que si le site l'exige : la plupart des réservations et achats se font en invité, et une carte de réduction ou de fidélité se saisit dans le formulaire (discounts de personal_info), sans compte. Dans le doute, le navigateur essaie d'abord en invité et dit s'il bute sur une connexion obligatoire. kind=login pour un compte, totp pour une clé authentificateur facultative. site = domaine complet exact (booking.com, jamais booking) et task_id = tâche en attente. L'utilisateur décide de déposer ses identifiants sur cette page, hors conversation; ne les demande jamais dans le fil. Préfère les connecteurs officiels pour Gmail et Agenda. Le lien et son aperçu cadenas partent automatiquement, ne les recopie pas. Un dépôt ne prouve pas encore que le site est connecté.",
    parameters: obj(
      { kind: { type: "string", enum: ["login", "totp", "card"] }, site: { type: "string" }, task_id: { type: "string" } },
      ["kind"],
    ),
  },
  vault_fill: {
    name: "vault_fill",
    description:
      "Pendant une tâche validée qui inclut log_in (identifiants, code 2FA) ou fill_personal (infos perso) : le navigateur tape dans la page ouverte la valeur rangée sous `ref`. Tu ne vois jamais la valeur, seulement quels champs ont été remplis. Refusé si la page n'est pas sur le site de l'identifiant.",
    parameters: obj({ task_id: { type: "string" }, ref: { type: "string" } }, ["task_id", "ref"]),
  },
  vault_assign_pending: {
    name: "vault_assign_pending",
    description: "Classer sous le bon site le mot de passe reçu dans le fil sans site (vault://login/_pending), une fois que l'utilisateur a dit pour quel site c'est.",
    parameters: obj({ site: { type: "string" } }, ["site"]),
  },
  vault_delete: {
    name: "vault_delete",
    description: "Effacer une entrée du coffre (ref vault://...) quand l'utilisateur le demande.",
    parameters: obj({ ref: { type: "string" } }, ["ref"]),
  },
  // Gmail et Google Agenda (google/) : lien de connexion, lecture, brouillon, envoi sous tâche, agenda.
  ...GOOGLE_TOOL_SPECS,
  // Adresse mail de Mell (mail/) : son adresse, les mails reçus, ses adresses à elle.
  // Sauf mail_draft : son brouillon partait en carte, et les seules cartes sont la connexion et le paiement (20/10).
  ...Object.fromEntries(Object.entries(MAIL_TOOL_SPECS).filter(([n]) => n !== "mail_draft")),
  // Connecteurs d'applications (apps/) via Composio : connecter, lire/agir, déconnecter.
  ...APP_TOOL_SPECS,
};

/** Ce que le modèle fait d'options trouvées : du texte et le lien direct de chacune, que l'iPhone montre en aperçu. */
const LINKS_NEXT = "Donne-lui les meilleures options en texte, chacune avec son lien direct (url) en fin de ligne : iMessage en montre l'aperçu tout seul.";

/** Outils réservés au travail de fond : lecture du web et injection de secrets dans le navigateur. */
const TASK_ONLY = new Set(["vault_fill", "browse", "doctolib_search", "sncf_search", "thefork_search", "booking_search", "app_do"]);

/** Le chemin synchrone passe la main au travail de fond ; le travail de fond, lui, a déjà tout. */
const TOOL_ONLY = new Set(["continue_in_background", "work_update"]);

export function toolsFor(mode: "tool" | "task"): ToolSpec[] {
  const names = Object.keys(TOOL_SPECS).filter((n) => (mode === "task" ? !TOOL_ONLY.has(n) : !TASK_ONLY.has(n)));
  return names.map((n) => TOOL_SPECS[n]);
}

/** La configuration du serveur, posée au démarrage : le passage au travail de fond en a besoin. */
let serverCfg: import("./config.ts").Config | undefined;
export function setToolsConfig(cfg: import("./config.ts").Config): void {
  serverCfg = cfg;
}

/** Exécute un appel d'outil. Ne lève jamais : une erreur revient au modèle sous forme de texte. */
/** `ctx.sourceGuid` : son message qui a lancé ce tour ; le travail de fond lui répond dans son fil. */
export async function runTool(db: Q, user: User, calledName: string, rawArgs: string, ctx: { sourceGuid?: string | null } = {}): Promise<string> {
  // Un appel un peu de travers (nom préfixé, « 42 » pour un entier, JSON dans des ```) est réparé d'après le schéma.
  const name = resolveToolName(calledName, Object.keys(TOOL_SPECS)) ?? calledName;
  try {
    const parsed = parseArgs(rawArgs);
    if (!parsed) return err(`arguments illisibles : envoie un seul objet JSON qui suit le schéma de ${name}`);
    const a: any = coerceArgs(TOOL_SPECS[name], parsed);
    switch (name) {
      case "remember": {
        const r = await remember(db, user.id, String(a.fact));
        return "error" in r ? err(r.error) : ok({ remembered: r });
      }
      case "personal_info":
        return ok({ saved: await setPersonal(db, user.id, a) });
      case "update_memory": {
        const r = await updateFact(db, user.id, Number(a.id), String(a.fact));
        return typeof r === "object" ? err(r.error) : ok({ updated: r });
      }
      case "forget":
        return ok({ forgotten: await forget(db, user.id, Number(a.id)) });
      case "continue_in_background": {
        if (!serverCfg) return err("travail de fond indisponible");
        const { createJob } = await import("./agent.ts");
        // S'il y a déjà un travail ouvert, la demande lui est remise : deux travaux qui répondent la même chose à dix
        // secondes d'écart, c'était un « Ressaie » transformé en second travail pendant que le premier tournait (19/10).
        await createJob(db, serverCfg, user.id, String(a.request ?? "").slice(0, 4000), ctx.sourceGuid ?? null);
        return ok({ started: true, next: "Le travail de fond s'en charge et rendra le résultat dans son fil." });
      }
      case "progress":
        await progress(db, user.id, String(a.text ?? "").slice(0, 120));
        return ok({ shown: true });
      case "set_reminder": {
        const at = zonedToUtc(String(a.at), user.timezone);
        if (at.getTime() < Date.now() - 60_000) return err("cette heure est déjà passée");
        const callMode = a.wake_up ? "wake" : a.call ? "if_no_answer" : undefined;
        const s = await createOnce(
          db,
          user.id,
          at,
          String(a.message),
          user.timezone,
          a.follow_up ? { message: String(a.follow_up), minutes: Number(a.follow_up_minutes ?? (callMode ? 5 : 60)) } : undefined,
          callMode,
        );
        return ok({
          reminder: { id: s.id, when: formatLocal(at, user.timezone, user.lang), call: callMode === "wake" ? "à l'heure dite" : callMode ? "si elle ne réagit pas" : undefined },
        });
      }
      case "check_back": {
        const at = zonedToUtc(String(a.at), user.timezone);
        if (Number.isNaN(at.getTime())) return err("heure attendue au format AAAA-MM-JJTHH:MM");
        if (at.getTime() < Date.now() + 60_000) return err("ce moment est déjà là : fais-le maintenant");
        if (at.getTime() > Date.now() + 7 * 86_400_000) return err("trop loin : au-delà d'une semaine, un rappel ou une surveillance convient mieux");
        const s = await createCheckBack(db, user.id, at, String(a.why ?? ""), user.timezone);
        return ok({ check_back: { id: s.id, when: formatLocal(at, user.timezone, user.lang) } });
      }
      case "set_routine": {
        const s = await createRecurring(db, user.id, {
          cron: String(a.cron),
          tz: user.timezone,
          message: String(a.message),
          action: a.kind === "brief" ? "brief" : "send_text",
        });
        return ok({ routine: { id: s.id, next: formatLocal(new Date(s.next_run_at), user.timezone, user.lang) } });
      }
      case "cancel_schedule":
        return ok({ cancelled: await cancelSchedule(db, user.id, String(a.id)) });
      case "set_profile": {
        if (a.timezone && !isValidTimezone(String(a.timezone))) return err("fuseau inconnu");
        await db.query(
          `UPDATE users SET name = coalesce($2, name), timezone = coalesce($3, timezone), lang = coalesce($4, lang), city = coalesce($5, city) WHERE id = $1`,
          [user.id, a.name ?? null, a.timezone ?? null, a.lang ?? null, a.city ? String(a.city).slice(0, 80) : null],
        );
        return ok({ saved: true });
      }
      case "watch_create": {
        const w = await createWatch(db, user.id, {
          what: String(a.what ?? ""),
          source: String(a.source ?? ""),
          args: a.args && typeof a.args === "object" ? a.args : {},
          condition: String(a.condition ?? ""),
          days: a.days ? Number(a.days) : undefined,
        });
        return ok({
          watching: { id: w.id, until: formatLocal(new Date(w.expires_at), user.timezone, user.lang), every_minutes: w.every_minutes },
          next: "Surveillance posée : tu seras réveillé quand la condition est remplie.",
        });
      }
      case "call_me": {
        await enqueue(db, [{ userId: user.id, kind: "call", text: String(a.message ?? "").slice(0, 500) || (user.lang === "en" ? "Hey, it's Mell." : "Salut, c'est Mell.") }]);
        return ok({ calling: true, next: "L'appel part maintenant." });
      }
      case "invite_link": {
        const inv = await inviteOf(db, user.id);
        if (!inv) return ok({ invites: 0, note: "Elle est au bout de la chaîne : pas d'invitation à donner. Dis-le simplement, sans expliquer le système." });
        const base = (vaultRuntime().publicUrl ?? "").replace(/\/+$/, "");
        const fr = user.lang !== "en";
        const n = inv.uses_left;
        const text = n
          ? fr
            ? `Ton lien, il fait entrer ${n} personne${n > 1 ? "s" : ""} : ${base}/i/${inv.code}`
            : `Your link, good for ${n} ${n > 1 ? "people" : "person"}: ${base}/i/${inv.code}`
          : fr
            ? "Tes invitations sont toutes parties. Je t'en redonne dès qu'il y a de la place."
            : "Your invites are all used up. I'll give you more as soon as there's room.";
        await enqueue(db, [{ userId: user.id, kind: "text", text }]);
        return ok({ sent: true, invites_left: n, next: "Le lien est déjà dans le fil." });
      }
      case "watch_cancel":
        return ok({ cancelled: await cancelWatch(db, user.id, String(a.id)) });
      case "set_quiet": {
        if (a.clear) await db.query(`UPDATE users SET quiet_until = NULL WHERE id = $1`, [user.id]);
        if (a.until) {
          const at = zonedToUtc(String(a.until), user.timezone);
          await db.query(`UPDATE users SET quiet_until = $2 WHERE id = $1`, [user.id, at]);
        }
        if (typeof a.less === "boolean") await db.query(`UPDATE users SET proactive = $2 WHERE id = $1`, [user.id, a.less ? "less" : "normal"]);
        return ok({ saved: true });
      }
      case "weather": {
        const name = String(a.place ?? user.city ?? "").trim();
        if (!name) return ok({ error: "ville inconnue", next: "Sa ville n'est pas connue (set_profile l'enregistre)." });
        const place = await findPlace(name, user.lang);
        if (!place) return err(`ville introuvable : ${name}`);
        const days = await forecast(place, user.lang, Number(a.days ?? 1) || 1, a.date ? String(a.date) : undefined);
        return ok({
          place: `${place.name}${place.country ? `, ${place.country}` : ""}`,
          days,
        });
      }
      case "propose_task": {
        const t = await proposeTask(db, user.id, {
          title: String(a.title),
          actions: a.actions ?? [],
          spendCapCents: Number(a.spend_cap_cents ?? 0),
          recipients: Array.isArray(a.recipients) ? a.recipients.map(String) : [],
        });
        // Sa demande couvre déjà la tâche : l'agent cite ses mots, le code vérifie seulement qu'ils viennent d'elle.
        // L'argent reste borné par le plafond de la tâche et par la validation de sa banque.
        if (a.her_words && (await saidByHer(db, user.id, String(a.her_words)))) {
          const authorized = await authorizeTask(db, user.id, t.id, serverCfg?.taskAuthorizationHours ?? 24);
          if (authorized) return ok({ authorized: { id: t.id, summary: describeScope(t) }, next: "Validée : tu peux le faire avec ce task_id." });
        }
        return ok({
          proposed: { id: t.id, summary: describeScope(t) },
          next: "Proposée, pas encore validée : son accord la valide (authorize_task avec ses mots).",
        });
      }
      case "authorize_task": {
        if (!(await saidByHer(db, user.id, String(a.her_words ?? "")))) return err("ces mots ne sont dans aucun de ses messages récents : recopie exactement ce qu'elle a écrit, ou demande-lui");
        const t = await authorizeTask(db, user.id, String(a.task_id ?? ""), serverCfg?.taskAuthorizationHours ?? 24);
        if (!t) return err("pas de tâche proposée avec cet id");
        return ok({ authorized: { id: t.id, summary: describeScope(t) }, next: "Validée : browse avec ce task_id pour agir sur un site." });
      }
      case "work_update": {
        const { appendToOpenJob } = await import("./agent.ts");
        const joined = await appendToOpenJob(db, user.id, String(a.text ?? "").slice(0, 2000));
        return joined ? ok({ sent: true, next: "Le travail en cours le lira à sa prochaine étape." }) : err("aucun travail de fond en cours");
      }
      case "skill_view": {
        const s = await viewSkill(db, user.id, String(a.name ?? ""));
        return s ? ok({ skill: formatSkill(s) }) : err("pas de mode d'emploi à ce nom");
      }
      case "send_message": {
        const { bubbles } = render(String(a.text ?? ""));
        if (!bubbles.length) return err("message vide");
        await enqueue(db, bubbles.map((text) => ({ userId: user.id, kind: "text" as const, text, ...(ctx.sourceGuid ? { replyTo: ctx.sourceGuid } : {}) })));
        return ok({ sent: bubbles.length });
      }
      case "react": {
        const reaction = String(a.reaction ?? "").trim();
        if (!ctx.sourceGuid) return err("pas de message d'elle auquel réagir ici");
        if (!isReaction(reaction)) return err("une réaction est un emoji seul ou love, like, laugh, emphasize, question");
        await enqueue(db, [{ userId: user.id, kind: "tapback", tapback: reaction, targetGuid: ctx.sourceGuid }]);
        return ok({ reacted: reaction, next: "Elle la voit déjà." });
      }
      case "history_search":
        return ok({ found: await searchHistory(db, user, String(a.query ?? "")) });
      case "web_search": {
        const search = serverCfg?.search;
        let r;
        if (search?.provider === "searxng" && search.searxngUrl) r = await searxSearch(search.searxngUrl, String(a.query ?? ""), user.lang);
        else if (search?.provider === "anthropic" && serverCfg?.anthropicApiKey)
          r = await webSearch(serverCfg.anthropicApiKey, search.model ?? (/^claude-/.test(serverCfg.models.tool) ? serverCfg.models.tool : "claude-haiku-5-5"), String(a.query ?? ""), { city: user.city, timezone: user.timezone });
        else return err("recherche web indisponible");
        return ok({ results: wrapUntrusted(r.answer, "le web"), sources: r.sources.map((s) => s.url) });
      }
      case "perform_step": {
        const t = await getTask(db, user.id, String(a.task_id));
        if (!t) return err("tâche introuvable");
        // Le paiement se fait sur la page du marchand, dans le navigateur, qui gère la carte et la banque.
        // Avec le modèle factice (simulateur, tests), l'étape reste simulée et la banque répond par :bank.
        const rt = browserRuntime();
        if (a.action === "pay" && rt && rt.cfg.llm !== "fake") return ok({ decision: "not_here", next: "Pour payer, lance browse avec ce task_id : le navigateur tape la carte rangée au coffre et attend la validation de sa banque." });
        // Avec un vrai navigateur, la dépense se compte au clic sur le site (commit), pas à l'annonce de l'étape.
        const d = await recordStep(db, t, { action: String(a.action), amountCents: Number(a.amount_cents ?? 0), detail: a.detail }, { count: !(rt && rt.cfg.llm !== "fake") });
        // Le navigateur passe par browse (avec task_id) ; le paiement réel n'est pas encore branché.
        return ok({ ...d, note: "étape journalisée ; pour agir sur un site, utilise browse avec ce task_id" });
      }
      case "finish_task":
        return ok({ updated: await setTaskStatus(db, user.id, String(a.task_id), a.status === "done" ? "done" : "cancelled") });
      case "browse": {
        // Deux recherches web ratées coup sur coup : une troisième ne ferait que rallonger l'attente.
        const failed = (await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM tool_calls WHERE user_id = $1 AND name = 'browse' AND created_at > now() - interval '10 minutes' AND result ~ '"browse":"(limit|stuck|error)"'`,
          [user.id],
        )).rows[0].n;
        // Un site qui refuse le navigateur (anti-robot) deux fois en un quart d'heure : on n'y retourne pas, sinon le
        // travail tournait en silence 13 minutes sur un site bloqué (banc du 19/10).
        const blocked = (await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM tool_calls WHERE user_id = $1 AND name = 'browse' AND created_at > now() - interval '15 minutes' AND result LIKE '%"site_blocked":true%'`,
          [user.id],
        )).rows[0].n;
        if (blocked >= 2) {
          return ok({ browse: "skipped", next: "Le site refuse le navigateur depuis deux essais : le navigateur n'y retourne pas pendant ce travail." });
        }
        if (failed >= 2 && !a.task_id) {
          return ok({ browse: "skipped", next: "Deux recherches web viennent d'échouer pour cette demande : le navigateur n'en relance pas d'autre." });
        }
        const fs = a.from_search && typeof a.from_search === "object" && SITE_NAMES.includes(a.from_search.site) ? a.from_search : undefined;
        const r = await browseForUser(user, {
          objective: String(a.objective),
          startUrl: a.start_url ? String(a.start_url) : undefined,
          taskId: a.task_id ? String(a.task_id) : undefined,
          prelude: fs ? (page) => openSiteResults(fs.site, page, fs.query ?? {}, user.timezone) : undefined,
        });
        // Les options partent en texte avec leur lien direct, qu'iMessage montre en aperçu : plus de cartes refaites
        // par nous (« les cartes personnalisées, c'est nul, donne-moi le lien », Moss'Ab, 20/10).
        const options = (r.cards ?? []).slice(0, 6).map((c) => ({ title: c.title, detail: c.subtitle, url: c.url }));
        return ok({
          options: options.length ? wrapUntrusted(JSON.stringify(options), "les pages lues") : undefined,
          browse: r.status,
          ...(r.status !== "done" && r.blocks?.length ? { site_blocked: true } : {}),
          answer: r.answer,
          blocked_on: r.reason,
          sites: [...new Set(r.pages.map((u) => { try { return new URL(u).host; } catch { return u; } }))].slice(0, 6),
          seconds: Math.round(r.ms / 1000),
          next:
            r.status === "done"
              ? options.length
                ? LINKS_NEXT
                : undefined
              : a.task_id
                ? "Pas fini : la page est restée là où le navigateur s'est arrêté, browse avec le même task_id et sans start_url reprend de là. Rien d'autre n'a été lu : aucun prix, horaire ni disponibilité au-delà des résultats ci-dessus."
                : "Pas fini. Rien d'autre n'a été lu : aucun prix, horaire, nom ni disponibilité au-delà des résultats ci-dessus.",
        });
      }
      case "doctolib_search":
        return siteTool(user, "doctolib", { speciality: String(a.speciality ?? ""), place: String(a.place ?? ""), telehealth: !!a.telehealth });
      case "sncf_search":
        return siteTool(user, "sncf", { from: String(a.from ?? ""), to: String(a.to ?? ""), date: String(a.date ?? ""), time: a.time ? String(a.time) : undefined });
      case "live_login": {
        const { startLive } = await import("./browser/live.ts");
        const rt = browserRuntime();
        if (!rt) return err("navigateur non branché");
        const site = String(a.site ?? "").slice(0, 60);
        const url = await startLive(db, rt.cfg, user.id, { site, startUrl: String(a.start_url ?? ""), taskId: a.task_id ? String(a.task_id) : undefined });
        const fr = user.lang !== "en";
        await enqueue(db, [
          { userId: user.id, kind: "text", text: fr ? `Connecte-toi à ${site} ici, sur la vraie page. Je ne vois pas ton mot de passe, je garde juste la session :` : `Sign in to ${site} here, on the real page. I never see your password, I just keep the session:` },
          { userId: user.id, kind: "text", text: url },
        ]);
        return ok({ link_sent: true, next: "Le lien est parti. Quand elle aura touché « C'est bon », tu seras connecté et la tâche reprendra." });
      }
      case "booking_search": {
        const query = {
          place: String(a.place ?? ""),
          checkin: String(a.checkin ?? ""),
          checkout: a.checkout ? String(a.checkout) : undefined,
          adults: a.adults ? Number(a.adults) : undefined,
          order: a.order === "popularity" ? ("popularity" as const) : ("price" as const),
        };
        const r = await siteSearchForUser(user, "booking", query);
        const stays = (r.data as { stays?: Array<{ title: string; price?: string; priceCents?: number; rating?: string; distance?: string; where?: string; url?: string; image?: string }> } | undefined)?.stays ?? [];
        return ok({
          booking: r.ok ? "found" : "failed",
          results: stays.length ? wrapUntrusted(JSON.stringify(stays.slice(0, 8).map(({ image, priceCents, ...s }) => s)), "booking.com") : undefined,
          blocked_on: r.reason,
          seconds: Math.round(r.ms / 1000),
          next: r.ok
            ? LINKS_NEXT
            : "Rien n'a été lu au-delà de ce qui est ci-dessus.",
        });
      }
      case "thefork_search":
        return siteTool(user, "thefork", {
          date: String(a.date ?? ""),
          time: a.time ? String(a.time) : undefined,
          partySize: Number(a.party_size ?? 2),
          restaurant: a.restaurant ? String(a.restaurant) : undefined,
          area: a.area ? String(a.area) : undefined,
          cuisine: a.cuisine ? String(a.cuisine) : undefined,
        });
      case "browser_forget": {
        const rt = browserRuntime();
        if (!rt) return ok({ forgotten: false, note: "navigateur non branché" });
        return ok({ forgotten: await rt.sessions.forget(user.id) });
      }
      case "read_url":
        return ok({ page: await readUrl(String(a.url)) });
      case "vault_list": {
        const entries = await vaultRuntime().vault.list(db, user.id);
        return ok({ entries: entries.map((e) => e.ref), note: entries.length ? "valeurs jamais visibles, utilisables avec vault_fill" : "coffre vide" });
      }
      case "vault_request_link": {
        if (!["login", "totp", "personal", "card"].includes(String(a.kind))) return err("type de dépôt invalide");
        const kind = a.kind as LinkKind;
        const task = a.task_id ? await getTask(db, user.id, String(a.task_id)) : undefined;
        if (a.task_id && !task) return err("tâche introuvable");
        const site = a.site ? normalizeSite(String(a.site)) : undefined;
        if (task && (kind === "login" || kind === "totp") && !site) return err("précise le domaine complet du compte nécessaire à cette tâche");
        const link = await issueLink(db, vaultRuntime().publicUrl, { userId: user.id, kind, site, taskId: task?.id });
        // Une image d'aperçu (toujours affichée) + le lien : pas de « Toucher pour charger ».
        const pv = previewUrl({ title: site ?? (kind === "card" ? (user.lang === "en" ? "Your card" : "Ta carte") : kind === "personal" ? (user.lang === "en" ? "Your details" : "Tes informations") : user.lang === "en" ? "Your account" : "Ton compte"), host: publicHost(), lock: true });
        await enqueue(db, [pv ? { userId: user.id, kind: "card" as const, image: pv, text: link.url } : { userId: user.id, kind: "text", text: link.url }]);
        return ok({
          link_sent: true,
          next: "Le lien du coffre est parti dans le fil avec son aperçu. Un dépôt ne prouve pas la connexion : elle se vérifie sur le site.",
        });
      }
      case "vault_fill": {
        const ref = String(a.ref) as VaultRef;
        const { kind, name } = parseRef(ref);
        const t = await getTask(db, user.id, String(a.task_id));
        if (!t) return err("tâche introuvable");
        if (kind === "card") return ok({ decision: "not_here", next: "La carte se tape dans la page de paiement par le navigateur : browse avec le task_id." });
        const d = await recordStep(db, t, { action: kind === "personal" ? "fill_personal" : "log_in", amountCents: 0, detail: ref });
        if (d.decision !== "allowed") return ok(d);
        const rt = vaultRuntime();
        const r = await fillFromVault(db, rt.vault, rt.browser, { userId: user.id, taskId: t.id, ref });
        if (r.status === "filled") return ok({ filled: r.fields, ref });
        if (r.status === "missing") return ok({ available: false, ref, next: `Rien au coffre pour ${name} (vault_request_link envoie le lien du coffre).` });
        return ok({ available: true, ref, note: `identifiant disponible pour ${name}, mais le navigateur n'est pas encore branché : rien n'a été tapé` });
      }
      case "vault_assign_pending": {
        const { vault } = vaultRuntime();
        const pending = makeRef("login", PENDING_SITE);
        const login = await vault.backend.getLoginForInjection(user.id, PENDING_SITE);
        if (!login) return err("aucun mot de passe en attente de classement");
        const ref = await vault.putLogin(db, user.id, String(a.site), login, { actor: "agent", detail: "classé depuis le fil" });
        await vault.deleteEntry(db, user.id, pending, { actor: "agent", detail: `classé sous ${ref}` });
        return ok({ stored: ref });
      }
      case "vault_delete": {
        const ref = String(a.ref) as VaultRef;
        parseRef(ref);
        return ok({ deleted: await vaultRuntime().vault.deleteEntry(db, user.id, ref, { actor: "agent", detail: "demandé par l'utilisateur" }), ref });
      }
      default:
        if (Object.hasOwn(GOOGLE_TOOL_SPECS, name)) return runGoogleTool(db, user, name, a);
        if (Object.hasOwn(MAIL_TOOL_SPECS, name)) return runMailTool(db, user, name, a);
        if (APP_TOOLS.has(name)) return runAppTool(db, user, name, a);
        return err(`outil inconnu : ${name}`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/** Un parcours enregistré, avec repli sur la boucle d'agent. Les données du site restent des données. */
async function siteTool<K extends SiteName>(user: User, site: K, q: SiteQuery[K]): Promise<string> {
  // Un parcours de site prend 20 à 40 s : la bulle d'avancement dit où Mell en est, puis passe en « ✓ ».
  const rt = browserRuntime();
  const name = { doctolib: "Doctolib", sncf: "SNCF Connect", thefork: "TheFork", booking: "Booking" }[site];
  if (rt) await progress(rt.db, user.id, user.lang === "en" ? `Checking ${name}` : `Je regarde sur ${name}`).catch(() => {});
  const r = await siteSearchForUser(user, site, q);
  const host = { doctolib: "doctolib.fr", sncf: "sncf-connect.com", thefork: "thefork.fr", booking: "booking.com" }[site];
  return ok({
    [site]: r.ok ? "found" : "failed",
    via: r.via,
    results: r.data !== undefined ? wrapUntrusted(JSON.stringify(r.data), host) : undefined,
    answer: r.answer,
    blocked_on: r.via === "horaires" ? undefined : r.reason,
    seconds: Math.round(r.ms / 1000),
    // Des faits sur ce qui a été lu, jamais une façon de le dire (nombre de bulles, phrases toutes faites).
    next: r.via === "horaires"
      ? "Horaires officiels SNCF, sans prix ni places : le prix se voit au moment de réserver."
      : r.ok
      ? undefined
      : "Rien n'a été lu sur le site au-delà de ce qui est ci-dessus : aucun horaire, prix, nom ni disponibilité d'autre.",
  });
}

const ok = (v: Record<string, unknown>) => JSON.stringify(v);
const err = (message: string) => JSON.stringify({ error: message });
