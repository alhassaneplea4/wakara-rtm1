# Documentation Wakara

1. [Installation](./installation.md)
2. [Architecture et décisions techniques](./architecture.md)
3. [Configuration (variables d'environnement)](./configuration.md)
4. [Déploiement](./deployment.md) · [Déploiement sur Vercel](./deployment-vercel.md)
5. [Sauvegarde et restauration](./backup-restore.md)
6. [Guide utilisateur par rôle](./user-guide.md)
7. [Décisions métier à valider](./business-decisions.md)
8. [Compte rendu des tests](./test-report.md)

L'API est documentée automatiquement (OpenAPI) : en développement (`DEBUG=True`),
`http://localhost:8000/api/docs/` (Swagger) et `/api/schema/`. Ces routes sont désactivées en production.
