# Décisions métier à valider

Wakara n'invente aucune règle administrative ou juridique. Chaque point ci-dessous est une **hypothèse de travail**
implémentée de façon **configurable** ; elle doit être confirmée par les autorités compétentes de la mairie de Ratoma
avant la mise en production. Légende : ⏳ à confirmer.

| # | Sujet | Hypothèse actuellement implémentée | Où l'ajuster |
|---|---|---|---|
| 1 | **Numérotation officielle des actes** | Aucune règle codée en dur. Par défaut le numéro est **saisi** par l'administrateur à la validation (unicité garantie par année + registre, transactionnelle). Numérotation automatique séquentielle par (année, registre) disponible mais **désactivée** | `ACTE_AUTO_NUMBERING`, `actes/services.py` |
| 2 | **Champs obligatoires** | Brouillon : date de naissance seule. Transmission : date de naissance, sexe, nom de l'enfant, nom de la mère. Soumission de l'acte : date de déclaration, nom du déclarant | `DECLARATION_REQUIRED_FOR_TRANSMISSION`, `ACTE_REQUIRED_FOR_SUBMISSION` |
| 3 | **Liste des statuts** | Brouillon, Transmis, En complément, En attente de validation, À corriger (collecte / secrétariat), Validé, Rejeté (clos), Délivré | `core/workflow.py` |
| 4 | **Circuit de retour** | Retour collecte → l'agent corrige et retransmet. Retour secrétariat → le secrétariat corrige et resoumet | `core/workflow.py` |
| 5 | **Signatures et mentions** | Mention textuelle de l'officier d'état civil ; pas de signature électronique | `actes.Acte` |
| 6 | **Modèle officiel du document** | Modèle de travail HTML imprimable, en lecture seule, calqué sur la fiche papier (volet n° 1 : en-tête de registre, ENFANT, PARENTS, DÉCLARANT, dates et heure en lettres, NPI, téléphones), avec filigrane « ACTE NON VALIDE » avant validation. Les formulaires fournis sont des références, pas des modèles validés | `frontend/.../acte-document.component.ts` |
| 7 | **Impression / délivrance** | Après validation uniquement. Chaque impression est journalisée. Une 2ᵉ délivrance est enregistrée comme *duplicata* | `actes/services.py` |
| 8 | **Qui imprime / délivre** | Secrétaire et administrateur. L'agent de collecte non | rôles par défaut |
| 9 | **Corrections après validation** | **Non prévues** : un dossier validé, rejeté ou délivré est figé. Procédure (rectification, mention marginale, nouvelle version) à définir | — |
| 10 | **Naissances multiples** | Une déclaration par enfant, sans lien automatique entre jumeaux | modèle `Declaration` |
| 11 | **Père inconnu / informations manquantes** | Père optionnel ; champs d'identité facultatifs sauf minimum de transmission | idem |
| 12 | **Déclaration tardive** | Aucune règle de délai codée | — |
| 13 | **Déclaration sans établissement** | Acceptée (établissement vide) | `Declaration.hospital` |
| 14 | **Politique de mot de passe** | Validateurs Django (longueur ≥ 8, pas de mot de passe courant ni uniquement numérique, similarité). Verrouillage 15 min après 5 échecs. Pas d'expiration périodique | `AUTH_PASSWORD_VALIDATORS`, `LOGIN_*` |
| 15 | **Durée de session** | Jeton d'accès 60 min, refresh 7 jours | `JWT_*` |
| 16 | **Conservation des données et du journal** | Conservation illimitée, aucune purge automatique | — |
| 17 | **Hébergement et lieu de stockage** | ⏳ À déterminer (local / cloud national / international) ; contraintes guinéennes de conservation et d'hébergement à confirmer | `deployment.md` |
| 18 | **Statistiques** | Définitions : *naissances déclarées* = déclarations enregistrées (brouillons inclus, 1 déclaration = 1 enfant) ; *reçues* = hors brouillon ; *validés* = validé + délivré. Période = date de réception. Répartition par sexe incluse | `stats/views.py`, `STATS_SHOW_GENDER` |
| 19 | **Visibilité des dossiers** | Agent de collecte : ses déclarations. Secrétaire et administrateur : tous. Qui peut consulter les actes finalisés : à confirmer | `declaration.view_all` |
| 20 | **Champs du modèle officiel** | Champs déduits des deux formulaires de référence (hôpital : établissement, réf., médecin, sage-femme, enfant, mère ; acte : année, registre, feuillet, n°, région, préfecture, commune, centre, parents, déclarant, mentions). Liste exacte à confirmer | `declarations/models.py`, `actes/models.py` |
| 21 | **Valeurs par défaut géographiques** | Région / préfecture : Conakry, commune : Ratoma, centre : « Centre d'état civil de Ratoma » — à confirmer | écran Paramètres |
| 22 | **Réinitialisation de mot de passe** | Par l'administrateur (mot de passe temporaire). Pas d'envoi d'e-mail | — |

