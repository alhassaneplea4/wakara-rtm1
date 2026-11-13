# Documentation Wakara

1. [Installation](./installation.md)
2. [Architecture et décisions techniques](./architecture.md)
3. [Configuration (variables d'environnement)](./configuration.md)
4. [Déploiement](./deployment.md) · [Déploiement sur Vercel](./deployment-vercel.md)
5. [Sauvegarde et restauration](./backup-restore.md)
6. [Guide utilisateur par rôle](./user-guide.md)
7. [Décisions métier à valider](./business-decisions.md)
8. [Compte rendu des tests](./test-report.md)
9. **Mode hors connexion** (branche `wakara-hors-ligne`) : [architecture technique](./hors-ligne/architecture.md) · [exploitation](./hors-ligne/exploitation.md) · [guide de l'agent](./hors-ligne/guide-agent.md) · [audit initial](./hors-ligne/phase-0-audit.md)
10. **[Dossier de livraison (7 documents Word et PDF)](./livraison/README.md)** — cahier des charges, dossier technique, manuel utilisateur, guide d'exploitation, rapport de tests, PV de recette, PV de livraison

L'API est documentée automatiquement (OpenAPI) : en développement (`DEBUG=True`),
`http://localhost:8000/api/docs/` (Swagger) et `/api/schema/`. Ces routes sont désactivées en production.
