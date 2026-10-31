# Guardian (Elexa) pour Gladys

Affiche votre **contrôleur de vanne Guardian** (Elexa, GVC1) et les
**détecteurs de fuite** appairés dans Gladys par son **API locale** (UDP port 7777) : sans le cloud Guardian, directement sur votre réseau.

> **Jamais testé avec un vrai appareil.** Sans lien avec Elexa.
> L'intégration suit aioguardian, la bibliothèque Guardian de Home Assistant,
> et les captures de ses tests. Une mise à jour du firmware peut changer
> l'API.

> **L'API locale n'a pas de mot de passe.** Toute personne sur votre réseau
> peut ouvrir ou fermer la vanne avec, avec ou sans Gladys. Gardez le
> contrôleur sur un réseau de confiance (pas de Wi-Fi invité, pas de
> redirection de port).

## Ce que vous obtenez

Un appareil par contrôleur et un par détecteur de fuite appairé, identifiés
par l'UID que donne l'appareil (jamais par son adresse IP) :

| Appareil            | Fonctionnalité          | Contenu                                                                |
| ------------------- | ----------------------- | ---------------------------------------------------------------------- |
| Contrôleur de vanne | Vanne                   | Texte : ouverte, fermée, en ouverture, en fermeture, bloquée...        |
| Contrôleur de vanne | Vanne ouverte           | 1 ouverte, 0 fermée (inchangé pendant un mouvement ou un défaut)       |
| Contrôleur de vanne | Fermer la vanne         | Bouton, **toujours disponible**                                        |
| Contrôleur de vanne | Ouvrir la vanne         | Bouton, seulement avec « Autoriser l'ouverture de la vanne »           |
| Contrôleur de vanne | Fuite (capteur intégré) | 1 fuite, 0 sec                                                         |
| Contrôleur de vanne | Température             | °C (le contrôleur donne des °F, convertis exactement : (F - 32) x 5/9) |
| Détecteur de fuite  | Fuite, Température      | Comme ci-dessus                                                        |
| Détecteur de fuite  | Pile                    | %                                                                      |
| Détecteur de fuite  | Déplacé                 | 1 quand le détecteur signale avoir été déplacé                         |

Chaque contrôleur est lu toutes les 30 secondes par défaut (10 s à 1 h), une
requête à la fois. Le capteur intégré, la liste des détecteurs appairés
(toutes les 10 minutes), chaque détecteur et le diagnostic (firmware, toutes
les 6 heures) sont secondaires : quand l'un ne répond pas, la vanne est
publiée quand même et le statut dit « Non lu : ... ». Une valeur inconnue
n'est jamais publiée comme 0 ; une valeur lue il y a plus de 2 minutes n'est
jamais envoyée comme neuve.

Le contrôleur garde les dernières valeurs de chaque détecteur ; l'API ne les
date pas : un détecteur dont la pile est vide peut continuer d'afficher ses
dernières valeurs.

## Installation

1. Donnez au contrôleur une adresse IP fixe dans votre box.
2. Dans Gladys, installez l'intégration et saisissez l'adresse IP du
   contrôleur (éventuellement suivie d'un port, 7777 par défaut). Plusieurs
   contrôleurs : leurs adresses séparées par des virgules (8 au plus).
3. Enregistrez, puis ajoutez les appareils depuis l'onglet **Découverte**.

Le contrôleur n'est jamais cherché sur le réseau : ni diffusion, ni multicast.

## Fermer la vanne (toujours)

« Fermer la vanne » est l'arrêt de cette intégration : il n'est retenu par
rien, ni option, ni lecture ou ouverture en cours (il les interrompt), ni
contrôleur qui n'a pas répondu à la dernière lecture, ni configuration pas
encore lue, ni disque lent. Il part :

- vers l'adresse où cette vanne a répondu depuis le démarrage ;
- sinon vers l'adresse où elle a été lue avant un redémarrage (gardée dans
  `/data`) ;
