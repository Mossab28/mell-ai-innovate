# Banc des vrais parcours (apprentissage-2)

Vrais sites, vrai navigateur, arrêt au bouton qui engage. Notes de 0 à 2.

| Cas | Fait | Parle peu | Relance | Bulles | Au bouton | Écart avec Instinct |
|---|---|---|---|---|---|---|
| resto-precis | 1 | 1 (doublons) | - | 11 | non | Instinct confirme en une phrase finale ; Mell s'arrête sur un blocage carte sans avoir atteint la validation, avec des bulles doubles et un deuxième lien coffre renvoyé inutilement. |
| resto-precis-2 | 1 | 1 | - | 6 | non | Instinct propose immédiatement les créneaux disponibles et confirme la réservation en une seule boucle ; Mell présente les options en deux bulles séparées puis s'arrête avant d'atteindre le bouton qui engage. |
| logement-pas-cher | 1 | 0 (doublons) (contradictions) | - | 9 | non | Instinct présente d'emblée des options filtrées en chambre privée et réserve après un seul oui ; Mell a d'abord montré des dortoirs, posé plusieurs questions successives, produit des doublons de bulles et s'est auto-corrigé sur la localisation sans jamais atteindre le bouton de réservation. |
| logement-pas-cher-2 | 1 | 1 | - | 10 | non | Instinct présente les options et réserve après un seul oui ; Mell a demandé deux fois des infos manquantes (email/nom puis adresse/téléphone) et n'est jamais arrivé au bouton de confirmation. |

## resto-precis

```
[0 s] elle : réserve chez Pink Mamma samedi 20h pour 2
[203 s] Mell : Pink Mamma est complet samedi à 20h. Il reste 22h15 ou 22h30 pour 2, sinon le midi (12h, 12h15, 13h45, 14h45). Le resto garde aussi quelques places sans réservation, premier arrivé, premier servi.
[203 s] Mell : Je te prends 22h15, ou tu préfères que je regarde un autre soir ou une autre adresse ?
[205 s] elle : hmm 22h15 trop tard, tu peux checker un autre soir ? vendredi ou dimanche go
[513 s] Mell : Vendredi, rien le soir, seulement le midi (12h à 14h). Dimanche, il y a 19h45, sinon 21h15 ou 21h30.
[513 s] Mell : Je te prends dimanche 19h45 pour 2 ?
[515 s] elle : ouais go
[525 s] Mell : Pour finaliser Pink Mamma dimanche 19h45, il me faut ton nom complet, ton mail et ton numéro de téléphone, le resto les demande pour confirmer.
[527 s] elle : Camille Martin
camille.martin.essai@askmell.com
06 12 34 56 78
[590 s] Mell : Le 19h45 dimanche est bien dispo et j'ai tout rempli, mais le resto demande une carte pour garantir la table. Aucun débit, sauf no-show : 15 € par personne si tu annules moins de 48 h avant.
[590 s] Mell : Je mets ta Visa qui finit par 4242 pour valider ?
[591 s] elle : ouais go
[642 s] Mell : La réservation n'est pas passée, le resto a refusé la carte (la Visa 4242 est reconnue comme une carte de test). Rien n'a été débité, et la table n'est pas confirmée.
[642 s] Mell : Deux options : tu me donnes une autre carte via un lien sécurisé, ou tu appelles le resto, ils prennent les résa par téléphone. Je t'envoie le lien pour la carte ?
[643 s] elle : ouais vazy envoie le lien
[648 s] Mell (card) : https://mell.bench/v/qxh7eYgvOw3THK0Zb2kN6A8q8v4bZ4KHYeAD7QVzfxM
[648 s] Mell : Mets ta carte dans le lien, je finis la résa juste après. Le 19h45 peut partir vite, donc dis-moi dès que c'est fait.
[649 s] elle : c'est fait
[656 s] Mell (card) : https://mell.bench/v/g9GCcbvUZaFZHmdIsYOozIIQmBZFllPJldFy0rvElic
[656 s] Mell : Je ne vois pas ta nouvelle carte de mon côté, il n'y a que la 4242 dans le coffre. Je t'ai renvoyé un lien, tu peux réessayer ? Dis-moi quand c'est fait et je finis la résa.
```

## resto-precis-2

