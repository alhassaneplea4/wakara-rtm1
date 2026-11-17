# Audit de sécurité — mode hors ligne et contrôle des doublons

Date : 15/11/2026. Périmètre : app `sync` (push, pull, documents, appareils), coffre et moteur hors ligne du
frontend, app `duplicates` (détection, dossiers, décisions, API), configuration de déploiement (Vercel, en-têtes,
proxy, limitation de débit, cache). Méthode : lecture du code, `npm audit`, et 5 sondes de test jetables
(supprimées) pour confirmer les failles les plus importantes. Les corrections sont décrites dans la section « Corrections apportées » en bas de ce document.

**Cloudflare** : aucune configuration Cloudflare n'existe dans le dépôt (l'hébergement est Vercel, `vercel.json`).
La partie « Cloudflare » ci-dessous dit ce qu'il faut régler si Cloudflare est placé devant l'application.

## Constats confirmés par un test

| # | Gravité | Constat | Preuve |
|---|---------|---------|--------|
| 1 | Élevée | La détection ne regarde que 400 candidats, triés du plus récent au plus ancien (`CANDIDATE_LIMIT`, `detection.py`). Un original plus ancien peut être écarté et la copie passe sans dossier. | Sonde : plafond abaissé à 5, 6 dossiers intercalaires de même date → copie non liée à l'original (0 dossier). Plafond normal → lié (1 dossier). |
| 2 | Moyenne | La révocation d'un appareil se contourne : l'appareil est identifié par un UUID choisi par le client, et `get_device` crée un nouvel appareil pour un UUID inconnu. | Sonde : appareil révoqué → 403 ; même agent avec un autre UUID → 200 « applied ». |
| 3 | Moyenne | Un agent peut sonder le registre. Le retour de synchronisation donne la référence et le niveau du dossier de doublon (`duplicate_cases`), et la fiche donne `blocked` et le niveau. | Sonde : l'agent 2 pousse l'identité d'un dossier de l'agent 1 → `DUP-2026-0001`, `HIGH`. |
| 4 | Moyenne | Un détenteur de `settings.manage` peut désactiver le blocage : `blocking_levels: []` est accepté (200). | Sonde. Le changement est audité mais rien ne l'empêche ni ne l'alerte. |
| 5 | Basse | Antidatage : une date d'appareil vieille de 29 jours est acceptée sans anomalie quand `sent_at` est absent. | Sonde : `applied`, anomalie vide. La date de saisie est la date retenue juridiquement. |

## Constats issus de la lecture du code ou des outils

| # | Gravité | Constat | Où |
|---|---------|---------|----|
| 6 | Élevée | Aucun en-tête de sécurité côté frontend : pas de CSP, `Referrer-Policy`, `Permissions-Policy`. `vercel.json` n'en définit pas (à confirmer sur le déploiement réel). Un XSS donnerait accès aux jetons (stockage navigateur) et à la session du coffre. | `vercel.json`, `index.html` |
| 7 | Élevée | Le code du coffre se casse hors ligne si le téléphone est volé. 6 caractères minimum, chiffres acceptés ; le compteur d'essais est dans `localStorage` (effaçable). Seul PBKDF2 (600 000 itérations) protège : un code à 6 chiffres tombe en quelques minutes sur un GPU. Le coffre contient les données des enfants et des parents, les photos des fiches, et le jeton de rafraîchissement (7 jours) tant que l'agent n'est pas déconnecté. | `vault.ts`, `crypto.ts` |
| 8 | Moyenne | Aucune limitation de débit sur `sync/push`, `sync/documents`, `sync/pull`, `duplicates/analyze`, `compare`. Seule la connexion est limitée, et avec `LocMemCache` : chaque instance serverless a son propre compteur. | `settings.py`, `accounts/views.py` |
| 9 | Moyenne | Un verrou global `duplicate-detection` sérialise toutes les créations. `POST /duplicates/analyze/` (droit `duplicate.investigate`), sans limite, peut les ralentir toutes. `filter_options` fait un appel de permissions par utilisateur actif. | `detection.py`, `views.py` |
| 10 | Moyenne | Angular 17 n'est plus maintenu : `npm audit` signale 9 vulnérabilités (5 hautes, 4 moyennes) dans `@angular/core`, `common`, `compiler`, `router`, `service-worker`. Correctif : passer à une version supportée. | `frontend/package.json` |
| 11 | Basse | Les pièces sont servies `inline` depuis la même origine que l'application. Le type et `nosniff` sont fixés, mais ajouter `Content-Security-Policy: sandbox` ou `attachment`. | `documents/views.py` |
| 12 | Basse | `note` et `request-verification` acceptent n'importe quel UUID de déclaration : l'observation peut être rattachée à un dossier étranger au cas. | `duplicates/views.py` |
| 13 | Basse | `PATCH /duplicates/config/` avec un corps qui n'est pas un objet provoque une erreur 500. | `views.py` |
| 14 | Basse | L'historique d'opérations de l'agent expose `result` (références des dossiers de doublon). | `sync/views.py` |

