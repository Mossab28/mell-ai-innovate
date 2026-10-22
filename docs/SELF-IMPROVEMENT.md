# Mell s'améliore tout seul

Plan validé par Moss'Ab le 19/10/2026 (« on va faire ça »), repris de Hermes Agent (Nous Research, open source, code lu dans `~/Projects/instinct-research/oss/hermes-agent` : `agent/background_review.py`, `agent/curator.py`, `tools/memory_tool.py`, `tools/session_search_tool.py`). Le but : qu'une personne voie son agent faire une erreur une fois, et pas la deuxième. Tout vit dans notre base et notre code, indépendamment du modèle : ce qui est appris profite à Sonnet aujourd'hui comme au modèle ouvert demain.

## Ce que fait Hermes, en bref

1. **Des savoir-faire écrits par l'agent** (skills, format `SKILL.md` du standard agentskills.io) : la marche à suivre pour une classe de tâches, les pièges (« une règle générale + pourquoi »), comment vérifier. Des leçons, jamais un journal (pas de dates, pas de numéros d'incident, pas de citations).
2. **Une revue après chaque échange** : une copie du même agent relit la conversation et met à jour les savoir-faire et la mémoire. Signaux : l'utilisateur a corrigé le style ou la méthode, une technique nouvelle a marché, un savoir-faire utilisé s'est révélé faux. « Rien à retenir » est permis, mais pas par défaut.
3. **Ne jamais retenir** : les pannes d'environnement, les affirmations négatives sur un outil (« le navigateur ne marche pas », qui se transforment en refus pendant des mois), les erreurs passagères, les récits de tâches uniques, et les échecs non résolus présentés comme méthode.
4. **Lire avant d'écrire** : on ne modifie un savoir-faire qu'après l'avoir relu pendant la revue ; on corrige la phrase fausse au lieu d'ajouter « en fait... » en dessous ; une même leçon apprise deux fois reste une seule règle.
5. **Une mémoire bornée** : environ 800 jetons sur l'environnement, 500 sur l'utilisateur ; quand c'est plein, il faut consolider, pas empiler.
6. **Un curateur** hebdomadaire, quand l'agent est au repos : marque comme périmé ce qui ne sert plus (14 jours), archive (30 jours, jamais supprimé), consolidation des doublons en option.
7. **La recherche dans toutes les conversations passées** (plein texte), sans résumé par modèle.

## Pour Mell

### Étape 0 : plus d'effacement de contexte

Le brief du matin et la veille sont aujourd'hui rédigés par un prompt à part, avec les mails sous les yeux ; l'agent ne voit ensuite ni ces mails ni leur source, et le 19/10 il a renié son propre brief. Ils deviennent des passages du même agent : un travail de fond `quiet_ok` à l'heure dite, qui lit lui-même mails et agenda avec ses outils (donc visibles ensuite dans `recentResults`), et écrit ou se tait. La fenêtre de `recentResults` passe de 3 à 24 heures.

### Étape 1 : des modes d'emploi par site, partagés