```
[0 s] elle : réserve chez Pink Mamma samedi 20h pour 2
[134 s] Mell : Rien à 20h samedi chez Pink Mamma. Les créneaux les plus proches pour 2 : 22h15 ou 22h30 le soir, ou 15h45 l'après-midi (j'ai regardé sur leur système de réservation, TheFork bloquait).
[134 s] Mell : Ils gardent aussi des places sans réservation, premier arrivé premier servi, mais à 20h le samedi ça risque d'être long.
[134 s] Mell : Je te prends 22h15, ou tu préfères un autre soir ou un autre resto ?
[136 s] elle : ah ouais 22h c tard. y a rien vers 19h30 ou 21h ?
[138 s] Mell : D'après ma lecture, rien entre 15h45 et 22h15 samedi, donc ni 19h30 ni 21h. Je peux regarder un autre soir de la semaine chez Pink Mamma, ou te chercher un italien équivalent samedi vers 20h, tu préfères quoi ?
[140 s] elle : hmm ouais 22h15 go alors, vazy réserve
[148 s] Mell : Je m'en occupe, ça prend quelques minutes. Si le formulaire demande ton nom de famille, ton mail ou ton numéro, je te les demanderai, je n'ai encore rien de toi.
[148 s] Mell : [rien]
```

## logement-pas-cher

```
[0 s] elle : trouve moi un hôtel pas cher près de la gare de Lyon pour demain soir
[44 s] Mell : Peu de chambres pas chères près de la gare de Lyon pour demain soir. Le plus proche en chambre privée : l'ibis budget Porte de Bercy (138 €, annulation gratuite). L'appart-hôtel du 12e est noté 9,0 (prix à voir sur la page). Sinon, en dortoir : Résidence Internationale 54 € (petit-déj compris) ou Peace & Love 35 €.
[44 s] Mell (card) : ibis budget Paris Porte de Bercy · 138,00 € · booking.com
https://mell.bench/c/RMuwhVU3LMn4
[44 s] Mell (card) : Appart Hotel Paris Cosy Apartment Paris 12eme Gare de Lyon Bercy · booking.com
https://mell.bench/c/7IettblvvYcW
[44 s] Mell (card) : Résidence Internationale De Paris · 54,00 € · booking.com
https://mell.bench/c/dSY2tQsk0b2y
[44 s] Mell (card) : Peace & Love Hostel · 35,00 € · booking.com
https://mell.bench/c/aWX383p1A6pw
[44 s] Mell : Mets 👍 sur celle que tu veux et je m'en occupe. Si tu préfères une chambre privée, dis-moi ton budget max.
[46 s] elle : Chambre privée, 90 € max
[351 s] Mell : Camille, je n'ai trouvé aucune chambre privée à 90 € max près de la gare de Lyon pour demain soir. Sur Booking, la moins chère dans le 12e est le Campanile Bercy Village à 259 € (note 8,1), l'ibis Ledru-Rollin est à 405 €, et l'ibis budget Porte de Bercy à 138 € (annulation gratuite) reste le moins cher que j'aie vu. Les 60 à 80 € qu'on voit sur le web sont des tarifs « à partir de » qui ne valent pas pour demain.
[351 s] Mell : Je peux élargir à d'autres quartiers de Paris ou en proche banlieue en transports, ou viser mercredi soir si tes dates bougent. Tu préfères quoi ?
[352 s] elle : Élargis à d'autres quartiers vazy, tant que c'est sous 90 €
[455 s] Mell : Une seule option sous 90 €, deux juste au-dessus :
[455 s] Mell (card) : habitat la DHUYS · 70,00 € · booking.com
https://mell.bench/c/fZaEw6LXSekn
[455 s] Mell (card) : Hôtel Résidence Saint Ouen · 99,00 € · booking.com
https://mell.bench/c/LPZ6Fi7_Ks_U
[455 s] Mell (card) : Chez nous · 92,00 € · booking.com
https://mell.bench/c/djk7OySFsvCr
[455 s] Mell : Mets 👍 sur celle que tu veux, ou dis-moi si tu veux que je cherche autre chose.
[455 s] Mell : Seule la première passe sous ton plafond : habitat la DHUYS à Saint-Ouen, 70 €, appartement privé noté 7,5 (seulement 13 avis). Les deux autres le dépassent : Hôtel Résidence Saint Ouen à 99 € (salle de bains commune, note 6,7) et "Chez nous" à Ivry à 92 € (note 6,4, 8 avis).
[457 s] elle : 👍 la première, habitat la DHUYS, vazy go
[467 s] Mell : Je m'en occupe, la réservation est en cours.
[467 s] Mell : Petite correction : habitat la DHUYS est à Montreuil (2,5 km du centre), pas à Saint-Ouen comme je l'avais écrit. Je te confirme dès que c'est bouclé, avec l'adresse et les conditions d'annulation.
```