## Cloudflare / proxy

- **`NUM_PROXIES`** vaut 1 sur Vercel. Avec Cloudflare devant Vercel il faut 2, sinon l'adresse retenue est celle de
  Cloudflare : le journal d'audit est faux et la limite de connexion bloque tout le monde à la fois.
- **Cache** : seuls `ping`, `pull` et les documents envoient `no-store`. Les autres réponses d'API (doublons, déclarations)
  n'en envoient pas. Ajouter un `Cache-Control: no-store` global sur `/api/` et une règle Cloudflare « contourner le cache » sur `/api/*`.
- **Service worker** : ne pas mettre en cache `ngsw.json`, `ngsw-worker.js` et `index.html`. Désactiver Rocket Loader,
  Auto Minify et Mirage : modifier un fichier invalide les empreintes d'Angular et casse les mises à jour hors ligne.
- **Règles de limitation de débit** à créer au bord : `/api/auth/login/` (10/min par IP), `/api/sync/push/` et
  `/api/sync/documents/` (par IP et par jeton), `/api/duplicates/analyze/`, `/api/sync/ping/` (public, sans authentification).
- **WAF** : laisser passer le multipart de 4 Mo sur `/api/sync/documents/` et autoriser seulement les méthodes utilisées.
- **En-têtes** : si Cloudflare les ajoute (HSTS, CSP), vérifier qu'ils ne doublonnent pas ceux de Django.

## Ce qui est correct

Les opérations hors ligne passent par les mêmes services que l'API en ligne (droits, appartenance, workflow). `op_id` est
idempotent et lié à l'utilisateur ; un dossier ne se modifie que par son auteur ; un dossier figé refuse les pièces. Les
fichiers sont contrôlés (extension, signature, empreinte SHA-256) et servis avec `nosniff`. Le coffre chiffre en AES-GCM
avec une clé non exportable. L'attribution du numéro officiel est refusée sous verrou tant qu'un dossier de doublon est
ouvert. Décisions et historique des doublons : append-only, motif obligatoire, audités. Le service worker exclut `/api/`.

## Ordre de correction proposé

