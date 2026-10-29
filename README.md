# WAKARA — État civil de la mairie de Ratoma

Application web de gestion des **déclarations de naissance** et des **actes de naissance**
(République de Guinée). Django 5 + Django REST Framework (API) · Angular 17 (interface) ·
SQLite en développement, PostgreSQL en production.

```
wakara-rtm1/
├── backend/    API Django (accounts, hospitals, declarations, actes, documents, audit, stats, core)
├── frontend/   Interface Angular (design system Wakara, 20 écrans)
└── docs/       Installation, architecture, configuration, déploiement, sauvegarde, guide utilisateur,
                décisions métier à valider, compte rendu des tests
```

## Démarrage rapide (développement)

Prérequis : Python 3.12+, Node.js 18+.

```bash
# 1. Backend
cd backend
python -m venv venv
venv\Scripts\activate            # Linux/macOS : source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env             # puis renseigner SECRET_KEY, WAKARA_ADMIN_* (voir docs/configuration.md)
python manage.py migrate
python manage.py setup_initial_data      # permissions, rôles, paramètres, premier administrateur
python manage.py seed_demo               # OPTIONNEL — données FICTIVES, refusé si DEBUG=False
python manage.py runserver               # http://localhost:8000

# 2. Frontend
cd ../frontend
npm install
npm start                                # http://localhost:4200
```

Aucun mot de passe n'est écrit dans le code ni dans ce dépôt : l'administrateur initial et les
comptes de démonstration sont créés avec les valeurs de `backend/.env` (`WAKARA_ADMIN_USERNAME`,
`WAKARA_ADMIN_PASSWORD`, `DEMO_USER_PASSWORD`).

## Rôles par défaut

| Rôle | Peut faire | Ne peut pas |
|---|---|---|
| **Agent de collecte** | Créer, modifier (brouillon / à corriger) et transmettre ses déclarations, joindre des pièces | Voir les dossiers des autres, valider, imprimer |
| **Secrétaire d'état civil** | Prendre en charge un dossier, compléter l'acte, soumettre à validation, imprimer et délivrer un acte validé | Valider ou rejeter |
| **Administrateur technique Wakara** | Valider / retourner / rejeter, gérer utilisateurs, rôles, permissions, établissements, paramètres, journaux | — (n'est **pas** superuser Django) |

Les permissions sont **granulaires** (32 codes, voir `backend/core/permissions.py`) et ajustables
par l'administrateur (rôles + surcharges par utilisateur). Le superuser Django ne possède **aucune**
permission métier : il sert uniquement à la maintenance (`/admin/`).

## Circuit d'un dossier

```
Brouillon → Transmis → En complément → En attente de validation → Validé définitivement → Acte délivré
                ▲             ▲                    │
                │             └─ À corriger — secrétariat ◄┤
                └──────────── À corriger — collecte ◄──────┤
                                                  Rejeté ◄─┘ (clos)
```

La machine à états est appliquée **côté serveur** (`backend/core/workflow.py`,
`backend/declarations/services.py`) : chaque transition vérifie la permission, le motif obligatoire,
la complétude des données, puis écrit l'historique et le journal d'audit dans une transaction.

## Tests

```bash
cd backend && python manage.py test tests        # 76 tests (workflow, permissions, audit, intégrité, documents, stats, sauvegarde)
cd frontend && npm run build                     # compilation stricte
```

Détails et limites : [docs/test-report.md](docs/test-report.md).

## Documentation

[docs/README.md](docs/README.md) · [Décisions métier à valider](docs/business-decisions.md)

## Licence

Propriétaire — Mairie de Ratoma
