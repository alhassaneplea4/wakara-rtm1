# Déploiement sur Vercel (front Angular + API Django dans un seul projet)

Le fichier [`vercel.json`](../vercel.json) à la racine déclare deux *services* (Vercel Services, en bêta) sur un même domaine :

| Service | Dossier | Chemin public |
|---|---|---|
| `backend` (Django) | `backend/` | `/api/…` |
| `frontend` (Angular) | `frontend/` | tout le reste |

L'API est donc servie sur le même domaine que l'interface : pas de CORS à régler, et `environment.prod.ts` utilise déjà `/api`.

## Ce qu'il faut côté Vercel (une seule chose à créer)

Le disque d'une fonction Vercel est en lecture seule et non persistant : SQLite et le dossier local de documents sont donc impossibles.

1. **Une base PostgreSQL** : dans le projet Vercel, onglet *Storage* (ou *Marketplace*) → **Neon** → créer la base et la connecter au projet. Vercel ajoute seul la variable `DATABASE_URL`.
2. **Les documents** (fiches physiques, pièces d'identité) sont enregistrés **dans cette même base**, de façon privée (`DOCUMENTS_STORAGE=database`, valeur par défaut sur Vercel). Aucun bucket à créer, et ils sont inclus dans les sauvegardes de la base.
   Pour de gros volumes, un bucket S3 privé (AWS S3, Cloudflare R2, Supabase Storage) reste possible : renseignez `DOCUMENTS_S3_BUCKET` et les variables associées.

## Variables d'environnement (Vercel → Settings → Environment Variables, environnement *Production*)

| Variable | Valeur |
|---|---|
| `SECRET_KEY` | `python -c "import secrets; print(secrets.token_urlsafe(64))"` |
| `DEBUG` | `False` |
| `DATABASE_URL` | ajoutée par l'intégration Neon (sinon : URL PostgreSQL avec `?sslmode=require`) |
| `MAX_UPLOAD_SIZE_MB` | `4` : une fonction Vercel refuse les requêtes de plus de 4,5 Mo |
| `WAKARA_ADMIN_USERNAME`, `WAKARA_ADMIN_PASSWORD` | premier administrateur technique (voir ci-dessous) |
| `ALLOWED_HOSTS` / `CSRF_TRUSTED_ORIGINS` | seulement pour un domaine personnalisé (`domaine.com` / `https://domaine.com`) ; les noms `*.vercel.app` sont autorisés automatiquement |
| *(facultatif)* `DOCUMENTS_S3_BUCKET`, `DOCUMENTS_S3_ACCESS_KEY`, `DOCUMENTS_S3_SECRET_KEY`, `DOCUMENTS_S3_ENDPOINT_URL`, `DOCUMENTS_S3_REGION` | documents dans un bucket S3 privé au lieu de la base |

## Initialisation de la base : automatique

À chaque déploiement **de production**, l'étape de build ([`backend/build.py`](../backend/build.py), déclarée dans `vercel.json`) exécute :

```
python manage.py migrate --noinput
python manage.py setup_initial_data
```

- Les deux commandes sont idempotentes : permissions, rôles et paramètres sont créés une fois, les migrations ajoutées plus tard s'appliquent seules.
- `WAKARA_ADMIN_PASSWORD` n'est lu que si l'administrateur n'existe pas encore. **Une fois connecté, changez son mot de passe puis supprimez cette variable de Vercel.**
- Les déploiements *Preview* ne touchent jamais à la base. Le build de production échoue avec un message clair si `DATABASE_URL` est absente.
- `seed_demo` est refusé en production (c'est voulu).
- Si cette étape ne s'exécute pas chez vous, faites-la à la main depuis `backend` (venv activé) avec `DATABASE_URL`, `DEBUG=False` et `WAKARA_ADMIN_*` définis : `python manage.py migrate` puis `python manage.py setup_initial_data`.

## Points d'attention

- **Taille des fichiers** : 4 Mo maximum par envoi. L'interface réduit automatiquement les photos ; un PDF plus lourd est refusé avec un message.
- **Anti-force-brute** : le verrouillage des comptes (5 échecs / 15 min) est stocké en base et reste fiable. La limitation de débit par adresse IP utilise un cache mémoire propre à chaque instance : elle est moins stricte en serverless. Pour la renforcer, branchez un cache partagé (Redis / Upstash) dans `CACHES`.
- **Django Admin** (`/admin/`) n'est pas exposé par `vercel.json` (seul `/api/` est routé vers Django). La maintenance se fait par les commandes `manage.py` depuis votre poste.
- **Sauvegardes** : activez les sauvegardes automatiques de la base chez votre fournisseur PostgreSQL (documents inclus). Avec un bucket S3, `backup_wakara` ne l'inclut pas (message affiché) : activez le versionnement du bucket.
- **Volume des documents** : en base, chaque photo pèse 1 à 3 Mo ; surveillez la taille de la base (offre gratuite Neon : 0,5 Go) et passez au bucket S3 si besoin.
- **Données d'état civil** : ce sont des données personnelles. Choisissez la région de la base (et du bucket, le cas échéant) en connaissance de cause et faites valider l'hébergement par la mairie.
- **Services Vercel** est en bêta : si le déploiement échoue sur la configuration `services`, ouvrez le journal de build ; le dépôt reste déployable sur un serveur classique (voir [deployment.md](deployment.md)).
- **Rechargement d'une page profonde** (`/declarations/…`) : à vérifier après le premier déploiement (la redirection vers `index.html` est gérée par Vercel pour Angular ; si vous obtenez une 404, signalez-le).

## Vérification après déploiement

1. `https://<domaine>/api/public/settings/` répond en JSON.
2. La page de connexion s'affiche et la connexion avec l'administrateur fonctionne.
3. Création d'une déclaration avec une photo de la fiche physique, puis réouverture du dossier : la photo s'affiche.
