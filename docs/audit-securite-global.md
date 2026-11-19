# Audit de sécurité global — Wakara

Date : 17/11/2026. Commit audité : `1034fff` (branche `main`).

Périmètre : tout le dépôt — authentification et sessions, droits et rôles, API (déclarations, actes, pièces, doublons, audit, statistiques, synchronisation), stockage des fichiers, configuration Django et Vercel, dépendances, frontend et mode hors ligne.

Méthode : lecture du code, recherche de motifs dangereux, `npm audit`, et **90 sondes actives** contre l'API (fichier de test jetable, supprimé après l'audit). Le déploiement réel (en-têtes servis par Vercel, variables d'environnement, base Neon) n'a **pas** été vérifié : seul le dépôt l'a été.

Note : aucun skill « ECC » n'est installé dans cet environnement ; l'audit a été fait à la main, avec la même méthode que le précédent ([audit-securite-hors-ligne-doublons.md](./audit-securite-hors-ligne-doublons.md)).

## Corrections apportées (17/11/2026)

Les quatre points « à corriger avant la mise en production » sont corrigés et testés :

| # | Correction | Vérification |
|---|------------|--------------|
| 1 | Angular 17 → **21.2** (migration pas à pas 18, 19, 20, 21 ; TypeScript 5.9). | `npm audit --omit=dev` : 0 vulnérabilité ; build de production ; 74 tests du navigateur ; parcours manuel (connexion, liste, tableau de bord) |
| 2 | Un dossier hors délai refuse l'ajout et l'archivage d'une pièce, en ligne et à la synchronisation (sauf `dossier.override_deadline`). | `tests/test_audit_fixes.py` |
| 3 | Verrouillage par couple **compte + adresse** : un inconnu se bloque lui-même, plus le titulaire. Le compte entier n'est verrouillé que si 5 adresses le sont en même temps (`LOGIN_LOCKED_SOURCES_BEFORE_ACCOUNT_LOCK`). | idem |
| 4 | Personne n'accorde un droit qu'il ne détient pas (rôles, attributions, surcharges) ni n'agit sur un compte qui a plus de droits que lui (réinitialisation, modification, activation, rôles). | idem |
| 6 | Les trois corps de requête mal formés répondent 400. | idem |

### Deuxième série de corrections (17/11/2026)

| # | Correction | Vérification |
|---|------------|--------------|
| 5 | Le jeton d'accès cesse de fonctionner **à la déconnexion** (liste des jetons révoqués) et, pour toutes les sessions du compte, au **changement ou à la réinitialisation du mot de passe** et à la **désactivation** (numéro de version des sessions porté par chaque jeton). Durée par défaut ramenée à 30 minutes. | `tests/test_production_readiness.py` |
| 7 | Le nouveau mot de passe doit différer de l'ancien ; longueur minimale portée de 8 à 10 caractères. | idem |
| 8 | Un identifiant inconnu n'est plus écrit dans le journal d'audit : seule une empreinte courte (`inconnu:…`) est conservée. | idem |
| 9 | Dépendances Python **verrouillées** (`requirements.txt`) et contrôlées (`pip-audit` : aucune vulnérabilité connue) ; outils de test séparés (`requirements-dev.txt`). | `pip-audit` |
| 10 | Un identifiant inconnu se comporte exactement comme un compte réel (mêmes réponses, même verrouillage par adresse) : on ne peut plus deviner quels comptes existent. | idem |
| 11 | Nouveau droit `document.archive` (secrétariat, administrateur). L'agent ne retire sa propre photo que tant que le dossier est son brouillon, jamais après la transmission. | idem |
| — | **Séparation des tâches** : la personne qui a soumis un dossier à validation ne peut pas le valider (`DOSSIER_SEPARATE_SUBMIT_AND_VALIDATE`, actif par défaut ; à désactiver seulement dans un très petit service). Vaut aussi hors ligne. | idem |
| — | Commande `python manage.py check_production` : rapport de préparation du déploiement (configuration, base, comptes), exécuté à chaque déploiement de production dans les journaux du build. Node 22 imposé au frontend (`engines`). | idem |

**Reste hors du code** (à faire par l'exploitant ou à décider avec la mairie) : la double authentification (non réalisée : le choix du moyen — application d'authentification ou SMS — dépend de la mairie), les variables d'environnement du déploiement (voir [securite-deploiement.md](./securite-deploiement.md)), la sauvegarde testée, et le test sur de vrais appareils. Limite connue du point 3 : une attaque menée depuis 5 adresses à la fois peut encore verrouiller un compte 15 minutes ; une limitation de débit au niveau du pare-feu la réduit.

## Verdict (avant corrections)

**Pas encore prêt pour une mise en production avec des données réelles.** Le socle est sain (aucune faille critique, aucun accès croisé entre comptes, aucune injection trouvée), mais 4 points sont à corriger avant, et 3 décisions sont à prendre avec la mairie.

## À corriger avant la mise en production

| # | Gravité | Constat | Preuve (sonde) |
|---|---------|---------|----------------|
| 1 | Élevée | **Angular 17 n'est plus maintenu** : 9 vulnérabilités connues (5 hautes, dont plusieurs XSS). La CSP stricte de `vercel.json` (`script-src 'self'`) en réduit fortement la portée, mais un XSS donnerait accès aux jetons de session (stockage du navigateur). | `npm audit --omit=dev` |
| 2 | Moyenne | **La règle des 6 mois ne bloque pas les pièces.** Sur un dossier hors délai, le secrétaire peut encore ajouter une pièce (201) et en archiver une (204). Les données, l'acte et les étapes sont bien bloqués (403). Vaut aussi pour la synchronisation hors ligne. | `documents/services.py` (`store_document`), `documents/views.py` (`perform_destroy`) |
| 3 | Moyenne | **N'importe qui peut verrouiller le compte de l'administrateur.** 5 mots de passe faux suffisent, sans être connecté ; le compte est bloqué 15 minutes, même avec le bon mot de passe, et l'attaque se répète à volonté. La limite par adresse (10/min) ne l'empêche pas, et elle est comptée par instance sans `REDIS_URL`. | Admin verrouillé après 6 essais d'un inconnu |
| 4 | Moyenne | **Trois droits d'administration valent le rôle administrateur complet**, sans garde-fou : `role.manage` (son titulaire ajoute tous les droits à son propre rôle : 200), `user.reset_password` (un non-administrateur réinitialise le mot de passe de l'administrateur et reçoit le mot de passe provisoire : 200), `user.assign_roles` (donne le rôle admin à un complice : 201). Par défaut seul l'administrateur les a ; le risque naît dès qu'on les délègue depuis l'écran des rôles. | Sondes 04 et 05 |

