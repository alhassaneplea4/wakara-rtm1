import { h1, h2, p, ul, table, form, sign, note, BOX } from '../dsl.mjs';
import { META } from '../meta.mjs';

export default {
  title: 'Procès-verbal de livraison et de réception',
  subtitle: 'Remise officielle de la solution Wakara et des éléments convenus',
  audience: 'Client et prestataire',
  toc: false,
  blocks: [
    h1('Objet du procès-verbal'),
    p(`Le présent procès-verbal constate la remise, par le prestataire à la ${META.clientCourt}, de la **première version fonctionnelle (v${META.version})** de la plateforme **Wakara** de gestion des déclarations et des actes de naissance, ainsi que des éléments listés ci-dessous. Il précise les éventuelles réserves du client et les modalités de maintenance.`),
    p('Il est établi en **deux exemplaires originaux**, un pour chaque partie. La réception de la solution suppose que le procès-verbal de recette (document 06) ait été signé.'),

    h1('Parties et circonstances de la remise'),
    form([
      ['Client', META.client],
      ['Représenté par (nom, fonction)', ''],
      ['Prestataire', META.prestataire],
      ['Représenté par (nom, fonction)', ''],
      ['Lieu de la remise', ''],
      ['Date de la remise', ''],
      ['Personnes présentes', ''],
    ]),

    h1('Solution livrée'),
    form([
      ['Nom et version', `Wakara — version ${META.version} (première version fonctionnelle)`],
      ['Adresse de l’application', META.url],
      ['Hébergement actuel', 'Interface et API : Vercel · Base de données : Neon (PostgreSQL)'],
      ['Technologies', 'Angular 17 (interface), Django 5.2 et Django REST Framework (API), PostgreSQL'],
      ['Code source', `Dépôt Git ${META.depot}, branche main`],
      ['Référence du code livré (identifiant du dernier commit)', ''],
      ['Date de mise en ligne', ''],
    ]),

    h1('Éléments remis'),
    p(`Cochez, pour chaque élément, s'il a été remis (${BOX} Remis) ou s'il fait l'objet d'une réserve (${BOX} Réserve).`),
    table({
      head: ['N°', 'Élément', 'Contenu et emplacement', 'Statut'],
      widths: [0.6, 2.4, 5.4, 1.6],
      rows: [
        ['1', 'Application déployée', `Interface et API en ligne à l'adresse ${META.url}, fonctionnelles avec la base de production.`, `${BOX} Remis\n${BOX} Réserve`],
        ['2', 'Code source', 'Dépôt Git complet avec tout l\'historique des modifications : API (dossier backend), interface (dossier frontend), documentation (dossier docs). Copie d\'archive remise sur support convenu.', `${BOX} Remis\n${BOX} Réserve`],
        ['3', 'Documentation', 'Les sept documents du dossier : cahier des charges, dossier technique, manuel utilisateur, guide d\'installation et d\'exploitation, rapport de tests, PV de recette, PV de livraison (formats Word et PDF).', `${BOX} Remis\n${BOX} Réserve`],
        ['4', 'Accès administratifs', 'Compte administrateur technique de l\'application ; accès à l\'hébergeur de l\'application ; accès à la base de données ; accès au dépôt du code source ; nom de domaine le cas échéant (voir l\'inventaire des accès ci-dessous).', `${BOX} Remis\n${BOX} Réserve`],
        ['5', 'Base de données et sauvegardes', 'Base PostgreSQL en production, commandes de sauvegarde et de restauration fournies (document 04), sauvegardes automatiques du fournisseur à activer et à vérifier.', `${BOX} Remis\n${BOX} Réserve`],
        ['6', 'Éléments graphiques', 'Logo CECI Ratoma et icônes de l\'application (dossier frontend/src/assets du code source).', `${BOX} Remis\n${BOX} Réserve`],
        ['7', 'Données initiales', 'Rôles et permissions par défaut, paramètres de l\'application, établissements de santé de Ratoma préremplis (liste à valider par la mairie).', `${BOX} Remis\n${BOX} Réserve`],
        ['8', 'Formation des utilisateurs', 'Séance(s) de prise en main par profil : agents de collecte, secrétariat, administrateur technique (voir le tableau de formation).', `${BOX} Remis\n${BOX} Réserve`],
        ['9', 'Rapport de tests et PV de recette', 'Rapport de tests (document 05) et procès-verbal de recette signé (document 06).', `${BOX} Remis\n${BOX} Réserve`],
      ],
    }),

    h1('Inventaire des accès remis'),
    note('**Aucun mot de passe, clé ou jeton n\'est écrit dans ce document ni dans le dossier.** Les secrets sont remis séparément, par un canal sûr (remise en main propre ou gestionnaire de mots de passe), puis **changés par la mairie dès la première connexion**.', 'warn'),
    table({
      head: ['Accès', 'Responsable côté mairie', 'Date de remise', 'Mot de passe changé'],
      widths: [3.4, 3, 1.8, 1.8],
      minRow: 560,
      rows: [
        ['Compte administrateur technique de l\'application', '', '', BOX],
        ['Hébergeur de l\'application (Vercel)', '', '', BOX],
        ['Base de données (Neon)', '', '', BOX],
        ['Dépôt du code source (GitHub)', '', '', BOX],
        ['Nom de domaine (si applicable)', '', '', BOX],
        ['Autre : ', '', '', BOX],
      ],
    }),

    h1('Formation des utilisateurs'),
    table({
      head: ['Session', 'Date et durée', 'Public', 'Participants'],
      widths: [2.6, 2, 2.2, 3.2],
      minRow: 600,
      rows: [
        ['Agents de collecte', '', '', ''],
        ['Secrétariat d\'état civil', '', '', ''],
        ['Administrateur technique', '', '', ''],
      ],
    }),

    h1('Maintenance et garantie'),
    p('Les modalités ci-dessous sont celles convenues entre les parties (contrat ou avenant). Elles sont reportées ici pour mémoire.'),
    form([
      ['Durée de la garantie de bon fonctionnement', ''],
      ['Correction des anomalies (délais selon la gravité)', ''],
      ['Évolutions et nouvelles fonctionnalités', ''],
      ['Mises à jour de sécurité', ''],
      ['Contact et horaires du support', ''],
      ['Coût de la maintenance, le cas échéant', ''],
    ], [4, 6]),

    h1('Points contractuels à préciser'),
    p('Wakara traite des données personnelles d\'état civil. Les quatre points suivants doivent être arrêtés par écrit avant la mise en exploitation réelle.'),
    table({
      head: ['Sujet', 'Décision des parties', 'Précisions'],
      widths: [3, 4, 3],
      minRow: 760,
      rows: [
        ['**Propriété du code source**, des bases de données, des éléments graphiques et des droits d\'exploitation', `${BOX} Propriété de la mairie\n${BOX} Propriété du prestataire, licence d'exploitation à la mairie\n${BOX} Autre :`, ''],
        ['**Protection des données** : responsabilité sur les informations des enfants et des parents, accès, hébergement, conservation', `${BOX} Responsabilités définies dans le contrat\n${BOX} À définir avant l'exploitation réelle`, ''],
        ['**Continuité du service** : sauvegardes, restauration, conduite à tenir en cas de panne', `${BOX} Procédure du document 04 adoptée\n${BOX} Procédure à compléter`, ''],
        ['**Validité administrative** : modèle d\'acte, numérotation, signatures, circuit de délivrance', `${BOX} Approuvés par l'autorité compétente\n${BOX} En attente d'approbation`, ''],
      ],
    }),

    h1('Réserves de la mairie'),
    table({
      head: ['N°', 'Réserve formulée', 'Échéance de levée', 'Levée le'],
      widths: [0.6, 6, 1.8, 1.6],
      minRow: 600,
      rows: [['1', '', '', ''], ['2', '', '', ''], ['3', '', '', ''], ['4', '', '', '']],
    }),

    h1('Décision de réception'),
    table({
      head: null, widths: [10], zebra: false, minRow: 0,
      rows: [
        [`${BOX} **Réception prononcée sans réserve**`],
        [`${BOX} **Réception prononcée avec les réserves ci-dessus** (levées dans les délais indiqués)`],
        [`${BOX} **Réception refusée** — motif :`],
      ],
    }),
    p('La réception prend effet à la date de signature du présent procès-verbal.'),

    h1('Signatures'),
    sign([
      { title: `Pour la ${META.clientCourt} (le client)`, lines: ['Nom :', 'Fonction :', 'Date :'] },
      { title: 'Pour le prestataire', lines: ['Nom :', 'Fonction :', 'Date :'] },
    ]),
  ],
};
