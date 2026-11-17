# Audit du mode hors ligne — Wakara

Date : 17/11/2026. Dépôt audité : `29353ee` (branche `main`).

Périmètre : tout le mode hors ligne, côté navigateur (`frontend/src/app/core/offline/`, écrans de verrouillage et de synchronisation, service worker)
et côté serveur (`backend/sync/`, jetons liés à l'appareil, rejeu des opérations par les services métier).

Méthode : lecture complète du code (≈ 4 900 lignes), **sondes actives** contre l'API de synchronisation (fichier jetable, supprimé après l'audit),
exécution des tests existants du mode hors ligne. **Non vérifié** : le comportement sur de vrais téléphones (Android, iPhone), le service worker en
production sur Vercel, les volumes réels (plusieurs milliers de dossiers sur un poste du secrétariat).

## Verdict

Le socle est **solide et sûr** : rien ne se perd, rien ne s'applique deux fois, les droits sont revérifiés par le serveur, les données de l'appareil sont
chiffrées. Les anomalies trouvées ne sont pas des failles de sécurité : ce sont **3 défauts de cohérence confirmés par sonde**, **3 risques de perte ou de
retard des saisies** propres à l'usage sur le terrain, et des points d'amélioration. Aucun n'empêche l'usage, mais les deux premiers produisent des
refus incompréhensibles pour le secrétariat et doivent être corrigés avant un usage intensif hors ligne par ce rôle.

## Ce qui fonctionne (vérifié)

| Domaine | Constat |
|---|---|
| Chiffrement | Code → PBKDF2-SHA256 (600 000 tours) → clé qui enveloppe une clé de données AES-GCM 256 aléatoire, **non extractible**, gardée en mémoire seulement. Opérations, dossiers, photos, pages en cache et session sont chiffrés. Blocage progressif après 5 codes faux (1, 2, 4… 30 min), auto-verrouillage après 15 min d'inactivité, code d'au moins 8 caractères mêlant lettres et chiffres (ou phrase de 14). |
| Une base par compte | Chaque compte a sa propre base locale ; un autre compte est refusé sur un appareil qui contient encore des opérations non envoyées. |
| File d'opérations | Chaque opération a un identifiant (`op_id`) ; le serveur la reconnaît si elle est renvoyée (réponse perdue, onglet fermé, double clic) : **ni perte ni doublon**. Un état « envoi en cours » interrompu redevient « en attente » au redémarrage. Une opération refusée bloque les suivantes du même dossier. |
| Rejeu côté serveur | Chaque opération repasse par les **mêmes services que l'API en ligne** : droits, flux de validation, champs obligatoires, règle des 6 mois, numérotation, doublons. Le secrétariat et l'administrateur voient tout le service, l'agent seulement ses dossiers. |
| Décisions sur données périmées | Une validation ou un renvoi est refusé (conflit) si le dossier a changé depuis ce que l'appareil montrait (`from_status`, `base_version`). |
| Horloge de l'appareil | Mesure de l'écart avec le serveur, correction, rejet des dates futures ou antérieures à la naissance, marquage des saisies tardives, trace dans le journal. |
| Appareils | Session liée à l'appareil (un jeton volé ne sert pas depuis un autre), révocation immédiate, limite de 3 appareils par compte, interrupteur à distance `offline.enabled`. |
| Données de référence | Hôpitaux et règles reçus **en premier** à chaque synchronisation (la liste vide n'écrase jamais la liste connue) ; formulaires utilisables même si le reste échoue. |
| Reprise | Nouvelle tentative automatique espacée (5 s → 5 min) sur coupure, erreur serveur et limitation ; isolation de l'opération fautive quand tout l'envoi est refusé ; délais maximaux (30 s, 120 s pour une photo). |
| Lecture hors ligne | Listes, dossiers, actes, pièces, statistiques et toute page déjà consultée en ligne (250 pages gardées, chiffrées). |
| Après le correctif d'aujourd'hui | Les jetons d'accès révoqués à la déconnexion ou au changement de mot de passe ne cassent pas la file : elle attend la reconnexion avec le mot de passe et reprend. |

Tests exécutés : voir « Tests » en fin de document.

## Anomalies

### A. Défauts de cohérence — confirmés par sonde

**A1 — Moyenne — Modifications empilées après une étape : conflit de version parasite.**
Chaque enregistrement d'un dossier augmente son numéro de version, y compris un changement d'étape. Quand le secrétariat, hors ligne, modifie un dossier, le
soumet, puis le modifie encore (ce qu'il peut faire tant qu'il a aussi le droit de valider), le téléphone envoie la modification finale avec **la version
connue avant l'envoi** ; le serveur a déjà avancé en appliquant les opérations précédentes du même lot et répond « conflit de version » sur la propre
modification de l'utilisateur. Sonde : `[appliquée, appliquée, conflit version_conflict]`. Avec une version vide, le serveur répond « refusée : version de
référence manquante » (le client masque cela en inventant la version, ce qui produit le conflit ci-dessus).
*Solution* : envoyer avec chaque opération la dépendance « après l'opération X » au lieu d'un numéro de version ; le serveur contrôle que X est appliquée
et compare la version produite par X. Variante minimale : ne contrôler la version que pour la **première** opération d'un dossier dans l'envoi, et
accepter les suivantes si les précédentes du lot ont réussi.

**A2 — Moyenne — La règle « on ne valide pas ce qu'on a soumis » n'existe pas hors ligne.**
Ajoutée aujourd'hui côté serveur, elle n'est pas recopiée sur l'appareil. Le secrétaire qui a soumis un dossier voit sur son téléphone le bouton « Valider »,
le dossier apparaît « validé » à l'écran, puis l'opération est **refusée à la synchronisation** (sonde : `rejetée — Séparation des tâches…`). Le serveur reste
l'autorité, donc rien d'incorrect n'est enregistré, mais l'utilisateur croit avoir validé.
*Solution* : le serveur envoie dans les règles de référence `separate_submit_and_validate` et, dans l'historique de chaque dossier, l'identifiant de celui qui
a fait chaque étape ; l'appareil retire « Valider » pour qui a soumis. Ajouter un test miroir (comme pour le flux des étapes).

**A3 — Moyenne — Une saisie de plus de 30 jours perd sa date.**
Au-delà de `SYNC_MAX_DEVICE_AGE_DAYS` (30 jours) la date de l'appareil est écartée et la date de la synchronisation est retenue (sonde : anomalie `too_old`,
`received_at` = jour de la synchronisation). Un agent en zone sans réseau plusieurs semaines, ou un téléphone remis en service après un mois, fausse ainsi la
date d'enregistrement — qui compte pour le délai légal de 6 mois.
*Solution* : porter la limite à 120 jours (cohérent avec les 6 mois) en conservant le marquage « saisie ancienne, à vérifier » à partir de 7 jours ; et alerter
l'agent sur l'appareil dès qu'une opération attend depuis plus de 3 jours (voir B2).