## À corriger ensuite

| # | Gravité | Constat |
|---|---------|---------|
| 5 | Basse | Après la déconnexion, le jeton d'accès reste valable jusqu'à son expiration (60 minutes par défaut ; `.env.example` dit 30). Après une réinitialisation de mot de passe par l'administrateur, l'ancien jeton lit encore `/auth/me/` (le reste est bloqué par le changement de mot de passe obligatoire). |
| 6 | Basse | Trois corps de requête mal formés provoquent une erreur 500 au lieu d'un 400 : `PATCH /settings/` avec une liste, `PUT /roles/{id}/permissions/` avec des objets, `POST /users/{id}/roles/` avec un rôle non numérique. Réservés à l'administrateur. |
| 7 | Basse | Le changement de mot de passe accepte le même mot de passe que l'ancien (y compris pour lever l'obligation de changement à la première connexion). |
| 8 | Basse | Un identifiant inconnu saisi à la connexion est écrit tel quel dans le journal d'audit : un mot de passe tapé par erreur dans le champ identifiant y reste en clair, visible avec `audit.view`. |
| 9 | Basse | `requirements.txt` donne des plages de versions, sans fichier de verrouillage : deux déploiements peuvent installer des versions différentes. `factory-boy` et `faker` (tests) sont installés en production. |
| 10 | Basse | Un compte verrouillé répond « Compte temporairement verrouillé » : cela confirme qu'un identifiant existe. |
| 11 | Basse | La suppression d'une pièce demande le droit d'ajout (`document.upload`) : un agent peut archiver une pièce de son dossier tant que celui-ci n'est pas figé. L'archivage est logique et tracé. |

## Décisions à prendre avec la mairie

