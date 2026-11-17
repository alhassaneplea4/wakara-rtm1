# Mode hors connexion — architecture technique

> Branche `wakara-hors-ligne`. Tout le chantier (code, migrations, tests, documentation, correctifs) vit sur cette branche ; rien n'est fusionné dans `main` sans décision explicite.

## 1. Ce que fait le mode hors connexion

Un **agent de collecte** peut, sans Internet :

- créer une déclaration de naissance, la modifier, l'enregistrer en brouillon ;
- joindre les photos de la fiche physique (et d'autres pièces) ;
- la transmettre au secrétariat (la transmission part au retour de la connexion) ;
- consulter ses propres dossiers déjà reçus du serveur.

Le mode hors connexion n'est plus réservé à l'agent : le **secrétariat**, les **validateurs** et l'**administrateur** travaillent aussi sur leur appareil (voir [tous-les-roles.md](./tous-les-roles.md)). Ce qui exige le serveur par nature — gestion des utilisateurs, des rôles et des paramètres, décisions du contrôle des doublons, délivrances, exports — reste en ligne, mais les pages de consultation déjà ouvertes restent lisibles. PostgreSQL (Neon) reste la seule base de référence ; l'hébergement Vercel n'est pas modifié.

## 2. Vue d'ensemble

```
 Navigateur de l'agent                                         Vercel
┌──────────────────────────────────────────────┐        ┌───────────────────────────┐
│ Écrans existants (liste, dossier, formulaire) │        │ Django / DRF              │
│        │ appels API habituels                 │        │                           │
│ offlineInterceptor ── local-api.ts            │        │  /api/sync/ping/          │
│        │ écritures : toujours sur l'appareil  │  push  │  /api/sync/push/          │
│        ▼                                      │ ─────► │  /api/sync/documents/     │
│ File d'opérations + dossiers + photos         │  pull  │  /api/sync/pull/          │
│ IndexedDB (Dexie), chiffrés AES-GCM           │ ◄───── │  /api/sync/operations/    │
│        ▲ clé de données, en mémoire seulement │        │  /api/sync/devices/       │
│ Coffre : PIN → PBKDF2 → clé enveloppée        │        │        │                  │
│ Service worker : coquille de l'application    │        │  services métier existants│
└──────────────────────────────────────────────┘        │  → PostgreSQL (Neon)      │
                                                         └───────────────────────────┘
```

### Principe côté serveur : rejouer, ne rien dupliquer

`backend/sync/services.py` n'implémente **aucune règle métier**. Chaque opération reçue est rejouée par les services existants (`declarations.services.create_declaration`, `update_declaration`, `transition_status`, `documents.services.store_document`) **au nom de l'utilisateur authentifié**. Permissions, propriété du dossier, circuit et champs obligatoires sont donc vérifiés exactement comme en ligne. Le module n'ajoute que ce qui est propre au hors-ligne : idempotence, contrôle des dates de l'appareil, contrôle de version, traçabilité.

### Principe côté appareil : une seule voie d'écriture

Pour un **agent de collecte** dont l'appareil est déverrouillé, créer, modifier, transmettre et joindre une photo passent **toujours** par la file locale, que le réseau soit là ou non ; la synchronisation part aussitôt si le serveur répond. Il n'y a donc pas de requête « à moitié partie », et pas de doublon si une réponse se perd.

Les **autres rôles** travaillent sur le serveur tant qu'il répond (rien ne change pour eux) et basculent sur la même file quand il ne répond plus. Un dossier qui a déjà des opérations en attente continue de passer par la file, pour ne jamais casser l'ordre de ce qui a été fait.

Les écrans existants ne sont presque pas modifiés : un intercepteur HTTP (`core/offline/offline.interceptor.ts`) répond à leur place quand il le faut. Pour tous les autres utilisateurs, l'intercepteur ne fait rien.

## 3. Fichiers

**Backend**

| Fichier | Rôle |
|---|---|
| `sync/models.py` | `Device` (appareil d'un agent, révocable), `SyncOperation` (trace de chaque opération reçue, sans son contenu) |
| `sync/services.py` | Application des opérations, horloge de l'appareil, lot, récupération des dossiers |
| `sync/views.py` | Ping, push, photos, pull, historique, appareils |
| `declarations/models.py` | `sync_version`, `device_created_at`, `device_transmitted_at` |
| `documents/services.py` | Validation et stockage d'une pièce, partagés entre l'API et la synchronisation |
| `audit/models.py`, `audit/middleware.py` | Origine « hors ligne », appareil, opération, date sur l'appareil |
| `tests/test_offline_sync.py`, `tests/test_offline_roles.py` | 54 + 17 tests |

**Frontend** (`frontend/src/app/core/offline/`)

| Fichier | Rôle |
|---|---|
| `offline-gate.service.ts` | Porte d'entrée, toujours chargée : éligibilité, état, règles de session |
| `connectivity.service.ts` | Le serveur répond-il ? (ping réel, pas seulement `navigator.onLine`) |
| `offline.interceptor.ts` | Branche les écrans existants sur le stockage local |
| `engine.ts` | Moteur chargé à la demande (Dexie, file, synchronisation) |
| `crypto.ts`, `vault.ts`, `vault-header.ts` | Chiffrement, PIN, session conservée |
| `db.ts`, `store.ts` | Base locale chiffrée |
| `materialize.ts` | Ce que l'agent voit = dernier état du serveur + opérations en attente rejouées |
| `local-api.ts` | Réponses locales aux appels API des écrans (dossiers, actes, pièces, établissements) et copie chiffrée des autres pages consultées |
| `sync.ts` | Push / pull |
| `offline.spec.ts` | 74 tests unitaires |

Écrans : `features/lock.component.ts` (PIN), `features/sync-center.component.ts` (opérations et journal), `features/devices.component.ts` (administration des appareils), `shared/sync-ui.ts` (indicateur par dossier, bandeau, pastille de connexion, reconnexion).

## 4. Protocole de synchronisation

### Opérations

| Type | Contenu | Remarque |
|---|---|---|
| `declaration.create` | données du formulaire | l'identifiant (UUID) du dossier est créé sur l'appareil |
| `declaration.update` | champs modifiés + `base_version` | refusée en conflit si le serveur a une autre version |
| `declaration.transmit` | — | passage à « Transmis au secrétariat » |
| `declaration.transition` | `status`, motif, numérotation (`annee`, `registre`, `feuillet`, `numero_acte`), `accept_incomplete`, `from_status` | toute autre étape du circuit (soumettre à la validation, valider, renvoyer, rejeter) ; mêmes règles que l'API en ligne |
| `document.upload` | fichier + empreinte SHA-256 | envoi séparé, une pièce par requête |

Chaque opération porte un identifiant `op_id` créé sur l'appareil et l'heure de l'action sur l'appareil.

### `POST /api/sync/push/`

Lot limité (`SYNC_MAX_BATCH`, 20 par défaut). Chaque opération est appliquée **dans sa propre transaction**. La réponse est toujours `200` avec un résultat par opération :

| Résultat | Signification | Effet sur l'appareil |
|---|---|---|
| `applied` | appliquée | l'opération est marquée envoyée, son contenu est effacé |
| `duplicate` | déjà appliquée (réponse précédente perdue) | idem |
| `rejected` | refusée (donnée invalide, permission) | le dossier passe « Refusée par le serveur » |
| `conflict` | le dossier a changé sur le serveur ou n'est plus modifiable | le dossier passe « Conflit à résoudre » |
| `skipped` | non tentée : une opération précédente du même dossier a été refusée | reste en attente |

### Idempotence

- `SyncOperation.op_id` est unique. La ligne de trace est prise **et verrouillée** avant tout travail : un rejeu (réponse perdue, double envoi, deux onglets) attend le premier puis reçoit son résultat.
- La création utilise l'UUID fourni par l'appareil : un dossier déjà créé sous cet identifiant par le même agent n'est jamais recréé.
- Une opération refusée peut être corrigée et renvoyée sous le même `op_id` ; seule une opération appliquée est définitive.

### Conflits

Chaque modification côté serveur incrémente `Declaration.sync_version`. Une modification préparée sur l'appareil porte la version sur laquelle elle a été faite ; si le serveur en a une autre, **rien n'est écrasé** : la réponse est `conflict` et contient l'état du serveur. L'agent choisit « Réappliquer mes modifications » ou « Garder la version du serveur ».

Un dossier transmis, validé, rejeté, délivré ou archivé ne peut plus être modifié depuis un appareil (`conflict`). Un acte validé n'est donc jamais écrasé.

### Dates de l'appareil

La date qui fait foi pour la réception et la transmission est celle de la saisie sur l'appareil (décision métier). L'horloge d'un téléphone n'étant pas fiable (`sync.services.resolve_device_time`) :

- l'appareil envoie son heure au moment de l'envoi ; l'écart avec le serveur donne le décalage d'horloge. Au-delà de `SYNC_CLOCK_TOLERANCE_SECONDS` (5 min), l'heure est corrigée de ce décalage (`clock_corrected`) ;
- une date encore dans le futur (`future_date`) ou plus ancienne que `SYNC_MAX_DEVICE_AGE_DAYS` (30 jours, `too_old`) n'est pas retenue : la date du serveur est utilisée ;
- la date reçue, la date retenue, le décalage et l'anomalie sont conservés dans `SyncOperation` ; l'historique du dossier porte la mention « Saisie hors connexion le … , synchronisée le … ».

`received_at` et `transmitted_at` portent la date de l'appareil ; `created_at` et `StatusHistory.changed_at` restent l'heure du serveur.

### `GET /api/sync/pull/?since=<curseur>`

Renvoie les dossiers **que l'utilisateur voit en ligne** (`visible_declarations` : ses propres dossiers pour un agent, ceux de la mairie pour le secrétariat et l'administrateur, hors brouillons des agents) modifiés depuis le curseur. Au premier appel : tout ce qui est en cours (hors dossiers figés) et ce qui a changé dans les 90 derniers jours. Chaque dossier du secrétariat porte aussi son en-tête de registre (`acte`). Un dossier archivé, ou rejeté comme saisie redondante d'un doublon confirmé, est annoncé `is_archived` : l'appareil l'oublie. Paginé (`SYNC_PULL_PAGE_SIZE`).

### `GET /api/sync/reference/`

Les **établissements actifs** et les **règles** à refléter (champs requis pour transmettre et pour soumettre à la validation, champs attendus à la validation finale, durée du délai de 6 mois, numérotation automatique, taille maximale d'un fichier, taille de lot), sans aucun dossier. L'appareil l'appelle **en premier** à chaque cycle : même si l'envoi ou la récupération des dossiers échoue, les formulaires restent utilisables hors connexion. Une liste d'établissements vide ne remplace jamais celle déjà connue.

### Ce que décident le serveur et l'appareil

Le serveur reste l'autorité : chaque étape est revérifiée à la synchronisation (circuit, permission propre à l'étape, données requises, unicité du numéro officiel, règle des 6 mois, contrôle des doublons). L'appareil en reflète une copie (`materialize.ts`, `WORKFLOW`) pour montrer à chaque rôle les boutons qu'il aurait en ligne. Une décision (valider, renvoyer, rejeter) porte l'étape que l'appareil a vue (`from_status`) et, quand elle repose sur le dossier tel qu'il a été reçu, sa version (`base_version`) : si le dossier a changé entre-temps, rien n'est appliqué (`conflict`, `status_changed` ou `version_conflict`).

### Ordre d'envoi

Les opérations partent dans l'ordre où elles ont été faites. Les photos partent une par une ; ce qui suit une photo dans le même dossier (la transmission, par exemple) attend que la photo soit confirmée. Une opération refusée bloque la suite **de son dossier seulement**.

## 5. Sécurité

| Sujet | Mise en œuvre |
|---|---|
| Chiffrement local | Clé de données aléatoire AES-GCM 256, **non exportable**, en mémoire seulement. Sur l'appareil, elle est enveloppée par une clé dérivée du PIN (PBKDF2-SHA256, 600 000 itérations, sel par appareil) |
| Ce qui est chiffré | Contenu des opérations, dossiers reçus, photos (contenu et nom), établissements, session (jetons et profil) |
| Ce qui reste en clair | Identifiants techniques, type et état des opérations, dates : ce qu'il faut pour ordonner et compter la file sans le PIN |
| PIN | 8 caractères au minimum mêlant lettres et chiffres, ou une phrase de 14 caractères ; codes triviaux ou courants refusés ; un code faible créé auparavant doit être remplacé au déverrouillage suivant. Après 5 erreurs, blocage temporaire croissant (1 à 30 min). Le compteur est sur l'appareil et peut être effacé par celui qui le détient : la vraie protection est la dérivation de clé (PBKDF2, 600 000 itérations) et la force du code |
| Verrouillage | Manuel (« Verrouiller l'appareil ») ou automatique après 15 min d'inactivité ; tout rechargement de la page redemande le PIN |
| Base locale | Une base IndexedDB par utilisateur |
| Permissions | Vérifiées par le serveur à chaque opération ; l'appareil n'a aucun pouvoir propre |
| Autre utilisateur | Le serveur refuse un lot préparé par un autre compte ; l'application refuse un autre compte sur un appareil qui contient des opérations non envoyées |
| Appareil | Identifié, enregistré à son premier contact, au plus 3 par compte (`SYNC_MAX_DEVICES_PER_USER`). La session (jetons) est liée à l'appareil ; révoquer l'appareil coupe ses sessions immédiatement et il ne peut pas revenir sous un autre identifiant |
| Session expirée | La file se met en pause ; aucune donnée locale n'est effacée ; l'agent se reconnecte sans quitter son écran |
| Déconnexion | Toujours possible. Le coffre (code), la base locale chiffrée et la file d'opérations sont **conservés** sur l'appareil ; seule la session enregistrée est supprimée. À la connexion suivante du même agent, l'appareil est déverrouillé avec le code déjà créé (pas de nouvelle création) et la file reprend. Un autre compte est refusé tant que des opérations de l'agent précédent attendent ; sans opération en attente, son arrivée remplace le coffre |
| Journal | Chaque événement appliqué porte l'origine « hors ligne », l'appareil, l'opération et la date sur l'appareil ; refus et conflits sont journalisés |

Le serveur ne conserve pas le contenu des opérations (uniquement leur empreinte) : les données personnelles restent dans les tables métier.

## 6. Service worker et PWA

- `ngsw-config.json` : la coquille (HTML, JS, CSS, polices, images) est mise en cache ; **l'API n'est jamais mise en cache** par le service worker (`/api/**` exclu). Les données hors ligne vivent chiffrées dans IndexedDB.
- La police Inter est embarquée (`@fontsource/inter`) : plus aucun appel à Google Fonts.
- Une nouvelle version n'est jamais appliquée sous les mains de l'utilisateur : un bandeau propose « Recharger ».
- Le service worker n'est actif que sur le build de production.

### Interrupteur à distance

Paramètre **`offline.enabled`** (écran Paramètres, ou table `SiteSetting`). À `false`, chaque appareil, à son prochain contact :

- supprime son service worker et ses caches ;
- ne propose plus le mode hors connexion aux nouveaux appareils ;
- renvoie les nouvelles saisies directement au serveur.

Les opérations déjà en attente restent synchronisables : aucune donnée ne reste bloquée sur un appareil.

En dernier recours (service worker défectueux empêchant le chargement), publier le fichier `safety-worker.js` du paquet `@angular/service-worker` sous le nom `ngsw-worker.js`.

## 7. Limites connues

- **PIN oublié** : les opérations non synchronisées de l'appareil sont perdues (le code ne peut pas être récupéré, par conception). L'écran l'annonce avant toute réinitialisation.
- **Compte désactivé ou appareil révoqué avec des opérations en attente** : voir la procédure de secours dans [exploitation.md](./exploitation.md).
- **Pièces déjà sur le serveur** : leur liste est lisible hors connexion (dernière consultation en ligne) ; leur contenu ne l'est pas (seules les photos en attente d'envoi sont sur l'appareil).
- **Suppression d'une pièce déjà envoyée** : en ligne uniquement.
- **Politique CSP** : non ajoutée dans cette phase. Une CSP stricte demande de tester toutes les pages (styles en ligne d'Angular, images `blob:`, impression de l'acte) ; à traiter séparément.
- **iOS / Safari** : le navigateur peut effacer le stockage d'un site non installé après plusieurs jours sans visite. Installer l'application sur l'écran d'accueil et synchroniser régulièrement.
- **Stockage Neon** : les photos sont dans la base (0,5 Go en offre gratuite) ; surveiller le volume.
