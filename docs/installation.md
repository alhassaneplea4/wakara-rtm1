# Installation (développement)

## Prérequis

| Logiciel | Version |
|---|---|
| Python | 3.12+ (testé avec 3.14) |
| Node.js / npm | 18+ (testé avec Node 24) |
| PostgreSQL | 15+ (production uniquement) |

## Backend

```bash
cd backend
python -m venv venv
venv\Scripts\activate                 # Linux/macOS : source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Renseignez dans `backend/.env` au minimum :

```
SECRET_KEY=<python -c "import secrets; print(secrets.token_urlsafe(64))">
DEBUG=True
WAKARA_ADMIN_USERNAME=admin.wakara
WAKARA_ADMIN_PASSWORD=<mot de passe robuste>
```

Puis :

```bash
python manage.py migrate
python manage.py setup_initial_data     # idempotent : permissions, rôles, paramètres, 1er administrateur
python manage.py runserver
```

`setup_initial_data` crée l'**administrateur technique Wakara** (rôle métier, **pas** superuser Django).
Pour un accès à Django Admin (maintenance uniquement) : `python manage.py createsuperuser`.

### Données de démonstration (développement uniquement)

```bash
python manage.py seed_demo --count 45
```

Crée des dossiers **fictifs** via les vraies règles du workflow ainsi que deux comptes
(`secretaire`, `agent.collecte`) dont le mot de passe est `DEMO_USER_PASSWORD` dans `.env`.
La commande refuse de s'exécuter si `DEBUG=False`.

## Frontend

```bash
cd frontend
npm install
npm start          # http://localhost:4200, API attendue sur http://localhost:8000/api
```

L'URL de l'API se règle dans `frontend/src/environments/environment.ts` (développement) et
`environment.prod.ts` (production, `/api` derrière le même domaine par défaut).

## Vérification

```bash
cd backend && python manage.py check && python manage.py test tests
cd frontend && npm run build
```

## Dépannage : « le menu ne répond plus » / « la déconnexion ne fait rien »

Ces symptômes apparaissent quand le **serveur de développement s'arrête ou est reconstruit** alors qu'un onglet reste ouvert :
les pages chargées à la demande n'existent plus côté serveur. Vérifiez que `npm start` (port 4200) et `python manage.py runserver`
(port 8000) tournent, puis rechargez la page (Ctrl+F5). L'application tente de se recharger seule une fois et affiche un message sinon.
