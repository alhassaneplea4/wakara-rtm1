# Déploiement

> L'hébergement (serveur local, cloud national ou international) n'est pas arrêté : voir
> `business-decisions.md` §7. Ce guide décrit une cible Linux générique ; à adapter une fois la décision prise.

## Environnements

Trois environnements **séparés** (développement, test/recette, production), chacun avec son `.env`,
sa base et son `PRIVATE_MEDIA_ROOT`. Développement et recette n'utilisent que des **données fictives**
tant qu'aucune autorisation d'utiliser des données réelles n'a été donnée.

## Backend (gunicorn + reverse proxy HTTPS)

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt psycopg2-binary gunicorn
# les variables du .env sont fournies par le service (systemd EnvironmentFile)
python manage.py migrate
python manage.py collectstatic --noinput
python manage.py setup_initial_data
gunicorn wakara.wsgi:application --bind 127.0.0.1:8000 --workers 3
```

Prérequis de production (`DEBUG=False`) : `SECRET_KEY` unique, `ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS`,
`CSRF_TRUSTED_ORIGINS` en HTTPS, PostgreSQL, `PRIVATE_MEDIA_ROOT` hors webroot (permissions 700, propriétaire = compte du service).
Avec plusieurs workers, remplacer le cache local par Redis/Memcached (`CACHES`) pour que la limitation de débit soit partagée.

Le proxy (nginx/Caddy) doit : terminer TLS, transmettre `X-Forwarded-Proto` et `X-Forwarded-For`,
servir `/static/` (Django Admin) et **ne jamais** servir `PRIVATE_MEDIA_ROOT`.

## Frontend

```bash
cd frontend && npm ci && npm run build      # dist/wakara-frontend/browser
```

Servir `dist/wakara-frontend/browser` en statique avec repli SPA (`try_files $uri /index.html`) et
router `/api/` vers gunicorn (même domaine → `environment.prod.ts` : `apiUrl: '/api'`).

## Durcissement de la traçabilité (recommandé)

Créer pour l'application un rôle PostgreSQL distinct de l'administrateur de base et lui retirer les droits
de modification/suppression sur les tables d'historique :

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON audit_auditlog, declarations_statushistory FROM wakara_app;
```

## Liste de contrôle avant mise en production

- [ ] `python manage.py check --deploy` sans alerte bloquante
- [ ] Mots de passe de l'administrateur initial changés, aucun compte de démonstration
- [ ] HTTPS valide, HSTS actif
- [ ] Sauvegarde automatique planifiée **et restauration testée** (`backup-restore.md`)
- [ ] Décisions métier de `business-decisions.md` validées par la mairie
- [ ] Documents d'état civil non accessibles sans authentification (test manuel)
