# Sécurité du déploiement — en-têtes, cache, limitation de débit, Cloudflare

Ce document complète [audit-securite-hors-ligne-doublons.md](./audit-securite-hors-ligne-doublons.md). Il décrit ce que le code fait
déjà et ce qu'il faut régler à l'extérieur du code (Vercel, Cloudflare, variables d'environnement).

## 1. Ce que le code fait

| Sujet | Où | Effet |
|---|---|---|
| En-têtes de l'application (CSP, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS, COOP) | `vercel.json` → `headers` | Toutes les pages, sauf `/api/` |
| Pas de cache pour `ngsw.json`, `ngsw-worker.js`, `index.html`, `manifest.webmanifest` | `vercel.json` | Une mise à jour est vue au prochain chargement |
| `Cache-Control: no-store`, CSP `default-src 'none'; sandbox`, `nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin` | `core/middleware.py` | Toute réponse de `/api/` ; un en-tête déjà posé par la vue est conservé |
| Pas de style ni de script en ligne | `angular.json` (`inlineCritical: false`) | La CSP n'a pas besoin de `'unsafe-inline'` pour les scripts |
| Limitation de débit | `settings.py` (`DEFAULT_THROTTLE_*`), `sync/views.py`, `duplicates/views.py` | Voir [exploitation.md](./hors-ligne/exploitation.md#3-réglages) |
| Avertissements de déploiement | `core/checks.py`, `python manage.py check --deploy` | `wakara.W001` cache de limitation propre à chaque instance ; `wakara.W002` `NUM_PROXIES` à 0 |

La CSP de l'application : `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'none'; object-src 'self' blob:;
base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`. `style-src 'unsafe-inline'` est nécessaire
aux styles de composants d'Angular ; les scripts, eux, ne peuvent venir que de l'application. Polices et icônes sont servies par
l'application (aucun site tiers). `object-src blob:` permet d'ouvrir une pièce justificative (PDF) dans un nouvel onglet.

**À vérifier après le premier déploiement** : ouvrir une pièce PDF et une photo dans un nouvel onglet ; consulter la console du
navigateur (aucune erreur « Refused to … Content Security Policy ») ; contrôler les en-têtes avec
`curl -I https://<votre-domaine>/` et `curl -I https://<votre-domaine>/api/sync/ping/`.

## 2. Variables d'environnement à définir en production

| Variable | Valeur | Pourquoi |
|---|---|---|
| `REDIS_URL` | `rediss://…` | Compteurs de limitation partagés entre instances. Sans elle chaque instance compte seule : la limite réelle est un multiple de la limite configurée |
| `NUM_PROXIES` | `1` derrière Vercel seul, `2` derrière Cloudflare puis Vercel | Adresse du client pour la limite de connexion et le journal d'audit |
| `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, `CORS_ALLOWED_ORIGINS` | domaines réels, sans joker | |
| `SECURE_HSTS_SECONDS` | `31536000` (défaut) | |
| `SECRET_KEY` | 50 caractères aléatoires ou plus | Sans elle, la clé est dérivée de l'adresse de la base. Changer la clé ferme toutes les sessions ouvertes |
| `DOSSIER_SEPARATE_SUBMIT_AND_VALIDATE` | `True` (défaut) | Personne ne valide le dossier qu'il a soumis. À mettre à `False` seulement si une seule personne tient le secrétariat |
| `JWT_ACCESS_TOKEN_LIFETIME_MINUTES` | `30` (défaut) | Durée de vie d'un jeton d'accès |

**Vérifier le déploiement** : `python manage.py check_production` (le build de production l'affiche dans ses journaux). Il signale
ce qui bloque (DEBUG actif, Redis absent, base non PostgreSQL, migrations en attente, comptes d'aperçu, aucun administrateur) et ce qui est
seulement conseillé (SECRET_KEY non définie, domaines locaux autorisés, `NUM_PROXIES`).

**Node** : le frontend (Angular 21) demande Node 20.19 ou plus ; `package.json` impose `22.x`, que Vercel applique au build.

## 3. Cloudflare devant l'application

Cloudflare n'est pas requis. S'il est placé devant Vercel :

1. **`NUM_PROXIES=2`.** Sinon l'adresse lue est celle de Cloudflare : la limite de connexion (10/min) s'applique à tout le monde à la fois et le
   journal d'audit enregistre une mauvaise adresse. Mode SSL/TLS : **Full (strict)**.
2. **Cache.** Règle « Contourner le cache » sur `/api/*`. Ne pas activer « Cache Everything » sur le domaine. Ne jamais mettre en cache `ngsw.json`,
   `ngsw-worker.js`, `index.html`, `manifest.webmanifest` (le service worker compare des empreintes : une version périmée casse la mise à jour hors ligne).
3. **Optimisation.** Désactiver Rocket Loader, Auto Minify, Mirage et Email Obfuscation : modifier un fichier JavaScript ou HTML invalide les
   empreintes d'Angular et la CSP.
4. **Limitation de débit** (règles au bord, en plus de celle de l'application) :

   | Chemin | Seuil conseillé | Clé |
   |---|---|---|
   | `/api/auth/login/` | 10 requêtes / minute | adresse IP |
   | `/api/auth/refresh/` | 30 / minute | adresse IP |
   | `/api/sync/push/`, `/api/sync/documents/` | 120 / minute | adresse IP |
   | `/api/sync/ping/` | 60 / minute | adresse IP (point public) |
   | `/api/duplicates/analyze/`, `/api/duplicates/compare/` | 20 / minute | adresse IP |

5. **WAF.** Gestion des règles managées activée ; laisser passer le corps multipart de 4 Mo de `/api/sync/documents/` ; limiter les méthodes à
   `GET, POST, PATCH, OPTIONS, HEAD` sur `/api/*`.
6. **En-têtes.** Si Cloudflare ajoute HSTS ou une CSP, vérifier qu'il ne les double pas ; la CSP de `vercel.json` fait foi.
7. **Accès à l'origine.** Restreindre l'accès direct à l'adresse Vercel si possible, pour qu'aucune requête ne contourne les règles ci-dessus.

## 4. Points qui restent à la charge de l'exploitation

- **Appareil volé** : révoquer l'appareil (coupe ses sessions) *et*, si le code du coffre est faible ou connu, désactiver le compte puis changer le mot de passe.
- **Jetons d'accès** : valables 30 minutes (`JWT_ACCESS_TOKEN_LIFETIME_MINUTES`) ; ils sont refusés dès la déconnexion, la révocation de l'appareil, le changement ou la réinitialisation du mot de passe et la désactivation du compte.
- **Dépendances** : Angular 21 et versions Python verrouillées ; relancer `npm audit --omit=dev` et `pip-audit -r backend/requirements.txt` avant chaque mise en production.
- **Double authentification** : **réalisée** par application d'authentification (TOTP, sans SMS ni service externe), facultative par défaut. Pour l'exiger : paramètre `security.two_factor_roles` (ex. `admin,secretary`, ou `all`). Un compte concerné n'accède qu'à son profil tant qu'elle n'est pas configurée. Réinitialisation par un **autre** administrateur (écran Utilisateurs) ou `python manage.py reset_two_factor <identifiant> --reason "…"`. À décider avec la mairie : les rôles concernés (au moins l'administrateur et les validateurs).
- **`FIELD_ENCRYPTION_KEY`** : à définir une fois et à ne plus changer ; chiffre les codes de récupération des appareils et les secrets de double authentification.
- **Code de récupération d'un appareil** : lu par l'administrateur habilité (`device.recover`) avec son mot de passe et un motif, chaque lecture au journal ; ne jamais le communiquer pour un appareil volé (révoquer l'appareil).
- **Volume de la base** : les photos sont dans la base (Neon gratuit : 512 Mo) ; `check_production` alerte au-delà de `DATABASE_SIZE_WARN_MB` (350 Mo par défaut).
- **Rôles personnalisés** : `check_production` signale ceux qui peuvent ajouter des pièces mais pas retirer une pièce envoyée (`document.archive`).

## 5. Revue avant ouverture au public (19/11/2026)

| Contrôle | Résultat |
|---|---|
| Secrets hors du code | Aucun secret dans le dépôt ni dans son historique (54 commits analysés) ; `.env` ignoré par git ; tout passe par des variables d'environnement (`backend/.env.example`) |
| Secrets côté interface | Aucun dans le paquet construit ; l'interface ne connaît que l'adresse relative `/api` |
| Base de données | Connexion chiffrée imposée pour toute base distante (`sslmode=require` par défaut) ; base des aperçus séparée de la production ; sauvegarde chiffrée quotidienne (inactive tant que ses secrets ne sont pas créés) |
| Accès aux données | Droits vérifiés par le serveur à chaque requête (refus par défaut) ; chaque utilisateur ne voit que ce que son rôle permet ; pages d'administration protégées par le serveur et par les gardes de l'interface |
| Connexion | Seule la connexion par identifiant et mot de passe existe (aucun service tiers) ; limitation des essais par adresse et par compte ; double authentification ; jeton de 30 minutes ; **déconnexion automatique après 30 minutes d'inactivité** ; champ piège anti-robot sur le formulaire de connexion |
| Saisies et fichiers | Validation côté serveur (sérialiseurs) ; ORM Django (aucune requête SQL construite à la main) ; pièces : type, signature et taille contrôlés (4 Mo sur Vercel) |
| En-têtes | CSP stricte (aucun script en ligne), HSTS, anti-cadre, pas de référent, `nosniff`, cache interdit sur l'API, `Access-Control-Allow-Origin` limité au domaine du site ; CORS de l'API **vide par défaut** en production |
| Erreurs et journaux | Réponses d'erreur génériques ; aucun nom ni donnée personnelle dans les journaux techniques (configuration `LOGGING`) ; le journal d'audit garde qui/quoi/quand/IP, jamais un mot de passe |
| Surface exposée | Console d'administration Django **désactivée en production** (`ENABLE_DJANGO_ADMIN`) ; documentation de l'API absente ; `/.git`, `/.env`, `package.json` et `/admin` répondent 404 |
| Paquets | Les 60 paquets de l'interface et les paquets Python verrouillés existent réellement sur leurs registres (aucun nom inventé) ; `npm audit --omit=dev` : 0 ; `pip-audit` : 0 (reste, en développement seulement, 21 avis modérés sur l'outil de construction Angular CLI) |
| HTTPS | Redirection HTTP → HTTPS (308), HSTS 1 an ; certificat géré par Vercel |
| Pages légales | Confidentialité, conditions d'utilisation, mentions légales, cookies : publiques, textes éditables (Paramètres) ; mention « version provisoire » tant que `legal.validated` ≠ `true` |
| Cookies | Aucun cookie de suivi ; bandeau d'information et de choix ; mesure d'audience facultative, sans cookie ni identifiant, uniquement sur les pages publiques |
| Référencement | `robots.txt` (seules les pages publiques sont indexables), `sitemap.xml`, `/.well-known/security.txt`, titres, descriptions, image de partage ; toutes les pages de l'application en `noindex` |
