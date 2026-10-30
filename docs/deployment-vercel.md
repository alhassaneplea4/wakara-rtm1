# Déploiement sur Vercel (front Angular + API Django dans un seul projet)

Le fichier [`vercel.json`](../vercel.json) à la racine déclare deux *services* (Vercel Services, en bêta) sur un même domaine :

| Service | Dossier | Chemin public |
|---|---|---|
| `backend` (Django) | `backend/` | `/api/…` |
| `frontend` (Angular) | `frontend/` | tout le reste |

L'API est donc servie sur le même domaine que l'interface : pas de CORS à régler, et `environment.prod.ts` utilise déjà `/api`.

## Ce que Vercel ne fournit pas : à brancher avant le premier déploiement

Le disque d'une fonction Vercel est **en lecture seule et non persistant**. Deux choses doivent donc être externes :

1. **Base PostgreSQL** (SQLite est impossible). Créez-en une (Neon via la Marketplace Vercel, ou Supabase) : vous obtenez une `DATABASE_URL`.
2. **Stockage privé des documents** (fiches physiques, pièces d'identité) dans un **bucket S3-compatible privé** : AWS S3, Cloudflare R2 ou Supabase Storage.
   Ne rendez jamais le bucket public : les fichiers sont servis uniquement par l'endpoint authentifié et audité de Wakara.

## Variables d'environnement (Vercel → Settings → Environment Variables)

| Variable | Valeur |
|---|---|
| `SECRET_KEY` | `python -c "import secrets; print(secrets.token_urlsafe(64))"` |
| `DEBUG` | `False` |
| `DATABASE_URL` | URL PostgreSQL (`…?sslmode=require`) |
| `DOCUMENTS_S3_BUCKET`, `DOCUMENTS_S3_ACCESS_KEY`, `DOCUMENTS_S3_SECRET_KEY` | accès au bucket privé |
| `DOCUMENTS_S3_ENDPOINT_URL` | vide pour AWS ; `https://<compte>.r2.cloudflarestorage.com` pour R2 |
| `DOCUMENTS_S3_REGION` | région du bucket (`auto` pour R2) |
| `MAX_UPLOAD_SIZE_MB` | `4` — une fonction Vercel refuse les requêtes de plus de 4,5 Mo |
| `ALLOWED_HOSTS` | votre domaine personnalisé, s'il y en a un (les noms `*.vercel.app` du déploiement sont ajoutés automatiquement) |
| `CSRF_TRUSTED_ORIGINS` | `https://votre-domaine` (domaine personnalisé uniquement) |

Les identifiants du premier administrateur ne sont **pas** à mettre dans Vercel : ils ne servent qu'à l'initialisation (étape suivante).

## Initialiser la base (une seule fois, depuis votre poste)

Vercel n'exécute pas les migrations. Depuis `backend`, venv activé, en pointant vers la base de production :

```powershell
$env:DATABASE_URL = "postgres://…"          # la même que dans Vercel
$env:DEBUG = "False"
$env:WAKARA_ADMIN_USERNAME = "admin.wakara"
$env:WAKARA_ADMIN_PASSWORD = "<mot de passe robuste>"
python manage.py migrate
python manage.py setup_initial_data
```

Refaites `python manage.py migrate` à chaque déploiement qui ajoute une migration. `seed_demo` est refusé en production (c'est voulu).

## Points d'attention

- **Taille des fichiers** : 4 Mo maximum par envoi. L'interface réduit automatiquement les photos ; un PDF plus lourd est refusé avec un message.
- **Anti-force-brute** : le verrouillage des comptes (5 échecs / 15 min) est stocké en base et reste fiable. La limitation de débit par adresse IP utilise un cache mémoire propre à chaque instance : elle est moins stricte en serverless. Pour la renforcer, branchez un cache partagé (Redis / Upstash) dans `CACHES`.
- **Django Admin** (`/admin/`) n'est pas exposé par `vercel.json` (seul `/api/` est routé vers Django). La maintenance se fait par les commandes `manage.py` depuis votre poste.
- **Sauvegardes** : `backup_wakara` sauvegarde la base mais **pas** le bucket (message affiché). Activez les sauvegardes de la base chez votre fournisseur PostgreSQL et le versionnement du bucket.
- **Données d'état civil** : ce sont des données personnelles. Choisissez la région de la base et du bucket en connaissance de cause et faites valider l'hébergement par la mairie.
- **Services Vercel** est en bêta : si le déploiement échoue sur la configuration `services`, ouvrez le journal de build ; le dépôt reste déployable sur un serveur classique (voir [deployment.md](deployment.md)).
- **Rechargement d'une page profonde** (`/declarations/…`) : à vérifier après le premier déploiement (la redirection vers `index.html` est gérée par Vercel pour Angular ; si vous obtenez une 404, signalez-le).

## Vérification après déploiement

1. `https://<domaine>/api/public/settings/` répond en JSON.
2. La page de connexion s'affiche et la connexion avec l'administrateur fonctionne.
3. Création d'une déclaration avec une photo de la fiche physique, puis réouverture du dossier : la photo s'affiche.
