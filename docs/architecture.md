# Architecture et décisions techniques

## Vue d'ensemble

- **Backend** Django 5 + DRF, authentification JWT (SimpleJWT, rotation + liste noire des refresh tokens).
- **Frontend** Angular 17 (composants autonomes, chargement différé par route, signaux), Chart.js.
- **Base** SQLite (dev) / PostgreSQL (prod). Migrations versionnées dans chaque application.
- Les services métier (`declarations/services.py`, `actes/services.py`) sont séparés des vues ;
  le frontend n'implémente **aucune** règle critique : il affiche ce que l'API autorise
  (`available_transitions`, `can_edit`, `permissions`) et l'API refuse tout le reste.

## Applications Django

| App | Rôle |
|---|---|
| `core` | Mixins (horodatage, archivage logique, ajout seul), workflow (machine à états), permissions, `AuditedModelViewSet`, paramètres du site, commandes (`setup_initial_data`, `seed_demo`, `backup_wakara`, `restore_wakara`) |
| `accounts` | Utilisateur, rôles, permissions, affectations, surcharges par utilisateur, authentification |
| `hospitals` | Hôpitaux et maternités (désactivation / archivage, jamais de suppression) |
| `declarations` | Déclaration, enfant, parents, déclarant, historique des statuts, compteur de références |
| `actes` | Acte (références du registre, numéro officiel), séquences, impressions, délivrances |
| `documents` | Pièces justificatives en stockage **privé**, téléchargement authentifié et audité |
| `audit` | Journal d'audit en ajout seul, middleware de contexte (IP, agent) |
| `stats` | Tableau de bord calculé depuis la base |

## Modèle de données (résumé)

```
CustomUser ─< UserRole >─ Role ─< RolePermission >─ Permission
CustomUser ─< UserPermission(granted) >─ Permission          (surcharges)
Hospital ─< Declaration ─1 Child
                      ├─< Parent (FATHER|MOTHER, unique par déclaration)
                      ├─1 Declarant
                      ├─1 Acte ─< PrintLog
                      │        └─< Delivery
                      ├─< StatusHistory     (ajout seul)
                      └─< SupportingDocument
AuditLog (ajout seul)    ReferenceCounter    NumberSequence    SiteSetting
```

Une déclaration = un enfant (une naissance multiple = plusieurs déclarations — à confirmer).
Trois identifiants ne sont jamais confondus : `uuid` (technique, exposé par l'API),
`reference` (suivi interne `WKR-AAAA-NNNN`, compteur verrouillé) et `numero_acte` (numéro **officiel**,
porté par l'acte).

## Convention de traçabilité

- `created_at`, `updated_at` : posés par le serveur.
- `created_by`, `updated_by` : posés par la vue / le service à partir de `request.user`, jamais depuis le corps de requête.
  (Un seul couple de champs : `updated_by`, pas de `edited_by`.)
- `is_archived`, `archived_at`, `archived_by` : archivage logique. Pas de champs `deleted_*` (doublon inutile).
- `change_reason` : porté par le journal d'audit (`reason`), pas par chaque table.

## Aucune suppression physique

- `BusinessQuerySet.delete()` et `Model.delete()` lèvent `HardDeleteForbidden` pour les tables métier,
  utilisateurs, rôles et permissions ; l'API `DELETE` archive.
- `AuditLog` et `StatusHistory` sont en **ajout seul** (`save()` sur une ligne existante, `update()`, `delete()` refusés).
- Django Admin : suppression désactivée partout ; déclarations, actes, délivrances, pièces et journaux en lecture seule.
- Limite connue : un `DELETE` SQL direct ou une suppression en cascade au niveau base reste possible pour
  un administrateur de la base. En production, retirer les droits `DELETE`/`UPDATE` de l'utilisateur
  applicatif sur `audit_auditlog` et `declarations_statushistory` (voir `deployment.md`).

## Sécurité

- Permissions vérifiées côté serveur, **fail-closed** : une action absente de `permission_map` est refusée.
- Le flag Django `is_superuser` n'accorde aucune permission métier.
- Anti-escalade : on ne modifie pas ses propres rôles / permissions / statut ; le rôle `admin` conserve
  `user.view`, `user.assign_roles`, `role.view`, `role.manage` ; on ne retire pas de permissions à son propre rôle.
- Connexion : limitation de débit (`LOGIN_THROTTLE_RATE`), verrouillage temporaire après N échecs,
  message d'erreur identique pour compte inconnu / mot de passe faux, désactivation effective immédiatement
  (les jetons d'accès d'un compte désactivé sont refusés).
- Mot de passe : validateurs Django, changement forcé à la première connexion / après réinitialisation.
- Jamais de mot de passe, jeton ou secret dans le journal (nettoyage automatique des clés sensibles).
- Documents : extension + signature de fichier vérifiées, taille limitée, nom aléatoire sur disque, stockage hors
  de toute URL publique, `Cache-Control: no-store`, accès filtré par visibilité du dossier, chaque téléchargement audité.
- Production : HTTPS forcé, HSTS, cookies sécurisés, documentation d'API désactivée.
- Jetons côté navigateur : `sessionStorage` par défaut ; « Se souvenir de moi » utilise `localStorage`
  (refresh token à durée limitée côté serveur et mis en liste noire à la déconnexion).

## Hors périmètre de la v1

Mode hors connexion (non requis), signature électronique, réinitialisation du mot de passe par e-mail
(l'administrateur remet un mot de passe temporaire), génération PDF serveur (l'acte est rendu en HTML
imprimable ; le modèle officiel reste à valider).
