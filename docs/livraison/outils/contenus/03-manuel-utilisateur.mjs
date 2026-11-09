import { h1, h2, h3, p, ul, ol, table, note, img } from '../dsl.mjs';
import { META } from '../meta.mjs';

export default {
  title: 'Manuel d\'utilisation',
  subtitle: 'Guide pas à pas pour les agents de collecte, le secrétariat et l\'administrateur technique',
  audience: 'Agents, secrétaires et administrateurs',
  blocks: [
    h1('Avant de commencer'),
    p(`Wakara est l'outil de la ${META.clientCourt} pour enregistrer les naissances et préparer les actes. Ce manuel explique, **profil par profil**, ce qu'il faut faire à chaque étape. Allez directement au chapitre qui vous concerne :`),
    table({
      head: ['Votre profil', 'Chapitre'], widths: [6, 4], zebra: false,
      rows: [
        ['**Agent de collecte** — vous recevez les déclarations des hôpitaux et les saisissez', '2'],
        ['**Secrétaire d\'état civil** — vous complétez les dossiers, préparez l\'acte, imprimez et délivrez', '3'],
        ['**Administrateur technique** — vous validez, gérez les comptes, les droits et suivez l\'activité', '4'],
      ],
    }),
    note('Les captures d\'écran de ce manuel utilisent des **données fictives** (noms et dossiers inventés).', 'info'),

    h2('Se connecter'),
    img('login.jpg', 'Page de connexion', 80),
    ol([
      `Ouvrez le navigateur (Edge, Chrome…) et allez à l'adresse **${META.url}**.`,
      'Saisissez votre **identifiant** (ou votre adresse e-mail) et votre **mot de passe**.',
      'Cliquez sur **Se connecter**. Cochez « Se souvenir de moi » seulement sur votre ordinateur personnel.',
      '**À la première connexion**, ou après une réinitialisation par l\'administrateur, l\'application vous demande de choisir un nouveau mot de passe : il doit être long et difficile à deviner. Vous ne pouvez rien faire d\'autre avant de l\'avoir changé.',
    ]),
    note('Après plusieurs mots de passe erronés, le compte est **bloqué 15 minutes**. Le message d\'erreur est le même que le compte existe ou non. Mot de passe oublié : contactez l\'administrateur technique.', 'warn'),

    h2('Se repérer dans l\'écran'),
    ul([
      '**Menu à gauche** : il ne propose que ce que votre profil a le droit de faire. Les **pastilles rouges** indiquent le nombre de dossiers qui attendent votre action.',
      '**Barre du haut** : recherche d\'un dossier (référence, nom), **cloche** de notifications et votre nom avec votre profil.',
      '**Mon profil** et **Déconnexion** : en bas du menu. Déconnectez-vous toujours en quittant le poste.',
      'Les informations s\'affichent **en majuscules** ; c\'est seulement une question d\'affichage.',
    ]),
    h2('Les statuts d\'un dossier'),
    table({
      head: ['Statut', 'Signification', 'Qui agit ensuite'], widths: [2.6, 4.6, 2.8], small: true,
      rows: [
        ['Brouillon', 'Saisie commencée, pas encore envoyée', 'Agent de collecte'],
        ['Transmis au secrétariat', 'Envoyé par l\'agent, en attente de traitement', 'Secrétariat'],
        ['En complément', 'Le secrétariat travaille sur le dossier et l\'acte', 'Secrétariat'],
        ['En attente de validation', 'Le secrétariat a terminé, le dossier attend la décision', 'Administrateur'],
        ['À corriger — collecte', 'Retourné à l\'agent avec un motif', 'Agent de collecte'],
        ['À corriger — secrétariat', 'Retourné au secrétariat avec un motif', 'Secrétariat'],
        ['Validé définitivement', 'Acte validé, numéro officiel attribué, dossier figé', 'Secrétariat (impression, délivrance)'],
        ['Acte délivré', 'L\'acte a été remis à un bénéficiaire', 'Dossier clos'],
        ['Rejeté', 'Dossier refusé, avec motif ; clos', '—'],
      ],
    }),

    // ───────────────────────── AGENT ─────────────────────────
    h1('Profil 1 — Agent de collecte'),
    p('Vous recevez la fiche de déclaration de l\'hôpital ou de la maternité. Votre travail : la saisir dans Wakara et l\'envoyer au secrétariat. **Vous ne voyez que vos propres déclarations.**'),

    h2('Consulter vos déclarations'),
    img('agent-declarations.jpg', 'Liste des déclarations de l\'agent de collecte', 90),
    p('Le menu **Déclarations** affiche vos dossiers, du plus récent au plus ancien. Utilisez la recherche (référence, nom de l\'enfant), les filtres de statut, d\'établissement et de dates, puis **Filtrer**. Cliquez sur une **référence** (WKR-AAAA-NNNN) pour ouvrir le dossier.'),

    h2('Enregistrer une déclaration'),
    img('agent-nouvelle.jpg', 'Formulaire de nouvelle déclaration de naissance', 90),
    ol([
      'Cliquez sur **Nouvelle déclaration** (en haut à droite de la liste).',
      '**Fiche de déclaration physique** : cliquez sur **Prendre une photo** (sur téléphone, ouvre l\'appareil photo) ou **Importer un fichier** (sur ordinateur : image ou PDF). Vous pouvez joindre plusieurs pages. La fiche reste jointe au dossier.',
      '**Établissement de santé** : choisissez l\'établissement dans la liste, puis notez la référence du document hospitalier, le médecin et la sage-femme.',
      '**Enfant** : prénoms, nom, sexe, nationalité, NPI, **date de naissance** (obligatoire), heure, lieu et rang de naissance chez la mère. La date apparaît aussi en lettres sous le champ.',
      '**Père** et **Mère** : prénoms, nom, date et lieu de naissance (l\'**âge est calculé tout seul**), profession, nationalité, NPI, téléphone, domicile. Décochez « Renseigner le père » si le père n\'est pas connu.',
      'Plus bas, renseignez le **déclarant** (le père, la mère ou une autre personne) : s\'il s\'agit du père ou de la mère, ses informations sont reprises automatiquement.',
    ]),
    note('**Aides à la saisie.** Le téléphone se saisit comme **+224 624 62 94 77** (sans indicatif, un numéro guinéen est supposé ; un numéro étranger se saisit avec son indicatif). La nationalité se choisit dans la liste des pays. Une date de naissance de parent dans le futur est refusée.', 'info'),

    h2('Enregistrer un brouillon et le modifier plus tard'),
    ol([
      'En bas de l\'écran, cliquez sur **Enregistrer le brouillon** : seule la date de naissance est exigée.',
      'Le dossier reçoit sa **référence** (WKR-AAAA-NNNN) et reste modifiable.',
      'Pour le reprendre : **Déclarations** → cliquez sur la référence → **Modifier**.',
    ]),

    h2('Transmettre une déclaration au secrétariat'),
    img('agent-brouillon.jpg', 'Dossier en brouillon : le bouton « Transmettre au secrétariat »', 90),
    ol([
      'Ouvrez le dossier en brouillon et vérifiez-le.',
      'Cliquez sur **Transmettre au secrétariat** (ou, dans le formulaire, sur **Enregistrer et transmettre au secrétariat**).',
      'Wakara vérifie que les **informations minimales** sont présentes : date de naissance, sexe et nom de l\'enfant, nom de la mère. Sinon, un message vous dit ce qui manque : complétez puis recommencez.',
      'Le statut devient **Transmis au secrétariat**. Vous ne pouvez plus modifier le dossier.',
    ]),

    h2('Traiter un dossier retourné'),
    ol([
      'La pastille du menu **Déclarations** et la cloche vous signalent un dossier **À corriger — collecte**.',
      'Ouvrez le dossier : le **motif du retour** est affiché en haut.',
      'Cliquez sur **Modifier**, corrigez ce qui est demandé, enregistrez.',
      'Cliquez de nouveau sur **Transmettre au secrétariat**.',
    ]),

    // ───────────────────────── SECRETARIAT ─────────────────────────
    h1('Profil 2 — Secrétariat d\'état civil'),
    p('Vous recevez les dossiers transmis par les agents, vous les complétez, vous préparez l\'acte et vous le soumettez à la validation. Après validation, vous imprimez l\'acte et l\'enregistrez comme délivré. **Vous ne validez ni ne rejetez** un dossier.'),

    h2('Consulter les déclarations reçues'),
    img('secretaire-file.jpg', 'File du secrétariat', 90),
    p('Le menu **File du secrétariat** (avec sa pastille) liste les dossiers qui vous attendent : transmis, en complément ou à corriger côté secrétariat. Le menu **Déclarations** montre **toutes** les déclarations.'),

    h2('Retrouver un dossier'),
    ul([
      'Tapez une référence, un nom d\'enfant ou un numéro d\'acte dans la barre de recherche (en haut ou dans la liste), puis **Filtrer**.',
      'Affinez par statut, établissement ou dates ; les colonnes indiquent aussi le responsable et la dernière modification.',
      'Pour les dossiers terminés, le menu **Actes de naissance** liste les actes validés et délivrés (recherche par numéro d\'acte, référence ou nom).',
    ]),

    h2('Prendre en charge un dossier'),
    img('secretaire-dossier.jpg', 'Dossier transmis : actions du secrétariat', 90),
    ol([
      'Ouvrez le dossier depuis la file.',
      'Cliquez sur **Prendre en charge** : le statut devient **En complément** et vous en êtes le responsable. Cette étape est facultative : vous pouvez aussi traiter le dossier directement.',
    ]),

    h2('Compléter les informations des parents et du déclarant'),
    ol([
      'Dans le dossier, cliquez sur **Modifier**.',
      'Corrigez l\'identité de l\'enfant, du père et de la mère, et renseignez le **déclarant** (le père, la mère ou une autre personne ; seules la pièce d\'identité et son numéro restent à saisir si c\'est un parent).',
      'Enregistrez : le statut du dossier ne change pas.',
    ]),

    h2('Préparer l\'acte'),
    img('secretaire-acte.jpg', 'Complément de l\'acte', 90),
    ol([
      'Dans le dossier, cliquez sur **Compléter l\'acte**.',
      '**Références du registre** : année, registre, feuillet. Le **numéro officiel** reste « Non attribué » : il est confirmé par l\'administrateur à la validation.',
      '**Circonscription administrative** : région, préfecture, commune et centre sont préremplis (Conakry, Ratoma…) ; corrigez si nécessaire.',
      '**Déclaration et mentions** : saisissez la **date de déclaration** (obligatoire) et les mentions éventuelles.',
      'Cliquez sur **Enregistrer** pour garder votre travail, ou sur **Enregistrer et soumettre à validation** quand tout est prêt.',
    ]),

    h2('Voir l\'aperçu de l\'acte'),
    img('secretaire-apercu.jpg', 'Aperçu de l\'acte avant validation (filigrane « ACTE NON VALIDE »)', 78),
    p('Cliquez sur **Aperçu de l\'acte** dans le dossier. L\'aperçu est **en lecture seule** : il reprend la fiche officielle de l\'état civil (volet n° 1) avec l\'en-tête du registre, puis les rubriques ENFANT, PARENTS (père, mère) et DÉCLARANT.'),
    ul([
      '**Tant que l\'acte n\'est pas validé**, le filigrane **ACTE NON VALIDE** couvre la page et l\'impression est désactivée.',
      'La ligne « Je soussigné : … (L\'officier délégué de l\'état civil) » figure sous le centre d\'état civil.',
      'Les cases que le dossier ne renseigne pas (commune urbaine ou rurale, centre principal ou secondaire, situation matrimoniale) restent vides : elles se cochent à la main après impression.',
    ]),

    h2('Soumettre à la validation'),
    ol([
      'Cliquez sur **Soumettre à validation** (dans le dossier) ou sur **Enregistrer et soumettre à validation** (dans le complément de l\'acte).',
      'Wakara contrôle les informations requises : date de déclaration et nom du déclarant. Si une information manque, un message l\'indique.',
      'Le statut devient **En attente de validation** : le dossier quitte votre file et entre dans celle de l\'administrateur. Vous ne pouvez plus le modifier.',
    ]),

    h2('Traiter un dossier retourné'),
    ol([
      'Un dossier **À corriger — secrétariat** réapparaît dans votre file (pastille et cloche).',
      'Ouvrez-le : le **motif** est affiché. Corrigez les informations ou l\'acte.',
      'Soumettez de nouveau à validation.',
    ]),

    h2('Imprimer l\'acte et enregistrer la délivrance'),
    p('Possible **uniquement après la validation définitive**.'),
    img('secretaire-delivrance.jpg', 'Enregistrement d\'une délivrance', 90),
    ol([
      'Menu **Actes de naissance** : cliquez sur la ligne de l\'acte validé pour ouvrir son aperçu.',
      'Cliquez sur **Imprimer** : la fenêtre d\'impression du navigateur s\'ouvre ; l\'impression est **enregistrée** (copie n°).',
      'Quand l\'acte est remis, cliquez sur **Enregistrer la délivrance** et renseignez **Remis à** (obligatoire), la qualité, le type et le numéro de la pièce d\'identité, puis des observations. Cliquez sur **Enregistrer**.',
      'Le statut devient **Acte délivré**. Une **nouvelle délivrance** du même acte est automatiquement marquée **Duplicata**.',
    ]),

    h2('Consulter les délivrances'),
    img('secretaire-delivrances.jpg', 'Liste des délivrances', 90),
    p('Le menu **Délivrances** liste les actes remis, avec des compteurs en haut et des filtres (type, établissement, dates). Cliquez sur une ligne pour ouvrir le **détail** : remise, acte, qui a fait quoi, parcours du dossier et autres remises du même acte.'),

    h2('Gérer les hôpitaux et maternités'),
    img('secretaire-hopitaux.jpg', 'Établissements de santé', 90),
    ol([
      'Menu **Hôpitaux et maternités** : recherchez par nom ou code ; cochez **Archivés** pour voir les établissements archivés.',
      '**Nouvel établissement** : saisissez le nom et les coordonnées. Le **code** (WH-0001-26) est attribué automatiquement.',
      '**Modifier** corrige les informations ; **Désactiver** empêche de choisir l\'établissement pour de nouveaux dossiers ; **Archiver** le retire de la liste (**Restaurer** le remet). Un établissement n\'est **jamais supprimé**.',
    ]),
    note('Les établissements de Ratoma ont été préremplis à partir de sources publiques : la mairie doit **vérifier la liste** (ajouter, renommer, désactiver).', 'warn'),

    // ───────────────────────── ADMIN ─────────────────────────
    h1('Profil 3 — Administrateur technique'),
    p('Vous prenez la **décision finale** sur les dossiers, vous gérez les comptes et les droits, et vous suivez toute l\'activité de la plateforme. **Vous ne pouvez pas modifier votre propre compte** (rôles, permissions, statut).'),

    h2('Consulter le tableau de bord et les statistiques'),
    img('admin-tableau.jpg', 'Tableau de bord', 90),
    ol([
      'Menu **Tableau de bord**. Choisissez la **période** (cette année, ce mois, cette semaine, aujourd\'hui, deux années précédentes) ou un intervalle « Du / Au ».',
      'Affinez par **établissement**, **statut** ou **responsable**. La période affichée est rappelée sous les filtres.',
      'Chaque **carte de chiffres** est **cliquable** : elle ouvre la liste correspondante avec la même période et les mêmes filtres, donc **le même nombre**. Le bandeau « Sélection du tableau de bord » permet de revenir à la liste complète.',
      'Les graphiques montrent l\'évolution des déclarations et actes validés, la répartition par établissement et par statut.',
    ]),

    h2('Traiter la file de validation'),
    img('admin-validation.jpg', 'File de validation', 90),
    p('Le menu **File de validation** (avec sa pastille) liste les dossiers « En attente de validation ». Ouvrez un dossier pour le contrôler : naissance, enfant, père, mère, déclarant, pièces jointes, acte (cliquez sur **Aperçu de l\'acte**). Vous pouvez encore corriger le dossier avec **Modifier** ou **Compléter l\'acte** : il reste dans votre file jusqu\'à votre décision.'),

    h2('Valider un acte'),
    img('admin-decision.jpg', 'Zone « Décision finale » d\'un dossier en attente', 90),
    ol([
      'Dans la zone **Décision finale**, cliquez sur **Valider définitivement**.',
      'Dans la fenêtre, vérifiez l\'**année**, le **registre**, le **feuillet** et saisissez le **numéro officiel** de l\'acte. Il doit être **unique** pour une même année et un même registre.',
      'Cliquez sur **Valider définitivement**. Le dossier est **figé** : plus personne ne peut le modifier.',
    ]),
    img('admin-valider.jpg', 'Fenêtre de validation : numéro officiel', 78),
    note('**Si des champs attendus sont vides**, Wakara vous **avertit** et liste ces champs. Vous pouvez soit revenir compléter le dossier, soit **Valider quand même** : les champs manquants sont alors notés dans l\'historique du dossier.', 'warn'),

    h2('Retourner ou rejeter un dossier'),
    ol([
      'Dans la zone **Décision finale**, choisissez **Retourner à la collecte** (l\'agent corrige), **Retourner au secrétariat** (le secrétariat corrige) ou **Rejeter le dossier**.',
      'Saisissez le **motif** : il est **obligatoire** et sera lu par la personne qui reçoit le dossier.',
      'Confirmez. Un dossier **rejeté** est clos et figé.',
    ]),

    h2('Créer un utilisateur et attribuer un rôle'),
    img('admin-nouvel-utilisateur.jpg', 'Création d\'un utilisateur', 90),
    ol([
      'Menu **Utilisateurs** → **Nouvel utilisateur**.',
      'Renseignez l\'**identifiant** (obligatoire), l\'e-mail, le prénom, le nom, le téléphone et un **mot de passe temporaire** (obligatoire). L\'utilisateur devra le changer à sa première connexion.',
      'Cliquez sur **Créer**, puis ouvrez la **fiche** de l\'utilisateur (clic sur son nom) pour lui **attribuer un rôle** : agent de collecte, secrétaire d\'état civil ou administrateur technique.',
      'Remettez l\'identifiant et le mot de passe temporaire **en main propre**, jamais par un message ordinaire.',
    ]),
    h3('Réinitialiser un mot de passe, désactiver un compte'),
    ul([
      '**Réinitialiser** : sur la fiche de l\'utilisateur, cliquez sur **Réinitialiser** et donnez-lui le nouveau mot de passe temporaire ; il devra le changer immédiatement.',
      '**Désactiver** : un compte n\'est **jamais supprimé**, il est désactivé et ne peut plus se connecter (ses sessions sont fermées). **Activer** le rétablit.',
    ]),

    h2('Modifier les permissions d\'un rôle'),
    img('admin-roles.jpg', 'Rôles et permissions', 90),
    ol([
      'Menu **Rôles et permissions** : choisissez un rôle dans la colonne de gauche.',
      'Cochez ou décochez les permissions voulues (regroupées par famille : actes, administration, audit…).',
      'Cliquez sur **Enregistrer les permissions**. Chaque changement est **tracé** dans le journal.',
      '**Nouveau rôle** permet de créer un rôle sur mesure. Certaines permissions du rôle administrateur ne peuvent pas être retirées (pour ne jamais se verrouiller dehors).',
    ]),

    h2('Gérer les hôpitaux et maternités'),
    p('Vous disposez des mêmes fonctions que le secrétariat (voir le chapitre 3) : créer, modifier, désactiver, archiver, restaurer.'),

    h2('Consulter l\'historique d\'un acte'),
    img('admin-historiques.jpg', 'Historiques des actes : liste', 90),
    ol([
      'Menu **Historiques des actes** (juste après « Rôles et permissions »). Chaque ligne est un dossier, avec sa **dernière activité** (quoi, par qui, quand) et son nombre d\'événements.',
      'Recherchez par référence, numéro d\'acte, enfant, parent, bénéficiaire ou agent ; filtrez par statut, personne, type d\'action, établissement et dates ; cliquez sur **Rechercher**.',
      'Cliquez sur un dossier pour ouvrir **toute son histoire**.',
    ]),
    img('admin-historique-dossier.jpg', 'Histoire complète d\'un dossier', 90),
    ul([
      'En haut : le statut, le numéro d\'acte et la **frise des étapes** (déclaration saisie, transmise, prise en charge, envoyée à la validation, validée, délivrée).',
      '« **Les étapes clés : qui, quand** » et « **Qui est intervenu** » : chaque personne avec son rôle et ses actions.',
      '« **Chronologie complète** » : tout ce qui s\'est passé, jour par jour ; pour chaque modification, l\'**ancienne et la nouvelle valeur**, le motif et l\'adresse IP. **Exporter (CSV)** produit un fichier pour un tableur.',
    ]),

    h2('Consulter les journaux d\'activité'),
    img('admin-journal.jpg', 'Journal d\'activité', 90),
    ol([
      'Menu **Journaux d\'activité** : toutes les opérations (connexions, créations, modifications, décisions, impressions, exports…) avec l\'auteur, la date, l\'heure et l\'adresse IP.',
      'Filtrez par action, utilisateur, type d\'objet ou dates.',
      '**Exporter** télécharge la liste filtrée en CSV. La consultation et l\'export sont eux-mêmes enregistrés dans le journal.',
    ]),

    h2('Modifier les paramètres'),
    img('admin-parametres.jpg', 'Paramètres', 90),
    p('Menu **Paramètres** : modifiez les **textes de la page de connexion** (étiquette, titre, description, pied de page ; mettez un mot entre *étoiles* pour le colorer) et les **valeurs par défaut des actes** (région, préfecture, commune, centre). Enregistrez : la modification est visible tout de suite.'),

    // ───────────────────────── AIDE-MEMOIRE ─────────────────────────
    h1('Aide-mémoire'),
    h2('Je veux… alors je…'),
    table({
      head: ['Je veux…', 'Je fais…', 'Profil'], widths: [3.6, 4.8, 1.6], small: true,
      rows: [
        ['Enregistrer une naissance', 'Déclarations → Nouvelle déclaration → Enregistrer le brouillon', 'Agent'],
        ['Envoyer le dossier au secrétariat', 'Ouvrir le dossier → Transmettre au secrétariat', 'Agent'],
        ['Corriger un dossier retourné', 'Lire le motif → Modifier → Transmettre au secrétariat', 'Agent'],
        ['Traiter un dossier reçu', 'File du secrétariat → ouvrir → Prendre en charge', 'Secrétariat'],
        ['Préparer l\'acte', 'Dans le dossier : Compléter l\'acte → Enregistrer et soumettre à validation', 'Secrétariat'],
        ['Imprimer un acte', 'Actes de naissance → ouvrir l\'acte validé → Imprimer', 'Secrétariat'],
        ['Noter la remise de l\'acte', 'Aperçu de l\'acte → Enregistrer la délivrance', 'Secrétariat'],
        ['Valider un acte', 'File de validation → ouvrir → Valider définitivement → numéro officiel', 'Administrateur'],
        ['Renvoyer un dossier', 'Retourner à la collecte (ou au secrétariat) → écrire le motif', 'Administrateur'],
        ['Créer un compte', 'Utilisateurs → Nouvel utilisateur → attribuer un rôle', 'Administrateur'],
        ['Savoir qui a modifié un dossier', 'Historiques des actes → ouvrir le dossier', 'Administrateur'],
      ],
    }),
    h2('Messages fréquents'),
    table({
      head: ['Message ou situation', 'Que faire'], widths: [4, 6], small: true,
      rows: [
        ['« Informations obligatoires manquantes »', 'Le message nomme le champ à compléter ; complétez-le puis recommencez'],
        ['« Accès refusé »', 'Votre profil n\'a pas le droit d\'ouvrir cette page ; contactez l\'administrateur si c\'est une erreur'],
        ['Le bouton attendu n\'apparaît pas', 'Les boutons dépendent de votre profil et de l\'état du dossier : vérifiez le statut ; un dossier validé, rejeté ou délivré n\'est plus modifiable'],
        ['Numéro d\'acte refusé', 'Il existe déjà pour la même année et le même registre ; vérifiez le registre ou le numéro'],
        ['Photo refusée', 'Formats acceptés : JPG, PNG, PDF ; 4 Mo maximum (les photos sont réduites automatiquement)'],
        ['La page ne réagit plus', 'Rechargez avec Ctrl+F5 ; l\'application s\'est peut-être mise à jour pendant que l\'onglet restait ouvert'],
      ],
    }),
    h2('Bonnes pratiques'),
    ul([
      'Ne partagez **jamais** votre mot de passe ; ne le notez pas sur le poste.',
      'Déconnectez-vous en quittant votre poste, surtout s\'il est partagé.',
      'Saisissez les informations comme sur la fiche reçue de l\'hôpital ; en cas de doute, laissez vide plutôt que d\'inventer.',
      'Relisez avant de transmettre ou de valider : après la validation, **aucune correction n\'est possible** dans Wakara.',
      'Toute action est enregistrée avec votre nom : n\'utilisez que votre propre compte.',
    ]),
  ],
};
