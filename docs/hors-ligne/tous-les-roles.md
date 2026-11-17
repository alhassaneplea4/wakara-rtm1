# Mode hors connexion pour tous les comptes

Le mode hors connexion, d'abord conçu pour l'agent de collecte, sert maintenant **tous les comptes** qui travaillent sur les dossiers : agent, secrétariat, validateurs (secrétaire et administrateur). Le principe est le même pour tous : un code de verrouillage protège les données de l'appareil (chiffrées), une file d'opérations enregistre ce qui est fait sans réseau, et la synchronisation l'envoie au serveur, qui revérifie tout.

## Ce qui fonctionne sans connexion

| Rôle | Ce qui est possible hors connexion |
|---|---|
| **Agent de collecte** | créer, modifier, transmettre une déclaration ; joindre des photos ; consulter ses dossiers (comme avant) |
| **Secrétariat** | consulter les dossiers transmis ; corriger les données et **compléter l'en-tête du registre** (année, registre, feuillet, région, préfecture, commune, centre, date de déclaration, officier, mentions) ; **soumettre à la validation** ; ajouter une pièce |
| **Validateur** (secrétaire ou administrateur) | consulter la file de validation ; **valider définitivement** (numéro officiel saisi sur l'appareil), **renvoyer pour correction** (à la collecte ou au secrétariat), **rejeter** avec motif |
| **Tous** | consulter les pages déjà ouvertes en ligne (tableau de bord, liste des actes, délivrances, historiques, cas de doublons, utilisateurs, rôles, établissements…) avec leurs dernières données |

Les listes de dossiers (filtres statut, établissement, dates de réception et de naissance, recherche, « plus de 6 mois ») sont calculées **sur l'appareil**, à partir des dossiers reçus à la dernière synchronisation.

## Ce qui reste en ligne, et pourquoi

| Action | Raison |
|---|---|
| Créer ou modifier des utilisateurs, des rôles, des permissions, les paramètres, révoquer un appareil | Actions de sécurité : elles ne doivent jamais attendre dans une file |
| Décisions du **Centre de contrôle des doublons** (décider, attribuer, rouvrir) | Elles rejettent ou rétablissent des dossiers : le serveur doit trancher en direct |
| Enregistrer une **délivrance**, imprimer un acte, exports | Évènements du guichet, exports de données sensibles |
| Établissements : créer, modifier, archiver | Données de référence partagées |

L'écran affiche alors « Cette action nécessite la connexion au serveur » ; rien n'est perdu ni mis en file.

## Comment ça marche

- **Agent** : l'appareil passe en premier. Toute écriture est d'abord enregistrée sur l'appareil, puis envoyée.
- **Autres rôles** : tant que le serveur répond, ils travaillent comme avant, directement sur le serveur. Dès qu'il ne répond plus (ou si la session a expiré), les mêmes actions sont mises en file. Un dossier qui a déjà des opérations en attente continue de passer par la file, pour garder l'ordre.
- Un dossier sur lequel une opération attend s'affiche avec son état (« Modifications à envoyer »…) et montre déjà le résultat : un dossier soumis à la validation apparaît dans la file de validation de l'appareil.

## Données de référence : les établissements

La liste des établissements (et les règles à refléter) est reçue **au tout début de chaque synchronisation**, avant l'envoi et la récupération des dossiers, par un appel dédié (`/api/sync/reference/`). Elle est donc disponible hors connexion dès la première synchronisation réussie, même si le reste du cycle a échoué.

Cause du défaut corrigé : la liste n'était reçue qu'avec la récupération des dossiers, après l'envoi ; un envoi refusé (appareil, session) ou interrompu laissait l'appareil sans établissements, et la liste du formulaire restait vide sans explication. Désormais :

- la liste est reçue en premier, et une réponse vide du serveur ne remplace jamais une liste déjà connue ;
- le formulaire explique clairement quand la liste est absente et propose « Actualiser » ;
- l'écran « Synchronisation » affiche la date de la dernière réception des établissements et des règles.

**Première utilisation d'un appareil** : ouvrir l'application **en ligne** une première fois, saisir le code, laisser la synchronisation se terminer (écran « Synchronisation » : « Établissements et règles : mis à jour le … »). Hors connexion, la liste est alors disponible.

## Règles et sécurité (inchangées)

- Le serveur revérifie **chaque** opération avec les services de l'API en ligne : circuit, permission propre à l'étape, données requises, unicité du numéro officiel, règle des 6 mois (bloque tout sauf l'administrateur), contrôle des doublons.
- Une **décision** (valider, renvoyer, rejeter) est refusée si le dossier a changé depuis qu'elle a été prise (`status_changed` : l'étape n'est plus la même ; `version_conflict` : les données ont changé). L'utilisateur relit le dossier mis à jour, puis décide à nouveau.
- Un numéro officiel déjà attribué entre-temps est refusé à la synchronisation (l'opération passe « Refusée » avec le motif).
- Validation avec des champs attendus vides : l'appareil demande la confirmation comme en ligne ; si le serveur la réclame encore (règles modifiées), l'opération est refusée avec la liste des champs.
- Maximum **3 appareils** par compte ; chaque appareil est protégé par son code et révocable (voir [exploitation.md](./exploitation.md)).
- Les pages consultées sont conservées **chiffrées** (250 pages au plus, les plus anciennes sont remplacées) ; elles sont effacées avec l'appareil.

## À savoir

- Le **code de verrouillage** est maintenant proposé à tous les comptes à la première ouverture sur un appareil (« Continuer sans le mode hors connexion » le repousse pour la session).
- Les appareils déjà utilisés par un agent refont **une fois** la récupération complète de leurs dossiers à la prochaine synchronisation (les copies d'avant ne portaient pas l'en-tête du registre).
- Les pages jamais ouvertes en ligne ne sont pas lisibles hors connexion : l'écran le dit.
