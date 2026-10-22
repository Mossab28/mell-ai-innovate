# Règles de construction de Mell

Pour toute personne ou tout agent qui touche au code. Le but : que chaque avancée de modèle profite à tout, et que chaque brique se remplace sans réécrire le reste. Les modèles changeront (Sonnet aujourd'hui, un modèle ouvert entraîné demain) ; l'environnement autour d'eux doit rester.

## 1. Un agent, un modèle

- Un seul agent reçoit chaque message et décide. Aucun modèle à côté qui trie, juge, réécrit ou valide : des modèles qui ne se parlent pas produisent des réponses qui se contredisent dans le fil.
- Un seul modèle pour tous les rôles, réglé par `MELLA_MODEL` (chaque rôle reste surchargeable par `MELLA_MODEL_*` pour un banc, jamais par défaut).
- Une nouvelle capacité = un outil de l'agent. Pas un chemin, pas un juge, pas un modèle de plus.

## 2. Agnostique du modèle et du fournisseur

- Le code ne dépend jamais d'un modèle ni d'un fournisseur. Tout appel passe par `Llm.chat` (`llm.ts`) ; ce qui est propre à un fournisseur (réflexion, cache, types de bloc) reste dans `llm.ts`.
- Pas d'outil serveur d'un fournisseur exposé à l'agent : un outil est toujours exécuté par notre code, avec un schéma à nous. Son implémentation peut appeler un service (la recherche web appelle aujourd'hui l'API Anthropic) mais doit pouvoir être remplacée sans changer le schéma.
- Toute dépendance externe a une interface et au moins deux implémentations : la vraie et une factice ou en mémoire pour les tests (modèle, navigateur, recherche, coffre, mail, canal de messages).
- Les traces (prompt envoyé, outils, résultats) servent à entraîner le modèle ouvert : un changement de prompt, de schéma d'outil ou d'architecture se signale à la session d'entraînement.

## 3. L'environnement plutôt que les garde-fous

- On rend le modèle meilleur en lui donnant ce qu'il faut voir et les moyens d'agir : le contexte, les résultats de ses outils, l'état réel de la page, la source de ce qu'il a dit. Pas en empilant des interdits.
- Aucune règle déterministe sur le comportement : pas de mots-clés, de regex ou de listes de phrases pour décider à sa place (« oui » reconnu par liste, routage par mot-clé). Le modèle décide. Les regex servent à lire un format (une date, un numéro), jamais à juger une intention.
- Le code garde seulement la plomberie (file d'envoi, verrous, reprises) et la sécurité mécanique : l'accord vérifié sur les mots de la personne, le plafond de dépense, le coffre, la frontière avec le contenu tiers.
- Jamais de message écrit d'avance à la place du modèle pour décrire une situation qu'il n'a pas vue (le « valide dans l'appli de ta banque » envoyé au clic, sans regarder la page, était faux).
- Jamais d'effacement de contexte entre deux parties du système : si Mell a écrit quelque chose, le tour suivant doit en voir la source, sinon il croit avoir inventé et se dément.

## 4. Les prompts

- Courts, en principes, comme on briefe quelqu'un de compétent. Quelques exemples de ton, jamais une liste de « jamais ».
- Ce qui concerne un outil va dans la description de l'outil, pas dans la persona.
- Un message système glissé dans la conversation (« [système] ... ») dit un fait (ce qui est arrivé, ce que l'outil a rendu), pas une consigne de comportement de plus.
- Les leçons apprises en faisant vont dans les modes d'emploi (skills, voir `SELF-IMPROVEMENT.md`), pas dans la persona.

## 5. Mesurer avant de dire « ça marche »

- Tout changement de comportement se mesure avant et après sur les bancs (`server/bench/real-flows.ts`, bancs de la session d'entraînement). Un banc qui passe se relit : un 4/4 a déjà caché un Mell qui ne réservait pas.
- Instinct est la référence, pas la vérité : ses faits se revérifient, et le but est le meilleur des deux sur chaque critère (fait vraiment, parle peu, relance quand une échéance existe, exactitude, temps).
- Les bancs qui coûtent tournent sur une clé ou un compte à part de la prod, pour que la facture se lise.

## 6. Mettre en prod

- Jamais pendant qu'une personne teste : vérifier que son dernier message a sa réponse et qu'aucun travail n'est ouvert (`/admin/debug`), sauf si le correctif est ce qui la débloque.
- `infra/server/deploy.sh` après chaque commit utile ; pousser sur GitHub à chaque commit.
- Une migration de base par changement de schéma (`server/migrations/NNN_*.sql`), jamais d'édition d'une migration déjà passée.

## 7. Écriture

- Code, commentaires et textes en français, comme le reste du dépôt. Un commentaire dit pourquoi, avec le cas réel qui l'a motivé quand il y en a un.
- Jamais de tiret long ni de tiret moyen, ni dans le code, ni dans les textes, ni dans les commits.
- Les textes vus par la personne sont écrits par le modèle ; le code n'en contient que pour la mécanique (accueil, pages web, erreurs du coffre), dans la langue de la personne.
