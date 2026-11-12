# Mode hors connexion — Phase 0 : audit et plan

> Branche : `wakara-hors-ligne` (créée depuis `main` au commit `309957e`).
> Aucun code applicatif n'a été modifié dans cette phase. Tout le chantier hors ligne (code, migrations, tests, documentation) reste sur cette branche.

## 1. État de référence (mesuré le 12 novembre 2026)

| Contrôle | Résultat |
|---|---|
| Tests backend (`manage.py test tests`, `DEBUG=True`) | 193 tests, tous verts |
| `makemigrations --check` | aucune migration manquante (dernière : `declarations/0008_divorce`) |
| `npm run build` (Angular 17.3) | OK ; paquet initial 565 kB brut (avertissement à 650 kB, erreur à 1 Mo) |
| Tests Angular | 3 fichiers (`core.spec.ts`, `date-letters.spec.ts`, `field-formats.spec.ts`) ; aucun test de bout en bout |

## 2. Ce qui a changé sur `main` depuis le premier audit

- Statut renommé « Acte incomplet » (`IN_COMPLETION`) ; `TRANSMITTED` peut passer directement à `PENDING_VALIDATION`.
- Les brouillons ne sont visibles que de leur auteur (`visible_declarations`), sauf pour l'administrateur : bon point pour le hors ligne, un brouillon n'a qu'un seul propriétaire.
- Transmission exigée : `birth_date`, `birth_time`, `birth_place`, `child.gender` (réglage `DECLARATION_REQUIRED_FOR_TRANSMISSION`). Le formulaire hors ligne doit refléter cette règle ; le serveur reste l'autorité.
- `DeclarationWriteSerializer` accepte maintenant une section `acte` (réservée au secrétariat, contrôlée dans le service).
- Le formulaire de déclaration est désormais **partagé** entre l'agent et le secrétariat. Risque de régression principal du front.
- Le dossier `docs/livraison/` est supprimé dans l'arbre de travail (suppressions non validées, ne venant pas de ce chantier). Ces suppressions ne sont pas commitées ici.

## 3. Constats confirmés dans le code

**Backend**
- `Declaration.uuid` : `editable=False`, généré par le serveur ; `create_declaration` ne reçoit jamais d'UUID du client.
- `received_at = timezone.localdate()` posé dans `create_declaration` ; `transmitted_at = now` posé dans `transition_status`.
- Aucun champ de version ; `update_declaration` écrase sans contrôle.
- `transition_status` verrouille la ligne (`select_for_update`) et vérifie permission, statut, champs requis : à réutiliser tel quel.
- `documents` : envoi multipart, un fichier par requête, UUID généré par le serveur, pas d'idempotence ; refus si dossier gelé ; SHA-256 calculé côté serveur.
- `audit.log()` lit IP et agent utilisateur dans un contexte de requête ; aucun champ « appareil » ni « origine ».
- JWT : accès 60 min, refresh 7 jours, rotation avec liste noire.
- Limites Vercel : corps ≈ 4 Mo (`MAX_UPLOAD_SIZE` = 4 Mo sur Vercel).

**Frontend**
- `AuthService` : jetons en `sessionStorage` par défaut ; `expire()` vide la session et redirige ; `logout()` efface immédiatement.
- `authInterceptor` : sur 401, un rafraîchissement puis, en cas d'échec, `auth.expire()`.
- `paper-form.component.ts` : réduction JPEG (côté 2400 px, qualités 0,85 / 0,78 / 0,7, cible 3,5 Mo) ; fichiers gardés en mémoire pour un nouveau dossier puis envoyés par `uploadPending`.
- Le formulaire charge les hôpitaux par l'API à l'ouverture (`/hospitals/?is_active=true`).
- L'agent n'a pas `stats.view` : il arrive sur `/declarations`, pas sur le tableau de bord. L'indicateur de connexion doit donc aller dans la barre du haut du `ShellComponent`, visible partout.
- Aucune PWA, aucun service worker, aucun `manifest` ; police Inter chargée depuis Google Fonts.

## 4. Fichiers à créer ou modifier

