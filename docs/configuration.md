# Configuration

Tous les secrets et réglages passent par `backend/.env` (modèle : `backend/.env.example`, **jamais** commité).
En production, fournir les mêmes variables par l'environnement du service.

| Variable | Défaut | Rôle |
|---|---|---|
| `SECRET_KEY` | — (obligatoire) | Clé Django. Longue, aléatoire, propre à chaque environnement |
| `DEBUG` | `False` | `True` uniquement en développement |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | Noms d'hôte servis |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:4200` | Origines du frontend |
| `CSRF_TRUSTED_ORIGINS` | vide | Origines HTTPS de confiance (production) |
| `DB_ENGINE`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT` | SQLite | PostgreSQL : `DB_ENGINE=django.db.backends.postgresql` (+ `pip install psycopg2-binary`) |
| `JWT_ACCESS_TOKEN_LIFETIME_MINUTES` | `60` | Durée du jeton d'accès |
| `JWT_REFRESH_TOKEN_LIFETIME_DAYS` | `7` | Durée du jeton de rafraîchissement |
| `LOGIN_THROTTLE_RATE` | `10/min` | Limite de tentatives de connexion par IP |
| `LOGIN_MAX_FAILED_ATTEMPTS` / `LOGIN_LOCKOUT_MINUTES` | `5` / `15` | Verrouillage temporaire d'un compte |
| `PRIVATE_MEDIA_ROOT` | `backend/private_media` | Pièces justificatives — **hors** de tout dossier servi publiquement |
| `MAX_UPLOAD_SIZE_MB` | `10` | Taille maximale d'une pièce |
| `WAKARA_ADMIN_USERNAME`, `WAKARA_ADMIN_PASSWORD`, `WAKARA_ADMIN_EMAIL` | — | Premier administrateur créé par `setup_initial_data` |
| `DEMO_USER_PASSWORD` | — | Mot de passe des comptes de démonstration (dev uniquement) |
| `SECURE_SSL_REDIRECT`, `SECURE_HSTS_SECONDS` | `True`, `31536000` | Durcissement HTTPS (si `DEBUG=False`) |

## Hypothèses métier configurables (à valider — voir `business-decisions.md`)

| Variable | Défaut | Effet |
|---|---|---|
| `DECLARATION_REQUIRED_FOR_TRANSMISSION` | `birth_date,child.gender,child.name,mother.name` | Données minimales pour transmettre une déclaration |
| `ACTE_REQUIRED_FOR_SUBMISSION` | `acte.declaration_date,declarant.name` | Données minimales pour soumettre un acte à validation |
| `ACTE_AUTO_NUMBERING` | `False` | `False` : numéro officiel saisi par l'administrateur à la validation. `True` : séquence automatique par (année, registre) |
| `STATS_SHOW_GENDER` | `True` | Affiche la répartition par sexe |

## Paramètres modifiables dans l'application (rôle avec `settings.manage`)

Écran **Paramètres** : textes de la page de connexion (étiquette, titre — `*mot*` met en couleur, description, pied de page)
et valeurs par défaut des actes (région, préfecture, commune, centre).