- **Double authentification** : aucune. Un mot de passe de 8 caractères protège seul les comptes qui valident des actes d'état civil.
- **Séparation des tâches** : le secrétaire peut soumettre un dossier puis le valider lui-même (il a `acte.submit` et `dossier.validate`).
- **Clé secrète** : sans `SECRET_KEY` définie sur Vercel, elle est dérivée de l'adresse de la base. Mieux vaut en définir une explicitement.

## À vérifier sur le déploiement (hors dépôt)

- `REDIS_URL` défini (sinon les limites de débit et de connexion sont comptées par instance) ; `python manage.py check --deploy` sans alerte.
- `DEBUG=False`, `ALLOWED_HOSTS` et `CORS_ALLOWED_ORIGINS` limités au domaine réel.
- Les en-têtes de `vercel.json` (CSP, HSTS) sont bien servis sur le domaine de production.
- Sauvegardes de la base Neon planifiées et restauration testée ([backup-restore.md](./backup-restore.md)).
- Les comptes d'aperçu (`*.apercu`) n'existent pas dans la base de production.

## Ce qui a résisté aux sondes

- **Accès croisés** : un agent ne lit, ne modifie, ne transmet ni ne télécharge rien d'un autre agent (404/403). Le secrétaire ne voit pas les brouillons des agents et n'atteint ni les utilisateurs, ni les paramètres, ni l'audit, ni les exports, ni les appareils (403).
- **Injection de champs** : `status`, `reference`, `received_at`, `is_superuser`, `is_staff`, rôles et permissions envoyés dans un corps de requête sont ignorés.
- **Jetons** : rotation du jeton de rafraîchissement, réutilisation refusée (401), révocation à la désactivation (401 immédiat), à la réinitialisation et à la déconnexion ; sessions liées à l'appareil.
- **Fichiers** : HTML, SVG et contenu ne correspondant pas à l'extension refusés ; nom de fichier nettoyé ; téléchargement authentifié, tracé, servi avec `nosniff` et une CSP `sandbox`.
- **Dossier validé** : ni les données, ni le numéro, ni l'archivage ne passent, même pour l'administrateur (403).
- **Journal d'audit** : modification et suppression refusées par le modèle.
- **Divers** : pas de SQL brut, pas d'`eval`, pas de `innerHTML` ni de contournement du nettoyage Angular ; CORS fermé aux origines étrangères ; documentation de l'API absente hors `DEBUG` ; tri et filtres limités aux champs prévus ; taille de page plafonnée ; aucun secret dans le dépôt.
- **Changement de mot de passe obligatoire** : bloque toute l'API tant qu'il n'est pas fait.

## Ordre de correction proposé

1. Pièces et règle des 6 mois (#2) — quelques lignes, avec tests.
2. Verrouillage de compte (#3) : verrouillage progressif par couple compte + adresse, et réponse identique que le compte soit verrouillé ou non.
3. Garde-fous des droits d'administration (#4) : interdire d'ajouter des droits à son propre rôle, et réserver réinitialisation et attribution de rôles sur un administrateur aux administrateurs.
4. Erreurs 500, même mot de passe, identifiant dans l'audit, jeton d'accès à 15-30 minutes (#5 à #8).
5. Verrouiller les versions Python (#9).
6. Migration d'Angular vers une version maintenue (#1) : chantier à part, la tentative vers la version 21 a échoué à la compilation.

## Suites (19/11/2026)

- **Double authentification** (TOTP, facultative, exigible par rôle) : réalisée, avec codes de secours, réinitialisation par un autre administrateur et tests (`tests/test_two_factor.py`, 30).
- **Code de récupération des appareils** : réalisé (lecture par l'administrateur habilité, motif et mot de passe, journalisé ; `tests/test_device_recovery.py`, 25).
- **Secrets en base** chiffrés (`core/secretbox.py`, Fernet) ; `FIELD_ENCRYPTION_KEY` à définir.
- **Rapport de préparation** (`check_production`) étendu : clé de chiffrement, rôles personnalisés sans `document.archive`, volume de la base.
- **Tests de bout en bout** remis à jour (code du coffre, limite d'appareils, déconnexion toujours possible) et complétés (code oublié) : 7 scénarios.
- Reste à faire hors du code : réglages Vercel (`SECRET_KEY`, `FIELD_ENCRYPTION_KEY`, `REDIS_URL`), essais sur Android et iPhone, restauration d'une sauvegarde Neon, décisions de la mairie.