### B. Risques de perte ou de retard des saisies

**B1 — Moyenne — Les données restent sur l'appareil après un retrait de droits ou une révocation.**
Sonde : après retrait du rôle du secrétariat, le serveur refuse la lecture (403) mais l'appareil **garde** tous les dossiers du service et les pages en cache,
lisibles avec le code. Une révocation d'appareil bloque la synchronisation mais n'efface rien non plus.
*Solution* : sur refus définitif (révocation, droit perdu, compte désactivé), effacer les **copies** de dossiers et le cache, conserver les opérations non
envoyées (à exporter ou à renvoyer après réintégration), et afficher pourquoi. Option : champ « effacer à distance » sur l'appareil, appliqué à la prochaine
connexion.

**B2 — Moyenne — La synchronisation ne tourne que si l'appareil est déverrouillé et la page ouverte.**
Le verrouillage automatique (15 min) ferme le moteur : plus aucun envoi tant que le code n'est pas ressaisi. Il n'y a pas de synchronisation en arrière-plan
(page fermée) et aucun rappel quand des opérations attendent depuis longtemps ; seul l'écran de verrouillage affiche leur nombre.
*Solution* : (1) à l'auto-verrouillage, **finir d'envoyer** la file déjà prête pendant 10 minutes avant d'oublier la clé ; (2) bandeau et notification dès
qu'une opération attend depuis plus de 24 h ; (3) enregistrer une tâche de synchronisation en arrière-plan là où le navigateur la permet (Chrome Android) ;
(4) consigne dans le guide : « synchroniser avant de quitter une zone couverte ».

