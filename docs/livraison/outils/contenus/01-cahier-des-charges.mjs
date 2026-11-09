import { h1, h2, h3, p, ul, ol, table, note, img } from '../dsl.mjs';
import { META } from '../meta.mjs';

export default {
  title: 'Cahier des charges fonctionnel et technique',
  subtitle: 'Ce qui a été demandé : objectifs, fonctionnalités, contraintes et technologies retenues',
  audience: 'Document de référence',
  blocks: [
    h1('Contexte et objet du document'),
    p(`La ${META.clientCourt}, par son Centre d'état civil et de l'identification (CECI Ratoma), reçoit des hôpitaux, maternités et centres de santé de la commune les déclarations de naissance, puis établit les actes de naissance. Ce travail repose sur des formulaires papier, qu'il faut saisir, compléter, contrôler, numéroter, imprimer et remettre aux familles.`),
    p('**Wakara** est la plateforme web qui accompagne ce travail de bout en bout : de la saisie de la déclaration reçue de l\'hôpital jusqu\'à la remise de l\'acte, avec un contrôle à chaque étape et une trace de toutes les opérations.'),
    p('Ce cahier des charges est le **document de référence** du projet. Il décrit les besoins exprimés, le périmètre de la première version, les règles de fonctionnement, les contraintes et les technologies retenues. Les critères d\'acceptation se vérifient dans le procès-verbal de recette (document 06).'),

    h1('Objectifs du projet'),
    ol([
      '**Fiabiliser l\'enregistrement** des naissances : informations saisies une seule fois, contrôlées, complétées par le secrétariat, puis validées.',
      '**Organiser le circuit de traitement** entre l\'agent de collecte, le secrétariat d\'état civil et l\'administrateur technique, avec des rôles clairs.',
      '**Garantir la traçabilité** : savoir à tout moment qui a créé, modifié, validé, imprimé ou délivré quoi, et quand.',
      '**Protéger les données personnelles** des enfants et des parents : accès par profil, aucune suppression, journal d\'audit.',
      '**Produire l\'acte de naissance** au format de la fiche officielle de l\'état civil, avec numérotation du registre et suivi des délivrances.',
      '**Piloter l\'activité** : statistiques par période, par établissement et par statut, avec des chiffres vérifiables dossier par dossier.',
    ]),

    h1('Périmètre'),
    h2('Inclus dans la version 1.0'),
    ul([
      'Saisie des déclarations de naissance par les agents de collecte, avec photo ou scan de la fiche physique.',
      'Circuit de traitement : brouillon, transmission, prise en charge, complément de l\'acte, validation, retour pour correction, rejet, délivrance.',
      'Gestion de l\'acte : références du registre, numéro officiel, aperçu et impression au format de la fiche officielle, délivrances et duplicata.',
      'Gestion des établissements de santé de la commune.',
      'Gestion des utilisateurs, des rôles et des permissions.',
      'Tableau de bord et statistiques.',
      'Journal d\'activité, historiques par dossier, exports.',
      'Paramétrage des textes de la page de connexion et des valeurs par défaut des actes.',
    ]),
    h2('Hors périmètre de la version 1.0'),
    ul([
      'Travail hors connexion.',
      'Signature électronique de l\'acte.',
      'Réinitialisation du mot de passe par e-mail (l\'administrateur remet un mot de passe temporaire).',
      'Génération d\'un fichier PDF de l\'acte par le serveur (l\'acte est rendu en page imprimable).',
      'Rectification ou mention marginale après validation d\'un acte (procédure à définir par la mairie).',
      'Autres actes d\'état civil (mariage, décès) et interconnexion avec d\'autres systèmes nationaux.',
    ]),

    h1('Acteurs et profils'),
    table({
      head: ['Profil', 'Rôle dans l\'organisation', 'Ce qu\'il fait dans Wakara', 'Ce qu\'il ne peut pas faire'],
      widths: [2, 2.4, 3.4, 2.4], small: true,
      rows: [
        ['**Agent de collecte**', 'Recueille les déclarations des hôpitaux et maternités', 'Crée, modifie (tant que c\'est un brouillon ou à corriger) et transmet ses déclarations ; joint la fiche physique', 'Voir les dossiers des autres ; valider ; imprimer ; délivrer'],
        ['**Secrétaire d\'état civil**', 'Complète les dossiers et prépare l\'acte', 'Prend en charge, corrige les informations, complète l\'acte, soumet à validation ; imprime et délivre les actes validés ; gère les établissements', 'Valider ou rejeter un dossier'],
        ['**Administrateur technique**', 'Contrôle et décide', 'Valide définitivement (numéro officiel), retourne ou rejette ; gère utilisateurs, rôles, permissions, paramètres ; consulte statistiques, historiques et journaux', 'Modifier son propre compte, rôles et permissions ; supprimer quoi que ce soit'],
      ],
    }),
    p('Les droits de chaque profil sont **granulaires** (32 permissions) et ajustables par l\'administrateur, rôle par rôle ou utilisateur par utilisateur.'),

    h1('Circuit d\'un dossier'),
    img('schema-circuit.png', 'Circuit d\'un dossier : qui agit à chaque étape, et les retours possibles', 100),
    p('Les statuts, les retours et les rejets sont des **propositions de travail** à confirmer par la mairie (voir le chapitre « Points à valider »). Le circuit est appliqué par le serveur : aucun écran ne peut le contourner.'),

    h1('Exigences fonctionnelles'),
    p('Chaque exigence a un identifiant (EF) repris dans les tests et la recette. La colonne « État » indique si elle est livrée dans la version 1.0.'),
    h2('Accès et comptes'),
    table({
      head: ['Réf.', 'Exigence', 'État'], widths: [0.9, 8, 1.1], small: true,
      rows: [
        ['EF-01', 'Connexion par identifiant (ou adresse e-mail) et mot de passe ; option « se souvenir de moi ».', 'Livré'],
        ['EF-02', 'Changement du mot de passe obligatoire à la première connexion et après une réinitialisation par l\'administrateur.', 'Livré'],
        ['EF-03', 'Verrouillage temporaire du compte après plusieurs échecs de connexion ; message d\'erreur qui ne révèle pas l\'existence du compte.', 'Livré'],
        ['EF-04', 'Gestion des utilisateurs : création, modification, activation et désactivation (jamais de suppression), mot de passe temporaire.', 'Livré'],
        ['EF-05', 'Gestion des rôles et des permissions ; ajustements par utilisateur ; l\'administrateur ne peut pas modifier son propre compte.', 'Livré'],
      ],
    }),
    h2('Déclarations de naissance'),
    table({
      head: ['Réf.', 'Exigence', 'État'], widths: [0.9, 8, 1.1], small: true,
      rows: [
        ['EF-10', 'Création d\'une déclaration : établissement, référence hospitalière, médecin, sage-femme, enfant, père, mère. Seule la date de naissance est exigée pour un brouillon.', 'Livré'],
        ['EF-11', 'Saisie guidée : informations affichées en majuscules, téléphone au format +224 624 62 94 77, nationalité choisie dans la liste des pays, âge des parents calculé à partir de la date de naissance, NPI.', 'Livré'],
        ['EF-12', 'Photo ou fichier de la fiche de déclaration physique, jointe au dossier (JPG, PNG ou PDF).', 'Livré'],
        ['EF-13', 'Enregistrement en brouillon, puis transmission au secrétariat après contrôle des informations minimales.', 'Livré'],
        ['EF-14', 'Référence de suivi unique générée par le serveur (WKR-AAAA-NNNN).', 'Livré'],
        ['EF-15', 'L\'agent ne voit que ses déclarations ; le secrétariat et l\'administrateur voient toutes les déclarations.', 'Livré'],
      ],
    }),
    h2('Traitement, validation et acte'),
    table({
      head: ['Réf.', 'Exigence', 'État'], widths: [0.9, 8, 1.1], small: true,
      rows: [
        ['EF-20', 'File du secrétariat : dossiers transmis, en complément ou à corriger côté secrétariat ; prise en charge facultative.', 'Livré'],
        ['EF-21', 'Complément de l\'acte : année, registre, feuillet, commune, centre, date de déclaration, mentions ; correction des informations de la déclaration ; déclarant (père, mère ou autre personne).', 'Livré'],
        ['EF-22', 'Soumission à validation après contrôle des informations requises.', 'Livré'],
        ['EF-23', 'Validation définitive réservée à l\'administrateur technique, avec numéro officiel ; avertissement lorsque des champs attendus sont vides.', 'Livré'],
        ['EF-24', 'Retour à la collecte ou au secrétariat, ou rejet, avec motif obligatoire ; dossier validé ou rejeté figé.', 'Livré'],
        ['EF-25', 'Numérotation officielle unique par année et registre ; saisie manuelle par défaut, numérotation automatique disponible mais désactivée.', 'Livré'],
        ['EF-26', 'Aperçu de l\'acte en lecture seule, calqué sur la fiche officielle (en-tête de registre, enfant, parents, déclarant) ; filigrane « ACTE NON VALIDE » tant que l\'acte n\'est pas validé.', 'Livré'],
        ['EF-27', 'Impression de l\'acte après validation, chaque impression étant enregistrée ; délivrance enregistrée (bénéficiaire, pièce d\'identité) ; seconde délivrance marquée duplicata.', 'Livré'],
        ['EF-28', 'Liste des délivrances avec filtres, compteurs et détail ; informations supplémentaires pour l\'administrateur.', 'Livré'],
      ],
    }),
    h2('Pilotage, traçabilité et paramétrage'),
    table({
      head: ['Réf.', 'Exigence', 'État'], widths: [0.9, 8, 1.1], small: true,
      rows: [
        ['EF-30', 'Gestion des établissements de santé : création, modification, désactivation, archivage, restauration ; code automatique ; établissements de Ratoma préremplis.', 'Livré'],
        ['EF-31', 'Tableau de bord : période (année, mois, semaine, jour), établissement, statut, responsable ; cartes de chiffres cliquables qui ouvrent la liste correspondante ; graphiques.', 'Livré'],
        ['EF-32', 'Journal d\'activité en ajout seul, filtrable et exportable en CSV ; consultation et export eux-mêmes tracés.', 'Livré'],
        ['EF-33', 'Historiques des actes (administrateur) : pour chaque dossier, qui a fait quoi et quand, avec l\'ancienne et la nouvelle valeur de chaque modification.', 'Livré'],
        ['EF-34', 'Notifications par pastilles dans le menu selon le travail en attente de chaque profil ; actualisation automatique.', 'Livré'],
        ['EF-35', 'Paramètres : textes de la page de connexion et valeurs par défaut des actes.', 'Livré'],
        ['EF-36', 'Aucune suppression physique : archivage et désactivation uniquement.', 'Livré'],
      ],
    }),

    h1('Règles de gestion principales'),
    table({
      head: ['Réf.', 'Règle'], widths: [0.9, 9.1], small: true,
      rows: [
        ['RG-01', 'Une déclaration concerne **un enfant** ; une naissance multiple donne plusieurs déclarations.'],
        ['RG-02', 'Brouillon : date de naissance seule. Transmission : date de naissance, sexe, nom de l\'enfant, nom de la mère. Soumission de l\'acte : date de déclaration, nom du déclarant.'],
        ['RG-03', 'Seul l\'administrateur technique valide, retourne ou rejette ; un motif est obligatoire pour les retours et rejets.'],
        ['RG-04', 'Un dossier **validé, rejeté ou délivré est figé** : plus aucune modification.'],
        ['RG-05', 'Le numéro officiel est unique par année et par registre ; une fois attribué, il n\'est jamais écrasé.'],
        ['RG-06', 'L\'impression et la délivrance ne sont possibles qu\'après validation définitive ; seuls le secrétaire et l\'administrateur les réalisent.'],
        ['RG-07', 'Aucune donnée n\'est supprimée : les éléments sont archivés ou désactivés, et le journal d\'audit ne peut être ni modifié ni effacé.'],
        ['RG-08', 'Un établissement utilisé par des dossiers ne peut qu\'être désactivé ou archivé.'],
        ['RG-09', 'Le droit d\'agir est vérifié **par le serveur** à chaque requête ; l\'interface ne fait qu\'afficher ce qui est permis.'],
        ['RG-10', 'Le code d\'un établissement suit le format WH-0001-26 (numéro d\'ordre, année sur deux chiffres) et repart à 0001 chaque année.'],
      ],
    }),

    h1('Exigences non fonctionnelles'),
    table({
      head: ['Domaine', 'Exigence'], widths: [2, 8], small: true,
      rows: [
        ['Sécurité', 'Authentification par jetons à durée limitée ; mots de passe contrôlés ; permissions vérifiées côté serveur avec refus par défaut ; HTTPS imposé en production ; pièces justificatives en stockage privé, accessibles seulement après connexion ; aucun secret dans le code.'],
        ['Traçabilité', 'Toute création, modification, décision, impression, délivrance, consultation de pièce ou export est inscrit au journal avec l\'auteur, l\'heure et l\'adresse IP.'],
        ['Données personnelles', 'Accès limité selon le profil ; données de démonstration fictives pour les formations et la recette ; hébergement et durée de conservation à arrêter par la mairie.'],
        ['Disponibilité et sauvegarde', 'Sauvegarde de la base et des pièces ; commandes de sauvegarde et de restauration fournies ; procédure en cas de panne documentée.'],
        ['Ergonomie', 'Interface en français, simple, conçue pour ordinateur et pour écrans étroits (téléphone) ; messages d\'erreur compréhensibles.'],
        ['Compatibilité', 'Navigateurs récents ; aucun logiciel à installer sur le poste. Vérifié avec Microsoft Edge et Google Chrome ; Firefox et Safari non vérifiés.'],
        ['Performance', 'Listes paginées, chargement différé des écrans ; aucune mesure de charge n\'a été réalisée (voir le rapport de tests).'],
        ['Maintenabilité', 'Code organisé par domaine métier, tests automatisés, migrations de base versionnées, documentation fournie.'],
      ],
    }),

    h1('Technologies retenues'),
    table({
      head: ['Couche', 'Technologie', 'Justification'], widths: [2, 3.4, 4.6], small: true,
      rows: [
        ['Interface', 'Angular 17, TypeScript, Chart.js', 'Application web monopage, composants réutilisables, typage strict'],
        ['API', 'Python 3.12+, Django 5.2, Django REST Framework', 'Cadre éprouvé, administration des modèles, écosystème de sécurité'],
        ['Authentification', 'JSON Web Tokens (SimpleJWT) avec rotation et liste noire', 'Sessions sans état, révocation à la déconnexion'],
        ['Base de données', 'PostgreSQL (SQLite en développement)', 'Fiabilité transactionnelle, verrous pour la numérotation'],
        ['Hébergement actuel', 'Vercel (interface et API) et Neon (PostgreSQL)', 'Mise en ligne rapide à coût nul ; hébergement à confirmer par la mairie'],
        ['Documentation de l\'API', 'OpenAPI (drf-spectacular)', 'Disponible en développement, désactivée en production'],
      ],
    }),

    h1('Contraintes'),
    ul([
      '**Aucune règle administrative n\'est inventée** : toute hypothèse de travail est implémentée de façon paramétrable et soumise à validation.',
      '**Hébergement non arrêté** : la mairie doit choisir le lieu d\'hébergement (local, national ou international) en tenant compte des contraintes guinéennes de conservation des données.',
      '**Modèle d\'acte** : le modèle imprimé est un modèle de travail calqué sur la fiche officielle ; il doit être approuvé par l\'autorité compétente.',
      '**Offre gratuite actuelle** : la base Neon gratuite est limitée en volume (0,5 Go) ; les pièces justificatives y sont stockées.',
      '**Taille des envois** : 4 Mo par fichier sur l\'hébergement actuel (les photos sont réduites automatiquement).',
    ]),

    h1('Points à valider par la mairie'),
    p('Ces décisions conditionnent la mise en exploitation réelle. Elles sont détaillées dans le dossier technique et dans le fichier `docs/business-decisions.md` du dépôt.'),
    table({
      head: ['N°', 'Sujet', 'Hypothèse actuelle', 'À confirmer'], widths: [0.6, 2.2, 4.6, 2.6], small: true,
      rows: [
        ['1', 'Numérotation officielle des actes', 'Numéro saisi par l\'administrateur à la validation ; unicité par année et registre', 'Règle officielle de numérotation'],
        ['2', 'Champs obligatoires', 'Minimum à la transmission et à la soumission (RG-02)', 'Liste exacte des champs'],
        ['3', 'Statuts et circuit de retour', 'Neuf statuts, retour à la collecte ou au secrétariat', 'Circuit réel de la mairie'],
        ['4', 'Modèle officiel de l\'acte', 'Modèle de travail calqué sur la fiche papier, filigrane avant validation', 'Approbation du modèle, signatures et mentions'],
        ['5', 'Corrections après validation', 'Non prévues : dossier figé', 'Procédure de rectification'],
        ['6', 'Naissances multiples, père inconnu, déclaration tardive', 'Une déclaration par enfant ; père facultatif ; aucun délai codé', 'Règles applicables'],
        ['7', 'Conservation des données et du journal', 'Illimitée, sans purge', 'Durées légales'],
        ['8', 'Hébergement et lieu de stockage', 'Vercel et Neon (hébergement de démarrage)', 'Choix définitif'],
        ['9', 'Établissements préremplis', 'Sept structures de Ratoma documentées par des sources publiques', 'Validation de la liste'],
        ['10', 'Valeurs par défaut géographiques', 'Région et préfecture : Conakry ; commune : Ratoma ; centre : Centre d\'état civil de Ratoma', 'Libellés officiels'],
      ],
    }),

    h1('Livrables'),
    ul([
      'La plateforme Wakara déployée et fonctionnelle.',
      'Le code source complet et son historique.',
      'Le dossier de documentation : cahier des charges, dossier technique, manuel utilisateur, guide d\'installation et d\'exploitation, rapport de tests, procès-verbal de recette, procès-verbal de livraison.',
      'La formation des utilisateurs par profil.',
    ]),
  ],
};
