# Mell, la carte

État au 20/10/2026 (commit `fd01223` et suivants). À tenir à jour à chaque changement d'architecture : c'est le document que lisent les humains, les agents de code et la session d'entraînement.

## En une phrase

Un seul agent, sur un seul modèle, reçoit chaque message avec tout le contexte de la personne et tous ses outils, et décide de tout : répondre, réagir, agir, lancer un travail de fond, se fixer un retour. Autour de lui, le code ne fait que de la plomberie et de la sécurité.

```
iPhone  <->  iMessage  <->  relais (Mac, relay/)  <->  serveur (server/)  <->  modèle (MELLA_MODEL)
                                                        |-- navigateur (AgentCore AWS, server/src/browser/)
                                                        |-- coffre (OpenBao, server/src/vault/)
                                                        |-- Gmail / Agenda / apps (Google, Composio)
                                                        |-- mail de Mell (Azure, SMTP entrant)
                                                        |-- recherche web, météo, horaires de train
```

## Le trajet d'un message

1. **Relais** (`relay/`) : le Mac de la ligne lit Messages (BlueBubbles), transcrit les vocaux (whisper.cpp), pousse au serveur (`POST /relay/inbound`, signé HMAC, contrat dans `shared/src/protocol.ts`), et vient chercher les envois en long-polling (`/relay/outbox`).
2. **Tour** (`server/src/agent.ts`, `handleTurn`) : les messages reçus depuis la dernière réponse sont traités d'un bloc, sous un verrou par personne. Avant l'agent, trois gestes mécaniques seulement :
   - un code SMS attendu par une tâche du navigateur lui est remis (`browser/codes.ts`) ;
   - un 👍 sur une carte vaut son bouton (`cards.ts`) ;
   - une réaction sur une bulle devient une phrase lisible (`reactions.ts`).
