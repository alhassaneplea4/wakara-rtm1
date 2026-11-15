# Contrôle des doublons (Centre de contrôle)

Objectif : qu'une même naissance ne produise jamais deux actes officiels, quel que soit l'agent, l'appareil,
la synchronisation ou le service qui a saisi la déclaration. Le score est **une aide à la décision, jamais
une conclusion juridique** ; rien n'est supprimé, fusionné ni annulé automatiquement.

## Principe

1. À chaque création ou modification d'une déclaration (en ligne **ou reçue par la synchronisation hors
   ligne**), le serveur construit une *identité normalisée* (`BirthIdentity`) et la compare à toutes les
   autres déclarations de Ratoma, archivées comprises (les rejetées sont ignorées).
2. Une correspondance moyenne ou élevée ouvre un **dossier d'investigation** (`DuplicateCase`, DUP-AAAA-NNNN).
   Le circuit normal (collecte → secrétariat → file de validation) **n'est pas interrompu**.
3. Tant qu'un dossier n'est pas résolu par une décision humaine, **l'attribution du numéro officiel est
   refusée** (`actes.services.assign_official_number`, seul endroit où le numéro est attribué). Les niveaux
   de risque qui bloquent sont configurables (`DUPLICATE_BLOCKING_LEVELS`, défaut `HIGH,MEDIUM`).
4. La validation prend un verrou commun (`official-numbering`) et refait l'analyse si les données ont changé.

## Correspondance

* Normalisation : casse, accents, espaces, ponctuation, inversion nom/prénoms, formes phonétiques
  (Kamara/Camara, Mamadou/Mamadu), téléphones (indicatif 224), lieux (mots génériques ignorés).
  Les données saisies ne sont jamais modifiées.
* Score sur 100, pondération configurable : mère 30 · date de naissance 25 · lieu 15 · heure 10 · père 10 ·
  informations complémentaires 10 (nom de l'enfant, sexe, rang, établissement, référence hospitalière, adresse).
* **Un critère non renseigné d'un côté est exclu du calcul** (aucun point artificiel) ; le score est normalisé
  sur le poids réellement comparable et l'indicateur « qualité des données » dit quelle part des 100 points
  l'était.
* Seuils : ≥ 85 élevé, 60–84 moyen, < 60 faible (configurables). Garde-fous qui ramènent un risque élevé à moyen
  (ou à faible) : données comparables insuffisantes ; seules la mère, la date et le lieu concordent ; signes de
  naissance multiple (sexe, rang, prénoms ou heure différents) ; mères nettement différentes sans autre
  concordance forte.
* Jumeaux : même mère + même date + mêmes lieux ne concluent jamais à un doublon ; le dossier est qualifié
  « naissance multiple possible » et laissé à un humain.

## Décisions (motif obligatoire, auteur, date et heure enregistrés, ligne non modifiable)

Doublon confirmé · Deux enfants distincts · Naissance multiple · Erreur de saisie · Informations insuffisantes ·
Vérification complémentaire. Les deux dernières laissent le dossier ouvert (validation toujours bloquée).
« Doublon confirmé » et « Erreur de saisie » désignent la saisie redondante : elle est liée au dossier principal
et ne pourra pas recevoir de numéro. Si un acte existe déjà pour elle, un avertissement rappelle que la
rectification ou l'annulation suit la procédure légale : **aucune modification automatique d'un acte**.

## Permissions

`duplicate.view` (consulter), `duplicate.investigate` (prendre en charge, observations, vérifications, pièces),
`duplicate.decide` (décider, attribuer, rouvrir). Défauts : administrateur = tout ; secrétaire = consulter +
investiguer ; agent = rien. Les pièces justificatives restent sous `document.view` ; chaque consultation est
tracée (historique du dossier + journal d'audit). Les paramètres de détection se modifient avec `settings.manage`.

## Hors connexion

La synchronisation (`/api/sync/push/`, appareils, `op_id` idempotent) est celle du mode hors ligne existant : la
détection définitive est faite **par le serveur** à la réception (création = trigger `SYNC`). La réponse de
l'opération contient `duplicate_cases` lorsqu'une ressemblance est détectée ; la déclaration est toujours
conservée. Une vérification faite sur un appareil ne porte que sur ce qu'il a déjà synchronisé : elle n'est
jamais exhaustive et n'est pas présentée comme telle. Détection sérialisée par un verrou de ligne
(`duplicate-detection`) : de deux déclarations validées au même instant, la seconde analyse voit la première.

## API (`/api/duplicates/`)

`cases/` (liste filtrée, `summary/`, `filter-options/`, détail, `compare/`, `history/`, `take/`, `assign/`,
`note/`, `request-verification/`, `attach-document/`, `decide/`, `reopen/`) · `matches/` (alertes, `open-case/`) ·
`analyze/` · `compare/?a=&b=` · `config/`. La fiche d'une déclaration expose `duplicate_alert`.

## Mise en service

```bash
python manage.py migrate
python manage.py setup_initial_data --skip-admin   # crée les 3 permissions, les attache à l'admin et au secrétaire
python manage.py analyze_duplicates                # une fois : identités + analyse des déclarations existantes
```

## Points à valider par la mairie

* Seuils, pondérations et niveaux bloquants (valeurs initiales, à calibrer sur des cas réels).
* Qui décide : par défaut seul l'administrateur technique (`duplicate.decide`) ; le secrétariat investigue.
* Sens de « Erreur de saisie » (ici : saisie redondante désignée, comme un doublon confirmé).
* Rejeter les doublons confirmés par le circuit existant (rejet motivé) ou les laisser en l'état.
* Conservation des données personnelles dans les tables d'analyse (`BirthIdentity`) : durée et accès.
