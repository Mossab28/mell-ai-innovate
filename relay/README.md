# Relais iMessage

Tourne sur le Mac qui tient une ligne Mell, dans une **session macOS dédiée** connectée à l'identifiant Apple de Mell (jamais le tien).

## Une fois

1. Session « Mell » : se connecter à Messages avec l'identifiant Apple de Mell, envoyer un message à la main pour vérifier.
2. Réglages > Confidentialité et sécurité > **Accès complet au disque** : ajouter le Terminal (ou l'app qui lance le relais). Sans ça, `chat.db` est illisible.
3. Au premier envoi, macOS demande d'autoriser le Terminal à piloter **Messages** (Automatisation) : accepter.
4. Réglages > Économie d'énergie : empêcher la mise en veille. Laisser la session ouverte (changement rapide d'utilisateur pour revenir à la sienne).

## Lancer

```bash
MELLA_SERVER_URL=https://... MELLA_LINE_ID=mac1 MELLA_LINE_SECRET=... pnpm relay
```

`MELLA_DRY_RUN=1` journalise les envois au lieu de les faire. Le curseur de lecture est gardé dans `~/.mella-relay/<ligne>.json` : après une coupure, les messages manqués sont rejoués, et le serveur ignore les doublons.

## Limites connues

- AppleScript ne sait poser ni réaction (tapback) ni effet d'écran : la réaction part en emoji, l'effet est ignoré.
- Pièces jointes (photos, vocaux) : pas encore transmises.
- Conversations de groupe : ignorées.