- **Table `skills`** : nom (classe de tâche ou site), description d'une ligne, corps (Quand s'en servir, Marche à suivre, Pièges, Vérifier), domaines concernés (`sncf-connect.com`), portée (`global` ou une personne), version, nombre d'usages, dernière utilisation, statut (`active`, `pending`, `stale`, `archived`), provenance (revue, curateur, humain). Exportable en `SKILL.md`.
- **Revue** après chaque travail de fond terminé (réussi ou non), par le même modèle (`MELLA_MODEL`), avec seulement les outils `skills_list`, `skill_view`, `skill_manage` (créer, corriger). Prompts adaptés de Hermes (leçons, ne jamais retenir, lire avant d'écrire).
- **Lecture** : le navigateur reçoit les modes d'emploi du domaine où il arrive (plan et étapes) ; l'agent voit la liste des modes d'emploi (nom et description, ordre stable pour le cache) et un outil `skill_view`.
- **Exemple attendu** après la nuit du 18/10 : « SNCF Connect : choisir la gare (Paris Gare de l'Est), pas un lieu du même nom ; la carte Fluo Jeune s'ajoute dans Passagers, Cartes de réduction, sans compte ; après Payer, lire la page avant de parler de la banque. »
- **Aucune donnée personnelle** dans un mode d'emploi partagé : consigne de la revue, et refus mécanique d'une écriture qui contient une valeur de ses infos perso, un mail ou un numéro de téléphone.

### Étape 2 : apprendre de ses corrections

- Quand elle le reprend (« non, ma carte bancaire », « tout stop », « ça n'a aucun sens »), la revue en tire une leçon de portée personnelle (sa façon de faire à elle) et met à jour sa fiche.
- Une leçon qui changerait la façon de faire avec tout le monde (pas un site, un comportement) est créée en `pending` et attend le feu vert dans `/admin` : l'agent ne dérive pas seul.
- Ses leçons à elle (portée `user`, sans site) sont **en entier dans le contexte de l'agent** à chaque message (`lessonsForHer`), et non plus derrière un titre à ouvrir : le 19/10, la seule leçon apprise en prod n'avait jamais été lue. Bornées à 2500 caractères au total (`PROFILE_BUDGET`, la fiche USER.md de Hermes) : au-delà, `skill_manage` refuse et demande de regrouper. Le curateur ne les fait pas vieillir.
- Sa fiche de souvenirs (`memories`, outil `remember`) est bornée à 2200 caractères (`MEMORY_BUDGET`, MEMORY.md de Hermes), la place prise est affichée dans le contexte ; pleine, `remember` refuse et l'agent regroupe (`update_memory`) ou oublie (`forget`). Plus aucun souvenir effacé en silence (avant : les plus anciens au-delà de 200).
- `/me` montre « Ce que Mell a appris pour toi », qu'elle peut effacer.

### Étape 3 : retrouver le passé (fait le 19/10)

Un outil `history_search` (`history.ts`, plein texte français sur `messages` et `tool_calls`, Postgres ou PGlite, accents ignorés) : l'agent retrouve ce qu'elle a dit il y a trois semaines, avec le message d'avant et d'après, et ce que ses outils avaient rendu (un prix, un créneau). Seulement ce qui sort de son contexte (les 30 derniers messages y sont déjà). Passages bruts et datés, enveloppés comme données : des souvenirs, pas des demandes en cours.

### Étape 4 : le curateur (fait le 19/10)

`curator.ts`. Chaque heure, le cycle de vie, mécanique : périmé après 14 jours sans usage ni correction, archivé après 30, jamais supprimé ; un mode d'emploi périmé sert encore quand le navigateur revient sur son site, et redevient actif. Une fois par semaine (table `maintenance`), quand aucun travail n'a tourné depuis 10 minutes, le même modèle relit la bibliothèque partagée (à partir de 4 modes d'emploi) et fusionne ce qui sert la même classe de tâches : une règle par leçon, l'absorbé archivé, consignes adaptées du curateur de Hermes. Les leçons en attente d'accord et les modes d'emploi d'une personne ne sont jamais touchés. `POST /admin/curator` le lance tout de suite.

## Mesurer

- Banc des vrais parcours en mode apprentissage : le même cas deux fois de suite ; le second passage doit être plus rapide ou plus juste, et le mode d'emploi écrit au premier doit être relu au second.
- Les bancs de la session d'entraînement mesurent la stack avec et sans modes d'emploi.
- Suivi en prod : nombre de modes d'emploi créés, corrigés, utilisés ; tâches réussies par site dans le temps.

## Ce qui reste interchangeable

- Le modèle : la revue et le curateur passent par `Llm` et `MELLA_MODEL`.
- Le stockage : table à nous, export et import au format `SKILL.md`.
- Les outils de la revue ont nos schémas ; aucun outil propre à un fournisseur.