**B3 — Moyenne — Le navigateur peut effacer les données de l'appareil sans prévenir.**
« Effacer les données du site », manque d'espace, ou (iPhone, Safari hors application installée) nettoyage après 7 jours sans usage : la base **et** le coffre
disparaissent ensemble, avec les opérations non envoyées. `navigator.storage.persist()` est demandé mais son refus n'est jamais signalé.
*Solution* : afficher le résultat de `persist()` et un avertissement si refusé ; recommander et guider l'installation sur l'écran d'accueil (application
installée = stockage protégé sur iPhone) ; bouton « Sauvegarde de secours » exportant la file chiffrée vers un fichier ; rappel d'envoi (B2).

**B4 — Basse — Aucun brouillon automatique du formulaire.**
Une saisie non enregistrée est perdue si l'appareil se verrouille (15 min sans touche), si la page se recharge ou si le navigateur est fermé.
*Solution* : enregistrement automatique du brouillon toutes les 30 s (opération locale, déjà supportée pour l'agent), reprise proposée à la réouverture.

### C. Fiabilité des lectures et performances

**C1 — Moyenne — Pages anciennes présentées comme actuelles.**
Une page lue depuis le cache (statistiques, listes d'actes, doublons, utilisateurs…) s'affiche sans indiquer sa date, alors que la date est connue. Elles
peuvent dater de plusieurs semaines. Le cache contient aussi des pages sensibles (journal d'audit, utilisateurs, dossiers de doublons) : chiffrées, mais sans
durée de vie.
*Solution* : bandeau « Page consultée le … (hors connexion) » ; durée de vie de 7 jours ; exclure du cache l'audit, les utilisateurs et les décisions de
doublons (inutiles hors ligne).

**C2 — Basse — Lecture hors ligne en O(n).**
Chaque liste ou compteur hors ligne déchiffre **tous** les dossiers connus. Pour un secrétariat avec plusieurs milliers de dossiers, comptez plusieurs
secondes (téléphone d'entrée de gamme : davantage). Non mesuré.
*Solution* : garder en mémoire, pendant la session, la liste déjà déchiffrée et la mettre à jour par dossier ; ou un petit index chiffré (état, date, hôpital).

**C3 — Basse — Curseur de lecture fondé sur l'heure de modification.**
Une transaction longue qui se termine après une lecture plus récente peut faire sauter un dossier. Les égalités d'horodatage sont bien traitées, pas ce cas.
*Solution* : recouvrement de 2 minutes sur le curseur (la réception est idempotente).

**C4 — Basse — Taille d'envoi réduite définitivement à 1.**
Après un refus 400/413 d'un lot, la taille de lot reste à 1 pour toute la session : synchronisation plus lente. *Solution* : la remettre à la valeur du serveur à
chaque cycle.

**C5 — Basse — Retrait d'une pièce déjà envoyée, hors ligne.**
La suppression n'est pas mise en file (le droit `document.archive` demande le serveur) mais l'écran affiche l'erreur réseau générique au lieu de « cette
action nécessite la connexion ». *Solution* : router par la garde « nécessite le serveur ».

## Corrections apportées (17/11/2026)

Toutes les anomalies sont corrigées et testées (A1 à A3, B1 à B3, B4, C1 à C5), sauf la synchronisation page fermée, impossible sans affaiblir le chiffrement (voir B2), et le point C2, à mesurer sur de vrais volumes.

| # | Correction | Vérification |
|---|---|---|
| A1 | Une opération empilée sur une autre du même dossier envoie `after_op` ; le serveur attend la version produite par celle-ci (relue en base après chaque opération). Le changement d'une autre personne en reste un conflit ; l'opération de quelqu'un d'autre ne peut pas servir de référence. | `tests/test_offline_audit_fixes.py` (5), `offline.spec.ts` |
| A2 | Le serveur n'affiche plus « Valider » à qui a soumis le dossier (en ligne aussi) ; il envoie la règle (`separate_submit_and_validate`) et l'auteur de chaque étape ; l'appareil retire « Valider », refuse l'action avec le même message et compte une soumission faite hors ligne. | idem (3 + 2) |
| A3 | `SYNC_MAX_DEVICE_AGE_DAYS` passe de 30 à 120 jours : la date est conservée et marquée « saisie ancienne » dès 7 jours. | idem (2) |
| B1 | Code `access_lost` (droits retirés) et appareil révoqué : l'appareil efface les copies de dossiers et le cache, **garde** les saisies non envoyées et l'explique par des bandeaux. | idem (1 + 2) |
| B2 | À l'auto-verrouillage ou au verrouillage manuel, la file prête est envoyée avant l'oubli de la clé (10 minutes au plus) ; bandeau rouge et message à l'écran de code au-delà de 24 h d'attente. La synchronisation en arrière-plan page fermée n'est **pas** possible : la file est chiffrée, la clé n'existe qu'en mémoire (c'est ce qui la protège). | `offline.spec.ts` (ancienneté), essai réel à faire |
| B4 | Le formulaire de saisie enregistre un brouillon chiffré toutes les 15 s, à chaque changement d'onglet et à la fermeture de la page ; il le propose à la réouverture (« Reprendre cette saisie ») et l'efface une fois le dossier enregistré (7 jours au plus). Les photos non enregistrées n'en font pas partie. | `offline.spec.ts` |
| C1 | Une page lue depuis la copie de l'appareil s'affiche avec sa date (bandeau « peut ne plus être à jour ») ; plus servie au-delà de 7 jours ; l'audit, les utilisateurs, les rôles, les droits et les appareils ne sont plus gardés (message « nécessite la connexion »). Le cache existant est vidé une fois. | idem |
| C2 | Les dossiers déchiffrés sont gardés en mémoire pendant la session : une liste ou un compteur ne déchiffre que les dossiers nouveaux ou modifiés (3 000 au plus en mémoire). **À mesurer** sur un jeu réaliste et sur un téléphone d'entrée de gamme. | idem |
| C3 | Un dossier modifié depuis moins de 15 s (`SYNC_PULL_SETTLE_SECONDS`) est envoyé à la lecture suivante : une validation tardive ne peut plus être sautée par le curseur. | `tests/test_offline_audit_fixes.py` |
| C4 | La taille des lots d'envoi est remise à la normale à chaque cycle. | `offline.spec.ts` |
| C5 | Retirer hors ligne une pièce déjà envoyée affiche « nécessite la connexion au serveur ». | idem |
| B3 | Le refus de stockage protégé et l'iPhone hors application installée sont signalés ; « Sauvegarde de secours » exporte la file et les photos (toujours chiffrées) avec l'en-tête du coffre ; « Restaurer une sauvegarde » sur l'écran de code les remet après effacement des données. | `offline.spec.ts` (3) |

## Plan de correction proposé

| Ordre | Lot | Anomalies | Effort |
|---|---|---|---|
| 1 | Cohérence secrétariat | A1, A2 | ½ journée, avec tests serveur et navigateur |
| 2 | Ne rien perdre, ne rien oublier | B2, B3, B4 | 1 jour |
| 3 | Données et droits | B1, A3 | ½ journée |
| 4 | Lecture fiable | C1, C3, C4, C5 | ½ journée |
| 5 | Performances | C2 | à mesurer d'abord sur un jeu réaliste |
| — | Essai réel | tous | 2 téléphones (Android, iPhone), coupure réseau, 1 semaine hors ligne, fermeture de l'onglet, mise en veille |

## Tests

| Suite | Résultat |
|---|---|
| Serveur — synchronisation et mode hors ligne multi-rôles (`tests/test_offline_sync.py`, `tests/test_offline_roles.py`) | 79 tests, tous réussis |
| Navigateur — moteur, file, coffre, matérialisation (`core/offline/offline.spec.ts`, Edge sans écran) | 74 tests, tous réussis |
| Sondes d'audit (7, jetables) | A1, A2, A3 et B1 reproduits ; les autres sondes (opération d'un autre agent, lot trop grand, charge invalide) se comportent comme prévu |

Les tests existants passent donc tous : les anomalies ci-dessus sont des cas que la suite actuelle **ne couvre pas**. Chacune devrait devenir un test de non-régression
en même temps que sa correction.

## Ce que cet audit ne couvre pas

Le service worker réel sur Vercel (mises à jour de l'application pendant qu'un agent est hors ligne), les performances sur de vrais téléphones, l'iPhone,
et la mise en veille prolongée. Ils demandent un essai sur appareils.