1. Détection : classer les candidats par clés exactes d'abord (mère, téléphone, nom de l'enfant), puis par date, et journaliser quand le plafond est atteint (#1).
2. En-têtes de sécurité dans `vercel.json` (#6) et mise à jour d'Angular (#10).
3. Révocation d'appareil : révoquer aussi les jetons de rafraîchissement de l'agent, ou n'accepter que des appareils enregistrés (#2).
4. Code du coffre : 8 caractères minimum avec lettres, et ne plus garder le jeton de rafraîchissement après le verrouillage automatique (#7).
5. Limitation de débit applicative et au bord, cache partagé (#8, #9, section Cloudflare).
6. Ne plus renvoyer référence et niveau de doublon à un agent (#3, #14) ; interdire un `blocking_levels` vide (#4) ; exiger `sent_at` (#5).


## Corrections apportées (15/11/2026)

Chaque correction est couverte par des tests (`backend/tests/test_security_hardening.py`, 50 tests ; suite serveur : 339 tests, tous verts ; client : 55 tests, tous verts).

| # | Correction |
|---|---|
| 2 | **Révocation d'appareil réelle.** L'identifiant d'appareil est écrit dans les deux jetons à la connexion (`did`) et la synchronisation refuse toute session non liée à l'appareil qui envoie. Révoquer un appareil refuse son jeton d'accès à la requête suivante (401), invalide ses jetons de rafraîchissement (et ceux des anciennes sessions non liées), refuse sa connexion. Un appareil révoqué ne revient pas sous un nouvel identifiant. Maximum 10 appareils actifs par agent. Les sessions des autres appareils de l'agent ne sont pas touchées. Sonde de départ (nouvel identifiant → 200) rejouée : maintenant 401. |
| 4 | **Configuration des doublons verrouillée.** Droit à part (`duplicate.configure`), motif écrit obligatoire, avant/après et motif dans le journal, dernier auteur affiché dans le Centre. Limites dans le code : seuils (élevé 70–95, moyen 40–80), poids minimaux (mère 20, date 15), niveau HIGH toujours bloquant (retrait refusé, et forcé par le service même si la base dit le contraire), valeur écrite en base hors limites ignorée, corps invalide = 400. La clé n'est pas modifiable par l'écran général des paramètres. |
| 5 | **Dates d'appareil.** `sent_at` obligatoire ; horloge non fiable au-delà de 48 h d'écart (date du serveur) : un `sent_at` fabriqué ne permet plus de reculer une saisie ; date antérieure à la naissance déclarée refusée ; saisie de plus de 7 jours signalée ; chaque anomalie tracée sur l'opération, l'historique du dossier et le journal d'audit (`sync_date_anomaly`, une seule fois même si le lot est rejoué). |
| 1 | **Détection.** Recherche des candidats par paliers (mère, nom de l'enfant, date exacte, fenêtre) avec plafond par palier ; plafond atteint = analyse marquée « tronquée » et journalisée ; l'analyse avant numéro officiel et l'analyse manuelle sont **sans plafond**. |
| 3, 14 | **Plus de sondage du registre.** Un agent ne reçoit plus ni l'alerte de la fiche, ni `duplicate_cases` dans la réponse de synchronisation, ni la référence dans son historique d'opérations. Le secrétariat voit tout comme avant. |
| 6, 11 | **En-têtes.** `vercel.json` : CSP stricte (aucun script en ligne, build sans CSS critique en ligne), `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS, COOP ; non-cache des fichiers du service worker. API : `no-store`, CSP `default-src 'none'; sandbox`, `nosniff`, `no-referrer`. Application répétée contre un serveur de statiques avec ces en-têtes : connexion, création du code, synchronisation et liste fonctionnent, aucune violation de la CSP. |
| 7 | **Code du coffre.** 8 caractères minimum avec lettres et chiffres (ou phrase de 14), mots courants et suites refusés. Un code faible existant est remplacé au déverrouillage suivant (écran « Renforcez votre code », données conservées). Le coût de dérivation est remis au niveau courant à ce moment. Limite connue : le jeton de rafraîchissement reste dans le coffre (nécessaire pour reprendre sans mot de passe) ; il est désormais lié à l'appareil et révocable. |
| 8, 9 | **Débit.** Garde-fou général (1 200/min par utilisateur, 120/min anonyme), `sync` 240/min, `ping` 60/min, analyses et comparaisons de doublons 20/min. Cache partagé via `REDIS_URL`, avertissement de déploiement `wakara.W001` sans lui, `wakara.W002` si `NUM_PROXIES` vaut 0. Liste des investigateurs mise en cache 60 s. |
| 12, 13 | Une observation ne peut viser qu'un des deux dossiers du cas ; un corps de requête invalide donne 400. |
| Cloudflare | Voir [securite-deploiement.md](./securite-deploiement.md) : `NUM_PROXIES=2`, règles de cache, de limitation de débit et de WAF. |
| 10 | **Mise à jour d'Angular — non faite, risque documenté.** L'application reste sur Angular 17.3 (fin de support). Essai de migration 17 → 21 dans une copie isolée : les étapes 18 et 19 compilent ; l'étape 20 exige de corriger un typage (`crypto.ts`, correction simple) ; l'étape 21 casse la compilation de composants (`ngClass` et autres directives non importées, composants autonomes) et demande une reprise écran par écran, avec test complet de l'application hors ligne. Ce chantier est à mener comme un projet à part, pas comme un correctif de sécurité. Les avis publiés contre Angular 17 concernent surtout le rendu côté serveur, l'internationalisation, la gestion XSRF par cookie et le formatage de dates ; Wakara n'utilise aucun de ces mécanismes (jeton porteur, pas de rendu serveur, pas de HTML tiers), l'exposition réelle est donc faible. À planifier : migration vers Angular 20 ou 21 avec recette complète.

## Ce qui reste à faire en dehors du code

1. Après déploiement : `python manage.py migrate` puis `python manage.py setup_initial_data --skip-admin` (nouveau droit `duplicate.configure` pour l'administrateur).
2. Définir `REDIS_URL` et vérifier `NUM_PROXIES` (voir le document de déploiement) ; créer les règles Cloudflare si Cloudflare est utilisé.
3. Chaque agent se reconnecte une fois avec son mot de passe (les anciennes sessions ne sont pas liées à l'appareil). Ceux dont le code est faible en choisissent un nouveau.
4. Vérifier sur le site réel l'ouverture d'une pièce PDF et les en-têtes (`curl -I`), la CSP n'ayant pu être éprouvée que sur un serveur de statiques local.
5. Les trois points de métier : valider avec la mairie les limites de réglage, la durée de 7 jours des saisies tardives et le maximum de 10 appareils.
