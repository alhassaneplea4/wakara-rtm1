import { h1, h2, h3, p, ul, ol, table, code, note, img } from '../dsl.mjs';
import { META } from '../meta.mjs';
import { dictionary, missing } from '../dictionnaire.mjs';

// ── catalogue des permissions (copie de backend/core/permissions.py) ──
const PERMS = [
  ['declaration.view', 'Consulter ses déclarations', 'Déclarations'],
  ['declaration.view_all', 'Consulter toutes les déclarations', 'Déclarations'],
  ['declaration.create', 'Créer une déclaration', 'Déclarations'],
  ['declaration.update', 'Modifier une déclaration', 'Déclarations'],
  ['declaration.transmit', 'Transmettre une déclaration', 'Déclarations'],
  ['declaration.archive', 'Archiver une déclaration', 'Déclarations'],
  ['acte.view', 'Consulter les actes', 'Actes'],
  ['acte.complete', 'Prendre en charge un dossier', 'Actes'],
  ['acte.update', 'Compléter un acte', 'Actes'],
  ['acte.submit', 'Soumettre un acte à validation', 'Actes'],
  ['acte.print', 'Imprimer un acte', 'Actes'],
  ['acte.deliver', 'Enregistrer une délivrance', 'Actes'],
  ['dossier.validate', 'Valider définitivement', 'Validation'],
  ['dossier.reject', 'Rejeter ou retourner un dossier', 'Validation'],
  ['document.view', 'Consulter les pièces justificatives', 'Pièces'],
  ['document.upload', 'Ajouter une pièce justificative', 'Pièces'],
  ['hospital.view', 'Consulter les établissements', 'Établissements'],
  ['hospital.create', 'Créer un établissement', 'Établissements'],
  ['hospital.update', 'Modifier un établissement', 'Établissements'],
  ['hospital.archive', 'Archiver un établissement', 'Établissements'],
  ['user.view', 'Consulter les utilisateurs', 'Administration'],
  ['user.create', 'Créer un utilisateur', 'Administration'],
  ['user.update', 'Modifier un utilisateur', 'Administration'],
  ['user.manage_status', 'Activer / désactiver un compte', 'Administration'],
  ['user.assign_roles', 'Attribuer des rôles et permissions', 'Administration'],
  ['user.reset_password', 'Réinitialiser un mot de passe', 'Administration'],
  ['role.view', 'Consulter les rôles', 'Administration'],
  ['role.manage', 'Gérer les rôles et leurs permissions', 'Administration'],
  ['stats.view', 'Consulter les statistiques', 'Statistiques'],
  ['data.export', 'Exporter les données', 'Statistiques'],
  ['audit.view', 'Consulter les journaux d\'audit', 'Audit'],
  ['settings.manage', 'Gérer les paramètres', 'Administration'],
];
const SECRETARY = new Set(['declaration.view', 'declaration.view_all', 'acte.view', 'acte.complete', 'acte.update', 'acte.submit', 'acte.print', 'acte.deliver', 'document.view', 'document.upload', 'hospital.view', 'hospital.create', 'hospital.update', 'hospital.archive', 'stats.view']);
const AGENT = new Set(['declaration.view', 'declaration.create', 'declaration.update', 'declaration.transmit', 'document.view', 'document.upload', 'hospital.view']);
const Y = '✔', N = '—';

const dico = dictionary(table, h3);
if (missing.length) console.log('⚠ dictionnaire : descriptions manquantes →', missing.join(', '));

const E = (m, path, role, perm) => [m, `\`${path}\``, role, perm ? `\`${perm}\`` : 'Ouvert'];
const API = (rows) => table({ head: ['Méthode', 'Chemin', 'Rôle', 'Permission'], widths: [1.1, 3.4, 3.1, 2.4], rows, small: true });

