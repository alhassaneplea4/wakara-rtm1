# Dossier de livraison Wakara

**WAKARA — Dossier officiel de documentation et de livraison**
Centre d'état civil et de l'identification de Ratoma · version 1.0 · 9 novembre 2026

Chaque document existe en **Word** (modifiable, à imprimer ou compléter) et en **PDF** (lecture et diffusion).

| N° | Document | Pour qui | Word | PDF |
|---|---|---|---|---|
| 01 | Cahier des charges fonctionnel et technique | Document de référence | [docx](./01-Cahier-des-charges.docx) | [pdf](./01-Cahier-des-charges.pdf) |
| 02 | Dossier technique | Développeurs et administrateurs techniques | [docx](./02-Dossier-technique.docx) | [pdf](./02-Dossier-technique.pdf) |
| 03 | Manuel d'utilisation (avec captures d'écran) | Agents, secrétaires, administrateurs | [docx](./03-Manuel-utilisateur.docx) | [pdf](./03-Manuel-utilisateur.pdf) |
| 04 | Guide d'installation et d'exploitation | Administrateurs techniques | [docx](./04-Guide-installation-exploitation.docx) | [pdf](./04-Guide-installation-exploitation.pdf) |
| 05 | Rapport de tests | Client et prestataire | [docx](./05-Rapport-de-tests.docx) | [pdf](./05-Rapport-de-tests.pdf) |
| 06 | Procès-verbal de recette (à compléter et signer) | Client et prestataire | [docx](./06-PV-de-recette.docx) | [pdf](./06-PV-de-recette.pdf) |
| 07 | Procès-verbal de livraison et de réception (à compléter et signer) | Client et prestataire | [docx](./07-PV-de-livraison.docx) | [pdf](./07-PV-de-livraison.pdf) |

## À compléter avant la remise

- **Documents 06 et 07** : noms, fonctions, dates, lieu, résultats de recette, réserves, signatures. Ce sont des formulaires : ils sont volontairement vierges.
- **Document 07** : référence du dernier commit livré, date de mise en ligne, modalités de maintenance et de garantie, points contractuels (propriété du code, protection des données, continuité du service, validité administrative).
- **Tous les documents** : le nom du prestataire figure sur la page de garde (fichier `outils/meta.mjs`).
- **Aucun mot de passe ni secret** n'est écrit dans ces documents : ils se remettent séparément (voir le document 07).

## Régénérer les documents

Les contenus sont écrits dans `outils/contenus/` et produisent à la fois le Word et le PDF. Prérequis : Node.js 18+ et Microsoft Edge (rendu des PDF et des schémas).

```bash
cd docs/livraison/outils
npm install
node generer.mjs          # tous les documents ; ex. « node generer.mjs 03 » pour un seul
node diagrammes.mjs       # schémas (architecture, circuit, données) → images/
```

- `outils/meta.mjs` : client, prestataire, version, date, adresse.
- `outils/donnees-schema.json` : structure des tables, régénérée par `exporter_schema.py` (depuis `backend`, avec l'environnement virtuel) pour le dictionnaire des données du document 02.
- `images/` : captures d'écran du manuel (données fictives) et schémas.
