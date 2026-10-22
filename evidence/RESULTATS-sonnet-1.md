# Banc du curateur (sonnet-1), modèle claude-sonnet-5-5, 23 s

- oui : moins de modes d'emploi actifs
- oui : une seule classe « réserver un restaurant »
- oui : les sites gardent leur mode d'emploi
- oui : plus de « ne marche pas »
- oui : plus de date ni de récit

Son dernier mot : - Créé : `booking`, le mode d'emploi du site Booking (booking.com), qui reprend les règles de recherche et de prix des deux modes d'emploi hôtel.
- Créé : `reserver-hotel`, la classe de tâches « trouver un hôtel », qui renvoie à `booking` au lieu de recopier ses règles.
- Corrigé : `reserver-restaurant` reprend les règles de `reservation-restaurant` (tous les horaires, deux créneaux proches). Il renvoie à `thefork` et `sevenrooms`. J'en ai retiré la phrase « TheFork ne marche pas pour les restaurants Big Mamma », qui deviendrait un refus.
- Archivé : `booking-hotel-pas-cher-pres-d-un-lieu`, entièrement repris dans `booking` et `reserver-hotel`.
- Archivé : `hotel-gare-de-lyon`, repris de la même façon. Le cas de la gare de Lyon n'était qu'un exemple de lieu.
- Archivé : `reservation-restaurant`, entièrement repris dans `reserver-restaurant`.
- Laissés intacts : `thefork` et `sevenrooms`, déjà au nom de leur site et propres.

## booking [active, v1] booking.com

# booking

## Marche à suivre
1. Saisis le lieu (gare, quartier, adresse) comme destination, avec ville et pays pour éviter les homonymes.
2. Renseigne dates et voyageurs avant de lire les prix : sans eux, les tarifs affichés ne sont pas fiables.
3. Trie par prix croissant et filtre la distance au lieu voulu (moins de 1 km si elle veut être à côté).
4. Applique le filtre chambre privée et le budget max si on les a demandés : les dortoirs et les chambres trop chères polluent la liste sinon.

## Pièges
- Le prix affiché est par nuit hors taxe de séjour : ajoute-la avant d'annoncer un total, sinon le total annoncé est trop bas.
- Les appart-hôtels n'affichent pas toujours le prix dans la liste : ouvre la fiche avant de l'annoncer, pour ne pas donner un prix absent ou faux.

## Vérifier
Chaque hôtel proposé a un prix lu sur sa fiche, pour les bonnes dates, avec sa distance au lieu demandé.

## reserver-hotel [active, v1] booking.com

# reserver-hotel

## Quand s'en servir
Dès qu'on demande un hôtel ou une chambre : lieu précis (gare, quartier, monument), dates, budget, nombre de voyageurs.

## Marche à suivre
1. Note les paramètres : lieu exact, dates d'arrivée et de départ, voyageurs, budget max, chambre privée ou non.
2. Cherche sur Booking en suivant le mode d'emploi `booking` (destination, tri, filtres, lecture des prix).
3. Garde les options proches du lieu et dans le budget, puis propose-en deux ou trois avec prix total et distance : la personne veut choisir.

## Pièges
- Ne confonds pas prix par nuit et total du séjour : annonce le total avec taxes quand tu le connais, pour qu'elle compare au budget réel.

## Vérifier
Chaque option annoncée existe sur la page, avec prix lu sur la fiche et distance au lieu demandé.

## reserver-restaurant [active, v2] thefork.fr

# reserver-restaurant

## Quand s'en servir
Dès qu'on demande de réserver une table ou de trouver un créneau (restaurant précis, date, heure, nombre de personnes), quel que soit le site de réservation.

## Marche à suivre
1. Note les paramètres : restaurant et adresse, date complète, heure, nombre de couverts.
2. Essaie d'abord TheFork, en suivant le mode d'emploi `thefork`. Si la fiche est introuvable, bloquée ou si la recherche expire, ne t'acharne pas.
3. Trouve le vrai prestataire de réservation du restaurant : fiche Google Maps (bouton « Réserver »), site officiel. Si c'est SevenRooms, suis le mode d'emploi `sevenrooms`.
4. Affiche tous les horaires du jour, pas seulement ceux proches de l'heure demandée : une liste partielle fait croire à tort que c'est complet.
5. Propose les deux créneaux les plus proches de l'heure voulue : la personne veut choisir.

## Pièges
- Note les deux créneaux les plus proches avant de répondre, sinon tu en perds un en route.

## Vérifier
Les créneaux rendus existent sur la page, avec l'heure et le nombre de couverts.

## sevenrooms [active, v1] sevenrooms.com

## Marche à suivre
1. Ouvre le module depuis le site officiel ou le bouton « Réserver une table » de Google Maps.
2. Renseigne la date et le nombre de personnes, puis « Tous les horaires ».

## Pièges
- Sans « Tous les horaires », seuls trois créneaux autour de l'heure s'affichent : on croit à tort que c'est complet.

## thefork [active, v1] thefork.fr

## Marche à suivre
1. Ouvre la fiche du restaurant.
2. Choisis la date puis le nombre de personnes, puis l'heure.

## Pièges
- Ferme le bandeau de cookies avant de cliquer : il couvre le sélecteur de date.

## booking-hotel-pas-cher-pres-d-un-lieu [archived, v1] booking.com

(archivé)

## hotel-gare-de-lyon [archived, v1] booking.com

(archivé)

## reservation-restaurant [archived, v1] thefork.fr, sevenrooms.com

(archivé)