## logement-pas-cher-2

```
[0 s] elle : trouve moi un hôtel pas cher près de la gare de Lyon pour demain soir
[161 s] Mell : Demain soir en chambre privée, rien de vraiment pas cher près de Lyon. Le moins cher, ce sont des lits en dortoir : The People Bercy 86 € (8,9), Meininger Vincennes 68 € (8,0, dortoir femmes). En chambre : Campanile Bercy 259 € (8,1) ou Viator, à 250 m de la gare, 321 € (8,0). Prix pour 1 adulte, 1 nuit.
[161 s] Mell (card) : The People - Paris Bercy · 86,00 € · booking.com
https://mell.bench/c/GMy_hQ52ji1b
[161 s] Mell (card) : MEININGER Hotel Paris Porte de Vincennes · 68,00 € · booking.com
https://mell.bench/c/uIe26mvKpPF2
[161 s] Mell (card) : CAMPANILE PARIS 12 - Bercy Village · 259,00 € · booking.com
https://mell.bench/c/8tPEvYJTuN1-
[161 s] Mell (card) : Hotel Viator - Gare de Lyon · 321,00 € · booking.com
https://mell.bench/c/2sZ2THsoMyzi
[161 s] Mell : Mets 👍 sur celle qui te va, et je m'en occupe. Si un dortoir te va, The People Bercy est le meilleur rapport qualité/prix.
[163 s] elle : Mell, je veux une chambre pour moi seule, pas un dortoir. Rien en dessous de 90 € ? Mon budget c'est 90 max
[267 s] Mell : Les deux chambres privées les moins chères que je trouve : hotelF1 Porte de Châtillon 118 € (+28 €, 4,9 km) et ibis budget Porte de Bercy 138 € (+48 €, 2,6 km). Les deux avec annulation gratuite.
[267 s] Mell (card) : hotelF1 Paris Porte de Châtillon (14e) · 118,00 € · booking.com
https://mell.bench/c/79rEZbKpZmJ2
[267 s] Mell (card) : ibis budget Paris Porte de Bercy (Charenton-le-Pont) · 138,00 € · booking.com
https://mell.bench/c/etblfQ15_cL0
[267 s] Mell : Rien en chambre privée à 90 € max près de la gare de Lyon pour demain soir. Sous ce prix, il n'y a que des dortoirs, ou l'Hotel Petit Vix à 80 € (note 2,5, salle de bains commune), donc je l'écarte.
[267 s] Mell : Mets 👍 sur la carte qui te va si tu veux relever un peu le budget, sinon je peux surveiller les prix au cas où une chambre se libère à 90 € ou moins.
[270 s] elle : Mell n'a rien trouvé de correct à 90 max, donc le but n'est pas atteint. Mais il me demande de choisir : relever le budget ou surveiller les prix. Je fais confiance, je prends sa reco la moins chère.

go pour hotelF1 118, vazy réserve
[280 s] Mell : Je m'en occupe : hotelF1 Porte de Châtillon, 118 €, nuit du 20 au 21. Je te confirme dès que c'est réservé, avec l'adresse et les conditions d'annulation.
[280 s] Mell : Il me faudra ton nom complet et ton email pour remplir la réservation, tu peux me les donner ici ?
[281 s] elle : Camille Martin, camille.martin.essai@askmell.com
[456 s] Mell : Deux choses bloquent, Camille. Booking demande ton adresse, ta ville et ton numéro de téléphone, que je n'ai pas. Et le total réel est de 118,10 € avec la taxe de séjour, soit 10 centimes de plus que ton plafond de 118 €.
[456 s] Mell : Tu me donnes ton adresse et ton téléphone ici, et tu me confirmes les 118,10 € ? Le paiement se fait sur place et l'annulation est gratuite jusqu'au 20 octobre.
[458 s] elle : ouais 118,10 ok. 06 12 34 56 78. adresse je l'ai pas sous la main, mets ce que tu as, vazy
[471 s] Mell : Je suis encore dessus, Camille : la réservation de l'hotelF1 est en cours (118,10 € max, nuit du 20 au 21). Je ne mets que Paris comme adresse, sans rien inventer. Je te confirme dès que c'est validé ou si Booking exige une adresse complète.
```