## Code des établissements de santé

- Format automatique **WH-0001-26** : `WH` (Wakara Hôpital), numéro d'ordre sur 4 chiffres, année sur 2 chiffres.
- **Décision prise (à valider)** : la numérotation **repart à 0001 chaque année** (WH-0001-27 en 2027). Si la mairie préfère un numéro continu d'une année à l'autre, il suffit de ne plus remettre le compteur à zéro (une ligne dans `hospitals/services.py`).
- Le code est attribué à la création, ne se saisit ni ne se modifie. Les établissements créés avant cette règle gardent leur ancien code.

## Modification des dossiers et file de validation

- Le **secrétariat** (permission « Compléter un acte ») peut corriger les données d'une déclaration dès qu'elle est **transmise**, et pendant le complément. La modification ne change pas le statut du dossier.
- Quand le secrétariat a fini, il **soumet à validation** : le dossier passe dans la **file de validation** de l'administrateur et le secrétariat ne peut plus le modifier.
- L'**administrateur** peut travailler sur un dossier en attente de validation (déclaration et acte) : il **reste dans sa file de validation** jusqu'à la décision (valider, retourner ou rejeter). Après validation, plus personne ne modifie.
- Pastilles du menu : *File du secrétariat* (dossiers transmis, en complément ou à corriger côté secrétariat), *File de validation* (en attente de décision), *Déclarations* (pour l'agent : brouillons et dossiers retournés), *Actes de naissance* (actes validés à délivrer). Les écrans et les pastilles se rafraîchissent toutes les 30 secondes tant que la session est ouverte et l'onglet visible.

## Traitement par le secrétariat, date en lettres, déclarant

- Quand le secrétariat a traité un dossier transmis (enregistrement + **« Envoyer à la validation de l'administrateur »**), le statut passe **directement** de *Transmis au secrétariat* à **En attente de validation** : le dossier quitte la file du secrétariat et entre dans la **file de validation** de l'administrateur. L'étape « Prendre en charge » reste possible mais n'est plus obligatoire.
- Si la **date de déclaration** de l'acte n'a pas été saisie, elle est fixée au **jour de l'envoi** à la validation ; l'administrateur peut la corriger sur l'acte avant sa décision. *À confirmer avec la mairie.*
- La **date de naissance** reste un sélecteur de date ; elle est **affichée en lettres** (« le vingt-huit octobre deux mille vingt-six ») en direct dans le formulaire, sur la fiche du dossier et sur l'acte. La valeur enregistrée reste une date.
- Enfant : **nationalité** et **rang de naissance chez la mère** ajoutés. Père et mère : **date et lieu de naissance**, nationalité, profession.
- Déclarant : choix **le père / la mère / une autre personne**. Pour le père ou la mère, leurs informations sont reprises automatiquement (nom, profession, domicile, téléphone, lien) ; seules la pièce d'identité et son numéro restent à saisir.

## Saisie du formulaire : majuscules, téléphone, nationalités

- **Majuscules** : les informations saisies (noms, prénoms, lieux, professions, adresses, observations…) **s'affichent en majuscules** dans le formulaire, la fiche du dossier, les listes et le modèle d'acte. C'est un affichage seulement : la **valeur enregistrée n'est pas modifiée** (la recherche ignore la casse, l'historique d'audit garde ce qui a été saisi, les exports CSV et les anciens dossiers restent tels quels). *Décision à valider : si la mairie veut des majuscules aussi en base, il suffit de normaliser dans `declarations/serializers.py`.* Les e-mails, mots de passe et valeurs techniques ne sont jamais passés en majuscules.
- **Téléphone** : saisie guidée au format **+224 624 62 94 77** (clavier numérique sur mobile). Sans indicatif, le numéro est pris pour un numéro guinéen ; un numéro étranger se saisit avec son indicatif (« +33… »). L'API **refuse** un numéro mal formé (lettres, numéro guinéen qui n'a pas 9 chiffres, 8 à 15 chiffres pour l'étranger) et enregistre le format normalisé. Le téléphone reste facultatif.
- **E-mail** : le formulaire de déclaration n'a pas de champ e-mail ; les e-mails existants (utilisateurs, établissements) sont validés par l'API et saisis avec `type="email"`.
- **Nombres** : âge (0 à 120) et rang de naissance (1 à 30) en saisie numérique, bornés aussi côté API ; une date de naissance de parent ne peut pas être dans le futur.
- **Nationalité** du père, de la mère **et du déclarant** (nouveau champ), choisie dans une liste de tous les pays du monde (nationalité en français, ex. « Guinéenne ») ; la saisie libre reste possible pour les anciens dossiers. Aucune valeur par défaut : le champ reste vide tant qu'il n'est pas renseigné (la nationalité de l'enfant n'avait pas de défaut non plus). Elle figure dans l'acte (parents et déclarant). Pour un déclarant « père » ou « mère », la nationalité est reprise du parent.
- **Âge des parents** : calculé automatiquement à partir de la date de naissance (années révolues à aujourd'hui) dès qu'elle est saisie ; le champ reste modifiable, et une nouvelle date de naissance le recalcule.
- **NPI** : champ libre (50 caractères) pour l'enfant, le père, la mère et le déclarant ; aucun contrôle de format tant que la mairie n'a pas défini la règle.
- **Validation définitive avec champs vides** : l'administrateur est averti (liste des champs de `VALIDATION_EXPECTED_FIELDS`) et peut confirmer ; sans confirmation rien n'est écrit (pas de numéro consommé). Avec confirmation, les champs manquants sont notés dans l'historique et le journal d'audit.
- **Actes de naissance** : la liste ne montre que les actes validés définitivement et les actes délivrés (qui ont été validés) ; un dossier en cours se traite depuis la file du secrétariat.
- **Secrétaire et établissements** : il peut créer, modifier, désactiver, archiver et restaurer (permissions `hospital.create`, `hospital.update`, `hospital.archive`). Les installations existantes les reçoivent par la migration `accounts/0003` ; l'administrateur peut les retirer ensuite dans « Rôles et permissions ».
- **Tableau de bord et statistiques** réunis : un seul écran avec les filtres ; `/statistics` redirige vers `/dashboard`.
- **Établissements préremplis (Ratoma)** : 7 structures dont le nom et la commune sont documentés (CMC de Ratoma, CMC Les Flamboyants, Hôpital de l'Amitié Sino-Guinéenne à Kipé, Hôpital Jean-Paul II, Clinique Aimé, centres de santé de Wanindara et de Lambanyi), créées **une seule fois** (marqueur `bootstrap.ratoma_hospitals`) par `setup_initial_data`, ou à la demande par `manage.py seed_hospitals`. Aucun téléphone, adresse de rue ou contact n'est inventé. **La mairie doit valider la liste** (ajouter, renommer, désactiver) ; un établissement archivé n'est jamais recréé. Écartés faute de source sûre : « Centre Mère-Enfant », « FMG » ; Clinique Ambroise Paré est à Dixinn, pas à Ratoma.
- **Chiffres du tableau de bord cliquables** : chaque carte ouvre la liste correspondante avec la période, l'établissement, le responsable et les statuts du tableau de bord (paramètres d'URL `from`, `to`, `hospital`, `agent`, `statuses`), pour que le nombre de la carte et celui de la liste soient identiques.
- **Délivrances** : vue détaillée (acte, parcours, impressions, autres remises) pour tous ceux qui voient les actes ; l'administrateur (permission `audit.view`) voit en plus le validateur, les copies imprimées et le journal d'audit.
- **Historiques des actes** : page réservée à la permission `audit.view` (administrateur par défaut). Elle ne crée aucune donnée : elle relit le journal d'audit (déclaration, acte, pièces jointes) et l'écrit en phrases lisibles — qui a créé, modifié (champ par champ, avant/après), transmis, pris en charge, validé, numéroté, imprimé, délivré, ajouté ou consulté une pièce. Le rôle affiché est le rôle **actuel** de la personne. Les événements d'un dossier sont ceux de sa déclaration, de son acte et de ses pièces ; les connexions et exports n'en font pas partie.
