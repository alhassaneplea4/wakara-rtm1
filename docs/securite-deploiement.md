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
- **Jetons d'accès** : valables 60 minutes (`JWT_ACCESS_TOKEN_LIFETIME_MINUTES`) ; ils sont refusés dès la révocation de l'appareil.
- **Dépendances** : Angular 17 n'est plus maintenu ; voir l'état de la mise à jour dans le rapport d'audit.