**Backend**
- Nouveau : `backend/sync/` (`models.py`, `serializers.py`, `services.py`, `views.py`, `urls.py`, `admin.py`, migrations) ; enregistrement dans `INSTALLED_APPS` et `wakara/urls.py`.
- `declarations/models.py` : `sync_version`, `device_created_at`, `device_transmitted_at` (migration additive 0009).
- `declarations/services.py` : UUID fourni par le client, date de réception appareil, version attendue, date de transmission appareil (uniquement pour l'origine synchronisation).
- `declarations/serializers.py` : exposer `sync_version` en lecture.
- `documents/views.py` et `documents/models.py` : identifiant de fichier fourni par le client, vérification de l'empreinte, idempotence.
- `audit/service.py` : origine « hors ligne », appareil, `op_id`, dates appareil et serveur (vérifier que `audit/history.py` accepte des clés supplémentaires).
- `wakara/settings.py` : réglages `SYNC_*` (taille de lot, tolérance de date future, ancienneté maximale, rétention).
- `core/permissions.py` : éventuelle permission d'administration des appareils ; attention au compteur « Permissions : 32 » et à `setup_initial_data`, qui tourne à chaque build.
- Tests : nouveaux fichiers sous `backend/tests/` ; compléments à `base.py`.

**Frontend**
- `package.json` : `dexie`, `@angular/service-worker` ; `angular.json` (service worker) ; `ngsw-config.json` ; `src/manifest.webmanifest` ; icône 512 px.
- Nouveau dossier `src/app/core/offline/` : base Dexie, service de chiffrement, verrouillage par PIN, détection de connexion, file d'opérations, service de synchronisation.
- `app.config.ts`, `http.interceptor.ts` (pause sur 401 pendant la synchronisation), `auth.service.ts` (déconnexion bloquée, refus d'un autre utilisateur, session persistante), `guards.ts`.
- `layout/shell.component.ts` : statut, compteur, dernière synchro, boutons Synchroniser et Verrouiller, déconnexion bloquée.
- `features/declaration-form.component.ts` : chemin d'enregistrement local pour l'agent, via un adaptateur, sans toucher au chemin du secrétariat.
- `shared/paper-form.component.ts` : profils de compression (Standard, Économique, Haute qualité), stockage des fichiers chiffrés.
- `features/declarations-list.component.ts`, `declaration-detail.component.ts` : afficher les brouillons locaux.
- `features/login.component.ts` : création et saisie du PIN.
- `index.html`, `styles.scss` : police Inter auto-hébergée, manifest.

## 5. Risques de régression

| Risque | Mesure |
|---|---|
| Formulaire partagé agent / secrétariat | Adaptateur séparé ; tests existants du secrétariat inchangés ; revue de diff ciblée |
| Service worker qui fige une ancienne version | Politique de mise à jour, `SwUpdate` coordonné avec `onNavigationError`, « kill switch » |
| Interception des appels `/api/` par le service worker | `/api/` exclu du cache de navigation ; aucune mise en cache des réponses sensibles |
| Taille du paquet initial (565 kB, avertissement à 650 kB) | Charger Dexie et le chiffrement dans un module différé réservé à l'agent (à mesurer) |
| `audit/history.py` et clés supplémentaires | Test dédié avant d'enrichir le journal |
| Permissions et rôles par défaut | Ne pas modifier `DEFAULT_ROLES` sans test ; compteur de permissions vérifié |
| Perte de session avec opérations en attente | Pause de la file, jamais de purge ; tests de bout en bout |
| Neon / Vercel preview | Base Neon séparée pour les aperçus ; jamais la production |
| En-têtes de cache de `ngsw.json` sous Vercel Services | À vérifier sur un aperçu avant toute mise en production |

## 6. Plan de réalisation

**1a — Backend** : app `sync` (Device, SyncOperation), push idempotent, UUID client, dates appareil bornées, `sync_version` et réponse 409, documents idempotents, audit enrichi. Sortie : tests backend verts (193 + nouveaux), migrations vérifiées.

**1b — PWA, Dexie, chiffrement** : service worker, cache du shell et des données de référence, base par utilisateur, PIN et chiffrement AES-GCM, création de brouillon hors ligne. Sortie : tests unitaires, build sous budget, premiers essais Playwright (`setOffline`).

**1c — Transmission et interface** : transmission en file, photos et compression, conflits, déconnexion bloquée, indicateurs, historique des erreurs. Sortie : scénarios de bout en bout complets, mise à jour de la documentation (`architecture.md`, `business-decisions.md`, `user-guide.md`, `deployment-vercel.md`).

## 7. Points encore ouverts

1. Politique de session : connexion persistante avec PIN (proposée par défaut), à confirmer.
2. Bornes de date appareil : tolérance de date future et ancienneté maximale (valeurs proposées : 5 minutes et 30 jours, réglables).
3. Version de concurrence : entier `sync_version` (proposé) plutôt que `updated_at`.
4. Politique de rétention locale après confirmation du serveur (proposé : 7 jours).
5. Procédure de secours pour un compte désactivé avec opérations non synchronisées.