export default {
  title: 'Dossier technique',
  subtitle: 'Architecture, base de données, API, sécurité et organisation du code',
  audience: 'Développeurs et administrateurs techniques',
  blocks: [
    h1('Présentation générale'),
    h2('Contexte et objectifs'),
    p(`Wakara est la plateforme web de la ${META.clientCourt} pour gérer les déclarations de naissance reçues des établissements de santé et les actes de naissance qui en découlent. Elle couvre tout le cycle : saisie, transmission, complément, validation, numérotation, impression, délivrance, statistiques et traçabilité. Le périmètre fonctionnel est décrit dans le cahier des charges (document 01).`),
    h2('Principes de conception'),
    ul([
      '**Le serveur décide.** L\'interface n\'applique aucune règle critique : elle affiche ce que l\'API autorise (`available_transitions`, `can_edit`, `permissions`) et l\'API refuse tout le reste.',
      '**Refus par défaut.** Une action qui n\'est pas explicitement déclarée dans la table des permissions d\'une vue est refusée.',
      '**Aucune suppression physique.** Les éléments sont archivés ou désactivés ; le journal d\'audit et l\'historique des statuts sont en ajout seul.',
      '**Tout est tracé.** Auteur, date, adresse IP, ancienne et nouvelle valeur de chaque modification.',
      '**Aucune règle administrative inventée.** Les hypothèses de travail sont configurables et listées pour validation.',
    ]),

    h1('Architecture'),
    img('schema-architecture.png', 'Architecture générale : interface, API et base de données', 100),
    p('L\'interface Angular est servie comme un ensemble de fichiers statiques. Elle dialogue avec l\'API Django en JSON, sur le même domaine (chemin `/api/…`), ce qui évite toute configuration d\'échange entre domaines. L\'API lit et écrit dans une base PostgreSQL.'),
    h2('Déroulement d\'une requête'),
    ol([
      'Le navigateur envoie la requête avec le jeton d\'accès dans l\'en-tête `Authorization: Bearer …`.',
      'L\'intercepteur de contexte d\'audit retient l\'adresse IP (selon `NUM_PROXIES`) et le navigateur.',
      'La classe de permission vérifie le jeton, l\'état du compte (actif, mot de passe à changer ?) et le droit requis par l\'action.',
      'La vue délègue à un **service métier** (`declarations/services.py`, `actes/services.py`) qui applique le workflow dans une transaction avec verrous.',
      'Le journal d\'audit enregistre l\'opération ; la réponse JSON est renvoyée.',
    ]),
    h2('Organisation du code'),
    code(`wakara-rtm1/
├── backend/                 API Django
│   ├── wakara/              réglages, urls, wsgi
│   ├── core/                workflow, permissions, mixins, paramètres, commandes
│   ├── accounts/            utilisateurs, rôles, permissions, authentification
│   ├── hospitals/           établissements de santé
│   ├── declarations/        déclarations, enfant, parents, déclarant, historique
│   ├── actes/               actes, séquences, impressions, délivrances
│   ├── documents/           pièces justificatives (stockage privé)
│   ├── audit/               journal d'audit, historiques par dossier
│   ├── stats/               tableau de bord
│   ├── tests/               161 tests automatisés
│   └── build.py             étape de build Vercel (migrations)
├── frontend/                interface Angular 17
│   └── src/app/
│       ├── core/            API, authentification, gardes, intercepteur, modèles
│       ├── shared/          composants et directives réutilisables
│       ├── layout/          structure (menu latéral, en-tête)
│       └── features/        un composant par écran
├── docs/                    documentation et dossier de livraison
└── vercel.json              déclaration des deux services`),
    table({
      head: ['Application Django', 'Responsabilité'], widths: [2.2, 7.8], small: true,
      rows: [
        ['`core`', 'Mixins (horodatage, archivage logique, ajout seul), machine à états du workflow, catalogue de permissions, vues d\'audit génériques, paramètres du site, commandes de gestion'],
        ['`accounts`', 'Utilisateur, rôles, permissions, ajustements par utilisateur, authentification et jetons'],
        ['`hospitals`', 'Établissements (désactivation et archivage, jamais de suppression), code automatique, préremplissage de Ratoma'],
        ['`declarations`', 'Déclaration, enfant, parents, déclarant, historique des statuts, compteur de références, exports'],
        ['`actes`', 'Acte (références du registre, numéro officiel), séquences, impressions, délivrances, document imprimable'],
        ['`documents`', 'Pièces justificatives en stockage privé, téléchargement authentifié et tracé'],
        ['`audit`', 'Journal d\'audit en ajout seul, contexte de requête, historiques par dossier'],
        ['`stats`', 'Tableau de bord calculé depuis la base'],
      ],
    }),

    h1('Technologies'),
    table({
      head: ['Composant', 'Version', 'Usage'], widths: [3.3, 2.2, 4.5], small: true,
      rows: [
        ['Python', '3.12 ou plus (testé avec 3.14)', 'Langage du backend'],
        ['Django', '5.2.19', 'Cadre web, ORM, migrations, administration'],
        ['Django REST Framework', '3.18.3', 'API REST, sérialisation, permissions'],
        ['djangorestframework-simplejwt', '≥ 5.3, < 6.0', 'Jetons JWT (rotation, liste noire)'],
        ['django-filter', '26.2', 'Filtres des listes'],
        ['django-cors-headers', '4.9.0', 'Échanges entre origines (développement)'],
        ['psycopg', '3.3.8', 'Pilote PostgreSQL'],
        ['Pillow', '13.0.0', 'Contrôle des images'],
        ['django-storages', '1.14.6', 'Stockage S3 privé des pièces (option)'],
        ['drf-spectacular', '0.30.0', 'Documentation OpenAPI (développement)'],
        ['python-decouple', '3.8', 'Lecture des variables d\'environnement'],
        ['Angular', '17.3', 'Interface (composants autonomes, signaux, routes à chargement différé)'],
        ['TypeScript', '5.3', 'Langage de l\'interface'],
        ['Chart.js', '4.4', 'Graphiques du tableau de bord'],
        ['RxJS', '7.8', 'Flux de données asynchrones'],
        ['Karma, Jasmine', '6.4, 5.1', 'Tests unitaires de l\'interface'],
        ['PostgreSQL (Neon)', '15 ou plus', 'Base de données de production (SQLite en développement)'],
      ],
    }),
    note('Les versions sont celles installées lors de la livraison. Le fichier `backend/requirements.txt` fixe des plages de versions ; `frontend/package-lock.json` fixe les versions exactes de l\'interface.', 'info'),

    h1('Architecture fonctionnelle'),
    p('Wakara se compose de huit modules fonctionnels. Chacun correspond à un ou plusieurs écrans de l\'interface, à des points d\'accès de l\'API et à des tables de la base.'),
    table({
      head: ['Module', 'Fonctions', 'Écrans (chemins)', 'Application'], widths: [2.2, 3.8, 2.6, 1.4], small: true,
      rows: [
        ['**Déclarations de naissance**', 'Saisie, brouillon, transmission, pièces, corrections, export', '`/declarations`, `/declarations/new`, `/declarations/:id`, `/secretariat`', 'declarations'],
        ['**Actes de naissance**', 'Complément, numéro officiel, aperçu, impression, délivrances', '`/declarations/:id/acte`, `/actes`, `/actes/:id/document`, `/deliveries`', 'actes'],
        ['**Établissements**', 'Création, désactivation, archivage, restauration', '`/hospitals`', 'hospitals'],
        ['**Utilisateurs**', 'Comptes, rôles attribués, mot de passe, désactivation', '`/users`, `/profile`', 'accounts'],
        ['**Rôles et permissions**', 'Permissions par rôle, ajustements individuels', '`/roles`', 'accounts'],
        ['**Validation administrative**', 'File de validation, décision finale, numérotation', '`/validation`', 'declarations, actes'],
        ['**Statistiques**', 'Tableau de bord, filtres, cartes cliquables', '`/dashboard`', 'stats'],
        ['**Traçabilité et audit**', 'Journal d\'activité, historiques des actes, exports', '`/audit`, `/history`, `/history/:id`', 'audit'],
      ],
    }),
    p('Autres écrans : connexion (`/login`), paramètres (`/settings`), accès refusé et page introuvable.'),

    h1('Gestion des utilisateurs'),
    h2('Authentification'),
    ul([
      '**Connexion** par identifiant ou adresse e-mail et mot de passe. En cas d\'échec, le message est identique que le compte existe ou non.',
      '**Jetons JWT** : jeton d\'accès (60 minutes par défaut) et jeton de rafraîchissement (7 jours par défaut) avec rotation ; le jeton de rafraîchissement est mis en liste noire à la déconnexion.',
      '**Révocation** : les jetons d\'un utilisateur sont révoqués lors d\'un changement de mot de passe, d\'une réinitialisation ou d\'une désactivation ; un compte désactivé est refusé immédiatement, même avec un jeton déjà émis.',
      '**Verrouillage** : après 5 échecs, le compte est bloqué 15 minutes (réglable) ; le compteur est tenu en base, de façon atomique.',
      '**Mot de passe** : validateurs Django (longueur, mot de passe courant, similarité) ; changement obligatoire à la première connexion et après une réinitialisation.',
      '**Stockage des jetons côté navigateur** : `sessionStorage` par défaut ; « se souvenir de moi » utilise `localStorage`.',
    ]),
    h2('Rôles et permissions'),
    p('Les droits de chaque utilisateur sont la **somme des permissions de ses rôles actifs**, plus les permissions accordées individuellement, moins celles retirées individuellement. Le drapeau « superutilisateur » de Django n\'accorde **aucun** droit métier : il sert seulement à la maintenance technique.'),
    table({
      head: ['Permission', 'Libellé', 'Admin', 'Secrétaire', 'Agent'], widths: [2.6, 4.2, 1, 1.2, 1], small: true,
      rows: PERMS.map(([c, l]) => [`\`${c}\``, l, Y, SECRETARY.has(c) ? Y : N, AGENT.has(c) ? Y : N]),
    }),
    p('Ces rôles sont ceux créés à l\'installation ; l\'administrateur peut les ajuster dans l\'écran « Rôles et permissions ».'),
    h2('Protections contre l\'élévation de privilèges'),
    ul([
      'Nul ne peut modifier ses propres rôles, permissions ou statut.',
      'Le rôle administrateur conserve toujours `user.view`, `user.assign_roles`, `role.view` et `role.manage` (impossible de se verrouiller dehors).',
      'Les drapeaux privilégiés (`is_superuser`, `is_staff`, rôles) sont ignorés à la création d\'un compte et sur le profil personnel.',
      'Utilisateurs et rôles ne se suppriment pas.',
    ]),

    h1('Workflow métier'),
    img('schema-circuit.png', 'Circuit de traitement d\'un dossier', 100),
    p('Le circuit est une **machine à états** (`core/workflow.py`) appliquée par le serveur. Chaque transition nomme la permission qui l\'autorise ; un statut ne peut jamais être imposé directement par une requête.'),
    table({
      head: ['De', 'Vers', 'Permission', 'Motif'], widths: [2.8, 2.8, 2.4, 2], small: true,
      rows: [
        ['Brouillon', 'Transmis au secrétariat', '`declaration.transmit`', ''],
        ['Transmis au secrétariat', 'En complément', '`acte.complete`', ''],
        ['Transmis au secrétariat', 'En attente de validation', '`acte.submit`', ''],
        ['En complément', 'En attente de validation', '`acte.submit`', ''],
        ['En attente de validation', 'Validé définitivement', '`dossier.validate`', ''],
        ['En attente de validation', 'À corriger — collecte', '`dossier.reject`', 'Obligatoire'],
        ['En attente de validation', 'À corriger — secrétariat', '`dossier.reject`', 'Obligatoire'],
        ['En attente de validation', 'Rejeté', '`dossier.reject`', 'Obligatoire'],
        ['À corriger — collecte', 'Transmis au secrétariat', '`declaration.transmit`', ''],
        ['À corriger — secrétariat', 'En attente de validation', '`acte.submit`', ''],
        ['Validé définitivement', 'Acte délivré', '`acte.deliver` (par l\'enregistrement d\'une délivrance)', ''],
      ],
    }),
    h2('Qui peut modifier quoi, et quand'),
    table({
      head: ['Statut du dossier', 'Modification possible par'], widths: [3.2, 6.8], small: true,
      rows: [
        ['Brouillon, À corriger — collecte', 'L\'agent de collecte (ses propres dossiers)'],
        ['Transmis, En complément, À corriger — secrétariat', 'Le secrétariat (données de la déclaration et acte)'],
        ['En attente de validation', 'Seul le validateur (administrateur) ; le dossier reste dans sa file jusqu\'à la décision'],
        ['Validé, Rejeté, Acte délivré', 'Personne : dossier figé'],
      ],
    }),
    h2('Règles associées'),
    ul([
      '**Informations minimales** : transmission (date de naissance, sexe, nom de l\'enfant, nom de la mère) et soumission de l\'acte (date de déclaration, nom du déclarant) ; réglables par `DECLARATION_REQUIRED_FOR_TRANSMISSION` et `ACTE_REQUIRED_FOR_SUBMISSION`.',
      '**Numéro officiel** : saisi à la validation (par défaut), unique par année et registre, attribué dans une transaction verrouillée, jamais écrasé. Numérotation automatique disponible (`ACTE_AUTO_NUMBERING`), désactivée.',
      '**Validation avec champs vides** : le serveur répond 409 (`incomplete_confirmation_required`) avec la liste des champs ; rien n\'est écrit tant que `accept_incomplete` n\'est pas confirmé ; les champs manquants sont alors consignés dans l\'historique et l\'audit.',
      '**Référence interne** : `WKR-AAAA-NNNN`, produite par un compteur verrouillé ; distincte du numéro officiel de l\'acte et de l\'identifiant technique (UUID).',
    ]),

    h1('Base de données'),
    img('schema-donnees.png', 'Modèle de données — vue simplifiée', 100),
    p(`La base compte **${dico.count} tables** métier. Le dictionnaire complet (champ par champ) figure en annexe A.`),
    h2('Conventions'),
    ul([
      '`uuid` : identifiant technique exposé par l\'API (l\'identifiant numérique interne n\'est jamais exposé).',
      '`created_at`, `updated_at` : posés par le serveur ; `created_by`, `updated_by` : posés à partir de l\'utilisateur connecté, jamais depuis le corps de la requête.',
      '`is_archived`, `archived_at`, `archived_by` : archivage logique ; aucune ligne métier n\'est supprimée.',
      'Le journal d\'audit et l\'historique des statuts refusent toute modification ou suppression (au niveau de l\'application).',
    ]),
    h2('Migrations'),
    p('Chaque application versionne ses migrations. En production, elles sont appliquées automatiquement à chaque déploiement (`backend/build.py`) ; le contrôle `python manage.py makemigrations --check` ne doit signaler aucune migration manquante.'),

    h1('API'),
    h2('Conventions'),
    ul([
      'Toutes les routes sont sous `/api/` ; les échanges sont en JSON, sauf les exports CSV et le téléchargement de pièces.',
      'Authentification : en-tête `Authorization: Bearer <jeton d\'accès>` (sauf connexion et textes publics).',
      'Les ressources sont désignées par leur `uuid`. Les listes sont paginées et filtrables (recherche, tri, filtres propres à chaque ressource).',
      'Erreurs : 400 (données invalides), 401 (non connecté), 403 (droit manquant), 404, 409 (confirmation nécessaire), avec un message en français.',
      'Documentation interactive (Swagger) : `/api/docs/` et schéma OpenAPI `/api/schema/`, **uniquement en développement** (désactivées en production).',
    ]),
    h2('Authentification et profil'),
    API([
      E('POST', '/api/auth/login/', 'Connexion ; retourne les jetons et le profil', null),
      E('POST', '/api/auth/refresh/', 'Renouvelle le jeton d\'accès', null),
      E('POST', '/api/auth/logout/', 'Déconnexion ; met le jeton de rafraîchissement en liste noire', null),
      E('GET, PATCH', '/api/auth/me/', 'Profil de l\'utilisateur connecté', 'Connecté'),
      E('POST', '/api/auth/change-password/', 'Changement de mot de passe (retourne un nouveau couple de jetons)', 'Connecté'),
      E('GET', '/api/public/settings/', 'Textes de la page de connexion', null),
      E('GET', '/api/inbox/', 'Compteurs de travail en attente (pastilles du menu)', 'declaration.view'),
    ]),
    h2('Utilisateurs, rôles et permissions'),
    API([
      E('GET', '/api/users/', 'Liste des utilisateurs', 'user.view'),
      E('POST', '/api/users/', 'Crée un utilisateur (mot de passe temporaire)', 'user.create'),
      E('GET', '/api/users/{uuid}/', 'Détail d\'un utilisateur', 'user.view'),
      E('PATCH', '/api/users/{uuid}/', 'Modifie un utilisateur', 'user.update'),
      E('POST', '/api/users/{uuid}/activate/', 'Active un compte', 'user.manage_status'),
      E('POST', '/api/users/{uuid}/deactivate/', 'Désactive un compte', 'user.manage_status'),
      E('GET, POST', '/api/users/{uuid}/roles/', 'Rôles d\'un utilisateur ; attribution', 'user.assign_roles'),
      E('POST', '/api/users/{uuid}/roles/remove/', 'Retire un rôle', 'user.assign_roles'),
      E('GET, POST, DELETE', '/api/users/{uuid}/permissions/', 'Ajustements individuels de permissions', 'user.assign_roles'),
      E('POST', '/api/users/{uuid}/reset-password/', 'Réinitialise le mot de passe (temporaire)', 'user.reset_password'),
      E('GET', '/api/roles/', 'Liste des rôles', 'role.view'),
      E('POST, PATCH, PUT', '/api/roles/ et /api/roles/{id}/', 'Crée ou modifie un rôle', 'role.manage'),
      E('PUT', '/api/roles/{id}/permissions/', 'Définit les permissions d\'un rôle', 'role.manage'),
      E('GET', '/api/permissions/', 'Catalogue des permissions', 'role.view'),
    ]),
    h2('Établissements'),
    API([
      E('GET', '/api/hospitals/', 'Liste (filtres : commune, actif, type ; recherche par nom ou code)', 'hospital.view'),
      E('POST', '/api/hospitals/', 'Crée un établissement (code automatique)', 'hospital.create'),
      E('GET', '/api/hospitals/{uuid}/', 'Détail', 'hospital.view'),
      E('PATCH, PUT', '/api/hospitals/{uuid}/', 'Modifie un établissement', 'hospital.update'),
      E('POST', '/api/hospitals/{uuid}/activate/ · deactivate/', 'Active ou désactive', 'hospital.update'),
      E('DELETE', '/api/hospitals/{uuid}/', 'Archive (aucune suppression)', 'hospital.archive'),
      E('POST', '/api/hospitals/{uuid}/restore/', 'Restaure un établissement archivé', 'hospital.archive'),
    ]),
    h2('Déclarations'),
    API([
      E('GET', '/api/declarations/', 'Liste (recherche, filtres de statut, établissement, dates, responsable)', 'declaration.view'),
      E('POST', '/api/declarations/', 'Crée une déclaration (brouillon)', 'declaration.create'),
      E('GET', '/api/declarations/{uuid}/', 'Détail, transitions disponibles, droits d\'édition', 'declaration.view'),
      E('PATCH, PUT', '/api/declarations/{uuid}/', 'Modifie les données de la déclaration', 'declaration.update ou acte.update'),
      E('DELETE', '/api/declarations/{uuid}/', 'Archive (brouillon ou rejeté)', 'declaration.archive'),
      E('POST', '/api/declarations/{uuid}/transition/', 'Change le statut (transmettre, prendre en charge, soumettre, valider, retourner, rejeter)', 'Selon la transition'),
      E('GET', '/api/declarations/export/', 'Export CSV de la liste filtrée (tracé)', 'data.export'),
      E('GET', '/api/declarations/agents/', 'Responsables présents (filtre)', 'declaration.view_all'),
    ]),
    h2('Actes et délivrances'),
    API([
      E('GET', '/api/actes/', 'Liste des actes validés ou délivrés', 'acte.view'),
      E('GET', '/api/actes/{uuid}/', 'Détail d\'un acte', 'acte.view'),
      E('PATCH, PUT', '/api/actes/{uuid}/', 'Complète l\'acte (registre, feuillet, dates, mentions)', 'acte.update'),
      E('GET', '/api/actes/{uuid}/document/', 'Données du document imprimable', 'acte.view'),
      E('POST', '/api/actes/{uuid}/print/', 'Enregistre une impression', 'acte.print'),
      E('GET', '/api/actes/{uuid}/prints/', 'Historique des impressions', 'acte.view'),
      E('POST', '/api/actes/{uuid}/deliver/', 'Enregistre une délivrance (duplicata si déjà délivré)', 'acte.deliver'),
      E('GET', '/api/actes/deliveries/', 'Liste des délivrances', 'acte.view'),
      E('GET', '/api/actes/deliveries/summary/', 'Compteurs des délivrances', 'acte.view'),
      E('GET', '/api/actes/deliveries/{uuid}/', 'Détail d\'une délivrance', 'acte.view'),
    ]),
    h2('Pièces, audit, statistiques et paramètres'),
    API([
      E('GET, POST', '/api/documents/', 'Liste ; ajout d\'une pièce justificative', 'document.view · document.upload'),
      E('GET, DELETE', '/api/documents/{uuid}/', 'Détail ; archivage d\'une pièce', 'document.view · document.upload'),
      E('GET', '/api/documents/{uuid}/download/', 'Téléchargement authentifié et tracé', 'document.view'),
      E('GET', '/api/audit/', 'Journal d\'activité (filtres)', 'audit.view'),
      E('GET', '/api/audit/{id}/ · actions/', 'Détail d\'un événement ; liste des actions', 'audit.view'),
      E('GET', '/api/audit/export/', 'Export CSV du journal (tracé)', 'data.export'),
      E('GET', '/api/history/', 'Historiques par dossier (recherche, filtres)', 'audit.view'),
      E('GET', '/api/history/{id}/ · summary/', 'Histoire d\'un dossier ; indicateurs du jour', 'audit.view'),
      E('GET', '/api/stats/dashboard/', 'Tableau de bord (période et filtres)', 'stats.view'),
      E('GET, PATCH', '/api/settings/', 'Paramètres modifiables', 'settings.manage'),
    ]),

    h1('Sécurité'),
    table({
      head: ['Domaine', 'Mesures en place'], widths: [2.2, 7.8], small: true,
      rows: [
        ['Authentification', 'Jetons à durée limitée, rotation et liste noire ; révocation sur changement de mot de passe, réinitialisation et désactivation ; verrouillage de compte ; message d\'erreur uniforme ; changement de mot de passe obligatoire ; limitation du débit de la connexion'],
        ['Autorisations', 'Permissions vérifiées par le serveur à chaque requête, refus par défaut ; visibilité des dossiers limitée (l\'agent ne voit que les siens) ; protections contre l\'élévation de privilèges ; superutilisateur Django sans droit métier'],
        ['Intégrité des données', 'Aucune suppression physique ; journal d\'audit et historique des statuts en ajout seul ; verrous de ligne pour la numérotation et le workflow ; contrainte d\'unicité du numéro par année et registre'],
        ['Traçabilité', 'Chaque opération est consignée (auteur, date, adresse IP, navigateur, modifications, motif) ; consultation et export du journal eux-mêmes tracés ; mots de passe et jetons jamais écrits dans le journal'],
        ['Pièces justificatives', 'Extension et signature du fichier vérifiées, taille limitée, nom aléatoire, stockage hors de toute adresse publique, `Cache-Control: no-store`, accès filtré par la visibilité du dossier, chaque téléchargement tracé'],
        ['Transport et navigateur', 'HTTPS imposé et HSTS en production, cookies sécurisés ; documentation de l\'API désactivée en production ; Django Admin non exposé sur l\'hébergement actuel'],
        ['Adresse IP du client', 'L\'en-tête `X-Forwarded-For` n\'est lu qu\'avec le nombre de relais de confiance déclaré (`NUM_PROXIES`) ; une valeur invalide est écartée'],
        ['Exports', 'Réservés à la permission `data.export` ; cellules CSV neutralisées contre l\'injection de formules'],
        ['Secrets', 'Aucun secret dans le code ni dans le dépôt ; tout passe par des variables d\'environnement'],
      ],
    }),
    h2('Limites connues'),
    ul([
      'La limitation du débit utilise un cache mémoire propre à chaque instance : en environnement sans serveur, elle est moins stricte (le verrouillage de compte, lui, est fiable car tenu en base). Un cache partagé (Redis) est recommandé.',
      'Un administrateur de la base de données peut contourner l\'ajout seul du journal par une requête SQL directe. En production, retirer les droits de modification et de suppression à l\'utilisateur applicatif : `REVOKE UPDATE, DELETE, TRUNCATE ON audit_auditlog, declarations_statushistory FROM <utilisateur_applicatif>;`',
      'Axes d\'audit encore à approfondir : cycle de vie des jetons, limitation de débit générale, ordre d\'écriture du journal, vulnérabilités des bibliothèques de l\'interface (voir le rapport de tests).',
    ]),

    h1('Hébergement'),
    h2('Situation actuelle'),
    table({
      head: ['Élément', 'Valeur'], widths: [3, 7], small: true, zebra: false,
      rows: [
        ['Adresse', META.url],
        ['Interface et API', 'Vercel, projet `wakara-rtm`, deux services sur un même domaine (voir `vercel.json`) : `backend` (Django, chemin `/api`) et `frontend` (Angular)'],
        ['Base de données', 'Neon (PostgreSQL), base `wakara-db`, région `iad1` (États-Unis), offre gratuite'],
        ['Déploiement', 'Automatique à chaque envoi sur la branche `main` du dépôt'],
        ['Initialisation de la base', '`backend/build.py` exécute `migrate` et `setup_initial_data` à chaque déploiement de **production** uniquement (les déploiements de prévisualisation ne touchent pas la base)'],
        ['Pièces justificatives', 'Dans la base de données (privées), sauvegardées avec elle ; un bucket S3 privé reste possible'],
        ['Nom de domaine', 'Domaine Vercel `*.vercel.app` ; un domaine personnalisé se configure dans Vercel (`ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`)'],
      ],
    }),
    note('**Décision à prendre par la mairie.** Les données d\'état civil sont des données personnelles : le lieu d\'hébergement (local, national ou international) doit être choisi en connaissance de cause. Le dépôt reste déployable sur un serveur classique (gunicorn et un serveur web) : voir le guide d\'installation et d\'exploitation (document 04).', 'warn'),
    h2('Limites de l\'offre gratuite'),
    ul([
      'Base Neon : 0,5 Go ; chaque photo de fiche pèse 1 à 3 Mo : surveiller le volume ou basculer les pièces vers un stockage S3.',
      'Envois limités à 4 Mo par fichier ; l\'interface réduit automatiquement les photos.',
      'Le service « Vercel Services » est en version bêta : en cas d\'échec de déploiement, consulter le journal de build.',
    ]),

    h1('Maintenance'),
    h2('Mises à jour'),
    ul([
      '**Dépendances** : surveiller les avis de sécurité de Django, Django REST Framework et Angular ; planifier la montée de version d\'Angular 17 (des vulnérabilités sont signalées par `npm audit`).',
      '**Procédure de modification** : modifier le code, lancer l\'ensemble des contrôles (`python manage.py test tests`, `makemigrations --check`, `npm run build`, `tsc -p tsconfig.spec.json`), puis envoyer sur `main` : Vercel déploie et applique les migrations.',
      '**Base de données** : toute évolution de structure passe par une migration versionnée ; ne jamais modifier la base à la main.',
    ]),
    h2('Corrections et évolutions possibles'),
    ul([
      'Génération d\'un PDF de l\'acte par le serveur, après approbation du modèle officiel.',
      'Procédure de rectification et mentions marginales après validation.',
      'Réinitialisation du mot de passe par e-mail.',
      'Cache partagé pour la limitation du débit, et supervision (alertes d\'erreurs, journal technique centralisé).',
      'Reprise de données historiques depuis les registres papier.',
      'Autres actes d\'état civil (mariage, décès).',
    ]),
    h2('Exploitation courante'),
    ul([
      'Vérifier chaque semaine la sauvegarde de la base et la place disponible.',
      'Revoir les comptes actifs et les droits au moins chaque trimestre ; désactiver les comptes inutilisés.',
      'Tenir un registre d\'exploitation (incidents, restaurations, mises à jour) : voir le document 04.',
    ]),

    h1('Annexes'),
    h2('Annexe A — Dictionnaire des données'),
    p('Structure exacte des tables au moment de la livraison, produite à partir des modèles. Les colonnes communes à toutes les tables métier (`uuid`, dates, auteurs, archivage) sont décrites dans les conventions du chapitre 7 et ne sont pas répétées table par table.'),
    ...dico.blocks,
    h2('Annexe B — Commandes de gestion'),
    table({
      head: ['Commande', 'Rôle'], widths: [4, 6], small: true,
      rows: [
        ['`python manage.py migrate`', 'Applique les migrations de la base'],
        ['`python manage.py setup_initial_data`', 'Crée (sans doublon) permissions, rôles, paramètres, comptes de départ et établissements de Ratoma (une seule fois). Option `--no-hospitals` pour ignorer les établissements'],
        ['`python manage.py seed_hospitals`', 'Préremplit à la demande les établissements de Ratoma'],
        ['`python manage.py seed_demo --count 45`', 'Données de **démonstration fictives** ; refusée si `DEBUG=False`'],
        ['`python manage.py backup_wakara --output-dir <dossier> --keep 30`', 'Sauvegarde la base et les pièces dans une archive datée'],
        ['`python manage.py restore_wakara <archive> --yes`', 'Restaure une archive (arrêter l\'application avant)'],
        ['`python manage.py check --deploy`', 'Contrôle des réglages de production'],
        ['`python manage.py test tests`', 'Lance les 161 tests automatisés'],
      ],
    }),
    h2('Annexe C — Glossaire'),
    table({
      head: ['Terme', 'Définition'], widths: [2.4, 7.6], small: true,
      rows: [
        ['CECI', 'Centre d\'état civil et de l\'identification de Ratoma'],
        ['Déclaration', 'Dossier saisi à partir de la fiche reçue de l\'hôpital ; une déclaration = un enfant'],
        ['Acte', 'Acte de naissance établi à partir de la déclaration, avec son numéro officiel'],
        ['Référence', 'Numéro de suivi interne `WKR-AAAA-NNNN`, différent du numéro officiel de l\'acte'],
        ['NPI', 'Numéro personnel d\'identification (texte libre dans la version 1.0)'],
        ['Duplicata', 'Délivrance d\'un acte déjà délivré auparavant'],
        ['JWT', 'Jeton signé qui prouve l\'identité de l\'utilisateur pendant une durée limitée'],
        ['Migration', 'Fichier versionné qui fait évoluer la structure de la base de données'],
        ['Ajout seul', 'Table où l\'on peut seulement ajouter des lignes, jamais les modifier ni les effacer'],
      ],
    }),
    h2('Annexe D — Références'),
    ul([
      `Dépôt du code : ${META.depot}`,
      'Documentation du dépôt : dossier `docs/` (installation, architecture, configuration, déploiement, sauvegarde, décisions métier).',
      'Autres documents du dossier : 01 cahier des charges, 03 manuel utilisateur, 04 guide d\'installation et d\'exploitation, 05 rapport de tests, 06 PV de recette, 07 PV de livraison.',
    ]),
  ],
};