- sinon vers chaque adresse configurée dont le contrôleur n'a jamais été
  identifié (l'adresse que vous avez saisie).

Il est envoyé tout de suite, puis toutes les 250 ms pendant 3 secondes tant
que le contrôleur ne répond pas ou répond que sa vanne bouge (il refuse toute
commande pendant un mouvement). Il est ensuite **gardé** dans `/data` et
revérifié toutes les 15 secondes (5 secondes pendant la fermeture), même après
un redémarrage, avant même que Gladys donne la configuration, jusqu'à ce
qu'une lecture montre la vanne **fermée**. Il est renvoyé tant que la vanne
reste ouverte ou en défaut. Chaque essai accepté par le contrôleur compte :
après 3 sans effet, il est retenu (plus d'essai avant un nouveau clic) et le
statut demande de vérifier la vanne. Un silence, un contrôleur injoignable ou
une réponse « en mouvement » ne comptent pas.

La fermeture est refusée, rien envoyé, dans deux cas seulement :

- aucune adresse n'est connue (rien de configuré, rien dans `/data`) ;
- chaque adresse connue répond avec une autre vanne (un autre UID).

Une fermeture gardée est abandonnée seulement quand : une lecture montre la
vanne fermée ; une ouverture demandée dans Gladys (avec l'option) est partie ;
deux lectures de suite montrent la vanne rouverte après l'avoir vue se fermer
(ouverte depuis l'application ou le bouton du contrôleur) ; une lecture montre
un autre contrôleur à son adresse. Jamais par le temps.

Gladys reçoit sa réponse en 3,5 secondes au plus : succès quand la vanne se lit
en fermeture ou fermée ; sinon le message dit exactement ce qui s'est passé
(envoyée sans réponse, pas encore envoyée, refusée, en mouvement), et la
fermeture reste gardée.

## Ouvrir la vanne (désactivé par défaut)

« Autoriser l'ouverture de la vanne » est **désactivé** par défaut : le bouton
refuse alors toute commande. Activé, une ouverture est décidée sur une
**lecture fraîche** (jamais sur les valeurs en mémoire) et refusée quand :

- le contrôleur à l'adresse n'est pas le même (UID), ou ne peut pas le dire ;
- la vanne bouge, ou est en défaut (bloquée, moteur libre, arrêtée à
  mi-course, position inconnue) ;
- le capteur intégré détecte une fuite, ou ne peut pas être lu ;
- un détecteur appairé qui répond détecte une fuite (un détecteur qui ne
  répond pas ne bloque pas) ;
- une fermeture de ce contrôleur est en cours d'envoi (une fermeture demandée
  après une ouverture gagne toujours : l'ouverture ne part jamais après elle) ;
- l'option est désactivée avant le départ du datagramme ;
- une fermeture est gardée pour cette vanne et `/data` ne peut pas être écrit
  (un redémarrage la refermerait) ;
- le contrôleur ne répond pas à temps (rien envoyé après 2,7 s).

Une ouverture n'est confirmée que par une relecture montrant la vanne en
ouverture ou ouverte ; sinon « envoyée, sans confirmation », et la vanne est
relue après 5 et 20 secondes. L'intégration n'arrête jamais la vanne à
mi-course (un Guardian arrêté ne réagit plus à ses détecteurs de fuite).

## Statut

L'écran de configuration montre, pour chaque contrôleur : son UID, la vanne,
le nombre de détecteurs appairés, une fuite, les parties non lues, et pour
chaque fermeture gardée où elle en est. « Tester la connexion » lit chaque
contrôleur une fois, jamais avant l'intervalle de rafraîchissement.

## Limites

- Testé seulement contre un faux contrôleur construit d'après aioguardian
  2026.1.1 et ses fixtures ; jamais avec un vrai appareil.
- Ni mise à jour du firmware, ni réglage Wi-Fi, ni appairage, ni redémarrage,
  ni remise à zéro depuis Gladys : utilisez l'application Guardian.
- L'API n'a pas d'authentification (voir plus haut) : pas de mot de passe.