3. **Agent** (`runAgentLoop`, mode `tool`, 120 s) : contexte = persona et guides (`prompt.ts`), ce que Mell sait de la personne, les 60 derniers messages, la fiche de reprise de ce qui est avant, les résultats de ses outils des dernières heures (`recentResults`), puis, juste après son dernier message, la manière d'écrire (`turnReminder`, consigne système au fil chez Anthropic). Sonnet 5.5 y réfléchit (adaptatif, effort bas ; moyen en travail de fond, `effortFor`). Il appelle ses outils (`tools.ts`) et rend une réponse rendue en bulles (`style.ts`), avec réaction ou effet éventuels.
4. **Travail de fond** (`jobs`, `runJobs`, mode `task`) : ce qui demande le navigateur ou plusieurs étapes. Même modèle, même prompt, plus d'étapes. Un seul travail à la fois sur le navigateur d'une personne ; ce qu'elle écrit pendant ce temps est lu par l'agent, qui le transmet (`work_update`, colonne `jobs.followups`) ou le traite à part. Bulle d'avancement qui s'édite (`progress.ts`), rédigée d'après les outils qui partent.
   Chaque appel d'outil passe d'abord par `tool-args.ts` (repris de Hermes) : nom retrouvé (« functions.remember »), JSON lu même dans des ``` ou avec une virgule en trop, arguments ramenés au type du schéma (« 42 », « true », une liste encodée en texte). Un modèle ouvert qui écrit un appel un peu de travers n'est plus refusé.
5. **File d'envoi** (`outbox.ts`) : textes, réactions, éditions de bulle, images, appels FaceTime ; le relais les livre et renvoie l'identifiant iMessage.
   **Deux cartes seulement** (20/10) : connecter une app (« Mell × App ») et le coffre (cadenas, paiement compris). Les options trouvées (navigateur, Booking, recherche web) partent en texte avec leur lien direct, dont iPhone montre l'aperçu ; plus de `show_cards`, `send_cards`, `send_card`, ni de brouillon de mail en carte.

## Ce qui part de lui-même

- **Rappels et routines** (`schedules.ts`) : rédigés par le modèle juste avant l'heure, avec ce qui s'est dit depuis ; silence si déjà fait. Réveils et rappels importants par appel FaceTime.
- **Retours que Mell se fixe** (`check_back`) : à l'heure dite, un travail de fond du même agent relit le fil et écrit, ou se tait.
- **Brief et veille** (`batch.ts`, `pulse.ts`) : trois passages par jour aux heures de la personne. **Encore rédigés par un prompt à part** (BRIEF_SYSTEM, PULSE_SYSTEM) : l'agent ne voit pas ensuite les mails lus pour le brief et a renié un brief le 19/10. À passer sur l'agent unique (voir `SELF-IMPROVEMENT.md`, étape 0).
- **Surveillances** (`watches.ts`) : une source relue à intervalle, un modèle compare avec la condition et la fois d'avant, Mell n'écrit que si ça change quelque chose.

## Les briques interchangeables

Chaque dépendance externe passe par une interface. La colonne « à faire » dit où ce n'est pas encore vrai.

| Brique | Interface | En prod | Autres implémentations | À faire |
|---|---|---|---|---|
| Modèle | `Llm.chat(ChatInput)` dans `llm.ts` ; un seul réglage `MELLA_MODEL` pour tous les rôles | API Anthropic, `claude-sonnet-5-5` | Bedrock (Converse), tout serveur compatible OpenAI (`MELLA_LLM=openai`, `MELLA_OPENAI_BASE`, vLLM pour le modèle ouvert), factice (tests) | |
| Canal de messages | contrat HTTP signé `shared/src/protocol.ts` | relais Mac + BlueBubbles | simulateur `sim/` | Autre canal (WhatsApp, ligne gérée) = un autre relais, même contrat |
| Navigateur | `PageDriver` / `BrowserEngine` (`browser/types.ts`, `engines.ts`) | `agentcore` (AWS, signé Web Bot Auth) | patchright, camoufox, browserless, steel, lightpanda... | |
| Parcours de site | `browser/sites/*` (recherches enregistrées, sans modèle) | SNCF, TheFork, Doctolib, Booking | repli sur la boucle d'agent | Deviendront des modes d'emploi appris (skills) |
| Recherche web | `webSearch()` dans `web-search.ts`, outil client `web_search` | recherche serveur de l'API Anthropic sur le même modèle | | Implémentation sans Anthropic (moteur HTTP) pour un modèle ouvert ; même schéma d'outil |
| Coffre | `VaultBackend` (`vault/types.ts`) | OpenBao (VPS PwnAI, tunnel SSH) | mémoire (tests) | |
| Mail sortant / entrant | `mail/outbound.ts`, `mail/ingest.ts` | Azure Communication Email, SMTP entrant | | |
| Gmail, Agenda | `google/` (OAuth et outils riches) | Google direct | | |
| Autres apps | `apps/` | Composio ; une connexion aboutie arrive à l'agent comme un fait (`[système] … vient d'être connecté`), qui reprend la demande en attente | | |
| Base | `Db` (`db.ts`) | PGlite (fichier) | Postgres (`migrate-db.ts`, seuil ~50 actifs) | |
| Transcription | sur le relais | whisper.cpp + Silero | | |
| Météo, trains | `weather.ts`, `trains/gtfs.ts` | Open-Meteo, horaires SNCF ouverts | | |

## Ce que Mell sait d'une personne

| Quoi | Où | Écrit par |
|---|---|---|
| Souvenirs (préférences, proches) | table `memories`, outil `remember` | l'agent |
| Ses leçons à elle (sa façon de faire, tirée de ses reprises) | table `skills`, portée `user` sans site, en entier dans le contexte, 2500 caractères au plus | la revue d'une conversation calmée |
| Modes d'emploi par site et classe de tâches | table `skills`, portée `global` ; liste dans le contexte, `skill_view`, chargés par le navigateur sur leur site ; curateur (`curator.ts`) | la revue après un travail de fond |
| Infos perso (nom, mail, naissance, adresse, cartes de réduction) | table `personal_info` | l'agent, et elle dans `/me` |
| Sa façon d'écrire | `users.voice_note` (`voice.ts`), refaite tous les 12 messages | le modèle, en fond |
| Ses heures | `rhythm.ts`, chaque semaine | le modèle, en fond |
| Le fil | 60 derniers messages (`HISTORY`) | |
| Ce qui est sorti du fil | fiche de reprise (`compaction.ts`, colonne `users.thread_summary`), à la Hermes et OpenClaw : ce qu'elle veut, préférences, fait (daté), en attente, ses corrections, valeurs exactes ; mise à jour (jamais refaite) dès que 12 messages sortent de la fenêtre | le modèle, en fond |
| Les résultats de ses outils | `tool_calls`, 24 dernières heures, 10 au plus : les 3 derniers jusqu'à 6 000 caractères, les autres 1 500, 16 000 en tout (coupés à 1 500, il perdait la source de ce qu'il venait de dire et se démentait, 20/10) | |
| Tout le passé | outil `history_search` (`history.ts`) : plein texte, sans accents, sur ses messages et les résultats de ses outils hors du contexte, passages datés avec le fil autour | l'agent, à la demande |
| Ce qui est en cours | tâches, rappels, surveillances, travaux de fond | |

## Ce qui est écrit à la main (figé)

- La persona et la façon d'écrire : `PERSONA` dans `prompt.ts` (courte, principes à la OpenInstinct / Poke, sans exemples). Pour l'agent, la façon d'écrire (`WRITING`) part après le fil. Banc de rejeu de ses vrais fils : `server/bench/replay.ts`.
- Les guides mails, agenda, apps : `google/prompt.ts`, `mail/prompt.ts`, `apps/prompt.ts` (encore longs, à alléger).
- La description de chaque outil : `tools.ts`, `google/tools.ts`, `mail/tools.ts`, `apps/tools.ts`.
- La méthode du navigateur : `STEP_SYSTEM`, `PLAN_SYSTEM` dans `browser/loop.ts`.

Rien de ce que Mell apprend en faisant ne revient encore dans ces consignes : c'est l'objet de `SELF-IMPROVEMENT.md`.

## Sécurité, mécanique et non jugée

- **Accord** : tout ce qui engage passe par une tâche (`tasks.ts`) avec actions, destinataires et plafond. L'agent valide une tâche en citant les mots de la personne (`her_words`, `authorize_task`) ; le code vérifie seulement que la citation vient d'un de ses messages des 30 dernières minutes ou d'une réaction positive (`saidByHer`).
- **Argent** : la dépense se compte au clic du navigateur sur le site, sous le plafond ; l'attente de la banque ne commence que si la page affiche une validation bancaire ; un paiement qui n'aboutit pas est rendu (`releasePayment`).
- **Secrets** : le modèle ne voit que des références `vault://...` ; les valeurs sont tapées par le navigateur (`vault/inject.ts`).
- **Coffre dans l'espace web** (21/10) : `/me` ne montre rien du coffre. `/me/coffre` s'ouvre avec un code du coffre (Messages, mail en secours ; `web_codes.purpose = 'vault'`, un code de connexion ne l'ouvre jamais), pour 5 minutes par session (`web_sessions.vault_until`) ; voir, ajouter ou retirer un identifiant, une carte ou une info perso l'exige.
- **Contenu tiers** : pages, mails et résultats d'outils arrivent enveloppés (`untrusted.ts`) et ne sont jamais des ordres.

## Bancs

| Banc | Ce qu'il mesure |
|---|---|
| `server/bench/real-flows.ts` | vrais sites, vrai navigateur, utilisateur simulé qui écrit comme Moss'Ab, arrêt au moment de mettre la carte (`MELLA_BENCH_DRY_RUN`), notes fait / parle peu / relance face à Instinct |
| `server/bench/autonomy/` | stack complète en monde fixe (session d'entraînement), 17 tâches vérifiées |
| `server/bench/demos.ts` | 36 démos d'Instinct adaptées à la France, juge |
| `server/bench/thread-booking.ts`, `live-booking.ts`, `sites-bench.ts`, `web-e2e.ts` | fil rejoué, réservation réelle sans paiement, parcours de site, site web |

## Restes à nettoyer

- `router.ts`, `decisions.ts`, `humanize.ts` : plus appelés par le chemin d'un message (gardés pour les bancs anciens).
- `README.md` décrit encore le tri en quatre chemins et Bedrock par défaut.
- `infra/server/deploy.sh` fait `rsync --delete` : il efface les sauvegardes locales du serveur (`~/mell/backups`) ; S3 les garde.
