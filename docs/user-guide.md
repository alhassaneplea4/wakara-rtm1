# Guide utilisateur par rôle

Connexion : identifiant (ou e-mail) + mot de passe. À la première connexion, ou après une réinitialisation par
l'administrateur, un nouveau mot de passe est exigé. En cas d'oubli, contactez l'administrateur technique.
La cloche indique les dossiers qui attendent votre action.

## Agent de collecte

1. **Déclarations → Nouvelle déclaration** : saisissez le formulaire reçu de l'hôpital (établissement, enfant, père,
   mère). Seule la date de naissance est exigée pour un brouillon.
2. **Enregistrer le brouillon** pour continuer plus tard, ou **Enregistrer et transmettre** : la transmission vérifie
   les informations minimales (date de naissance, sexe, nom de l'enfant, nom de la mère).
3. **Fiche de déclaration physique** : en haut du formulaire, **Prendre une photo** (sur téléphone, ouvre l'appareil photo)
   ou **Importer un fichier** (sur ordinateur, choisissez une image ou un PDF). Vous pouvez joindre plusieurs pages ; les
   photos sont enregistrées avec le dossier et restent visibles sur sa fiche (clic pour agrandir, **Retirer** tant que le
   dossier est modifiable). Formats : JPG, PNG ou PDF, 10 Mo max (les grosses photos sont réduites automatiquement).
   Les autres pièces (identités, etc.) s'ajoutent depuis la fiche du dossier.
4. Si le dossier vous est retourné (**À corriger — collecte**), le motif est affiché : corrigez puis retransmettez.

Vous ne voyez que vos propres déclarations. Vous ne pouvez plus modifier un dossier transmis.

## Secrétaire d'état civil

1. **Déclarations** (une seule page, pastille = dossiers à traiter) : ouvrez un dossier *Transmis*. La fiche n'offre que
   **Modifier** et **Aperçu de l'acte**.
2. **Modifier** : le formulaire commence par l'en-tête du registre (année, registre, feuillet, N° officiel, libre), la circonscription, la date de déclaration, l'officier d'état civil (pré-rempli) et les mentions ; vient
   ensuite la déclaration (enfant, **père obligatoire**, mère, déclarant).
3. **Enregistrer et envoyer à la validation de l'administrateur** : possible seulement si **tous les champs sont
   renseignés, sauf le NPI** ; les champs manquants sont marqués en rouge. **Enregistrer les modifications** garde la
   saisie en cours sans envoyer le dossier.
4. Après validation : **Aperçu de l'acte → Imprimer** (l'impression est enregistrée), puis **Enregistrer la délivrance**
   (nom du bénéficiaire, qualité, pièce). Une nouvelle délivrance est marquée *Duplicata*.

Vous ne pouvez ni valider ni rejeter.

## Administrateur technique Wakara

- **File de validation** → ouvrez le dossier : la zone *Décision finale* propose **Valider définitivement**
  (saisie/confirmation du numéro officiel), **Retourner à la collecte / au secrétariat** ou **Rejeter** — un motif est obligatoire
  pour les retours et rejets. Si des champs attendus sont encore vides, la validation définitive **avertit** et liste ces champs : on peut revenir compléter le dossier ou **valider quand même** (les champs manquants sont alors notés dans l'historique). Un dossier validé ou rejeté est figé.
- **Utilisateurs** : création, rôles, ajustements de permissions, désactivation, mot de passe temporaire. Vous ne pouvez pas
  modifier votre propre compte (rôles, permissions, statut).
- **Rôles et permissions** : cochez les permissions de chaque rôle ; chaque changement est tracé.
- **Historiques des actes** (menu, juste après « Rôles et permissions » ; réservé à l'administrateur) : un dossier par ligne avec sa dernière activité (quoi, par qui, quand) et son nombre d'événements. Recherche par référence, n° d'acte, enfant, parent, bénéficiaire de la remise ou agent ; filtres par statut, personne, type d'action (créations, modifications, circuit, numérotation, impressions, délivrances, pièces, archivage), établissement et dates. Un clic ouvre **toute l'histoire du dossier** : où il en est, les étapes clés (qui, quand), les personnes intervenues avec leur rôle, puis la chronologie complète jour par jour, avec pour chaque modification l'**ancienne et la nouvelle valeur**, le motif, l'adresse IP et un export CSV.
- **Hôpitaux et maternités** : création, modification, désactivation (un établissement utilisé n'est jamais supprimé). Le secrétaire peut aussi les gérer (création, modification, archivage et restauration). Les établissements de la commune de Ratoma documentés par des sources publiques sont **préremplis une seule fois** au premier déploiement ; la liste est à valider par la mairie (voir `backend/hospitals/ratoma.py`).
- **Tableau de bord** (statistiques comprises) : période (cette année, ce mois, cette semaine, aujourd'hui, deux années précédentes), établissement, statut, responsable et intervalle « Du / Au » ; la page « Statistiques » n'existe plus. **Chaque carte de chiffres est cliquable** : elle ouvre la liste (déclarations ou actes) avec la même période, les mêmes filtres et les mêmes statuts, donc le même nombre ; le bandeau « Sélection du tableau de bord » permet de la retirer.
- **Délivrances** : cliquez une ligne pour ouvrir le détail (remise, acte, qui a fait quoi, parcours du dossier, autres remises du même acte) ; filtres par type, établissement et dates, compteurs en tête. L'administrateur voit en plus la colonne « Validé par », le nombre de copies imprimées et le journal d'audit du dossier (adresse IP, motifs). **Journal d'activité** : filtres et export CSV
  (consultation et export sont eux-mêmes journalisés). **Paramètres** : textes de la page de connexion.

## Important

- Un document n'a de valeur qu'**après validation définitive** ; avant, l'aperçu porte la mention *ACTE NON VALIDE*.
- L'aperçu de l'acte est **en lecture seule** et reprend la présentation de la fiche de l'état civil (volet n° 1, déclarant) : en-tête (année, registre, feuillet, n° de l'acte), puis les rubriques ENFANT, PARENTS (père, mère) et DÉCLARANT. Les cases que le dossier ne renseigne pas (commune urbaine/rurale, centre principal/secondaire, situation matrimoniale) restent vides et se cochent à la main après impression. Le modèle imprimé reste un modèle de travail, en attente de validation par la mairie.
