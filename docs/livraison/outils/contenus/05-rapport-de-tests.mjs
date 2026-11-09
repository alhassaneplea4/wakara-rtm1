import { h1, h2, h3, p, ul, ol, table, code, note } from '../dsl.mjs';
import { META } from '../meta.mjs';

const OK = 'Conforme';

export default {
  title: 'Rapport de tests',
  subtitle: 'Scénarios exécutés, résultats, anomalies corrigées et limites connues',
  audience: 'Client et prestataire',
  blocks: [
    h1('Objet et périmètre'),
    p(`Ce rapport présente les vérifications réalisées sur la version ${META.version} de Wakara avant sa remise à la ${META.clientCourt} : tests automatisés, contrôles de compilation, vérifications manuelles dans le navigateur et contrôles de sécurité. Il dit **ce qui a été vérifié, avec quel résultat**, mais aussi **ce qui ne l'a pas été**.`),
    p('Il prépare la recette (document 06) : la mairie y rejoue elle-même les scénarios essentiels avec ses propres utilisateurs. Le rapport ne remplace pas cette recette.'),

    h1('Environnement et méthode'),
    table({
      head: ['Élément', 'Valeur'], widths: [3, 7], zebra: false,
      rows: [
        ['Poste de test', 'Windows 11, données de démonstration fictives (aucune donnée réelle d\'état civil)'],
        ['Backend', 'Python 3.14, Django 5.2, Django REST Framework, base SQLite de test (recréée à chaque exécution)'],
        ['Frontend', 'Angular 17, TypeScript 5.3, compilation de production'],
        ['Date de la dernière exécution complète', '9 novembre 2026'],
        ['Commande des tests automatisés', '`python manage.py test tests` (dossier backend)'],
        ['Principe', 'Chaque règle métier et chaque règle de sécurité est vérifiée par un test qui l\'exerce à travers l\'API réelle, avec les vrais rôles (agent, secrétaire, administrateur) ; un test qui échoue bloque la livraison.'],
      ],
    }),

    h1('Synthèse des résultats'),
    table({
      head: ['Contrôle', 'Résultat'], widths: [5, 5], zebra: true,
      rows: [
        ['Tests automatisés du backend', '**161 tests, 161 réussis, 0 échec**'],
        ['Migrations de base de données (`makemigrations --check`)', 'Aucune migration manquante'],
        ['Compilation de production du frontend (`npm run build`)', 'Réussie, sans avertissement'],
        ['Compilation des tests unitaires du frontend (`tsc -p tsconfig.spec.json`)', 'Réussie'],
        ['Exécution des tests unitaires du frontend (Karma)', '**Non exécutés** — aucun navigateur de test disponible sur le poste de développement'],
        ['Vérifications manuelles dans le navigateur', 'Parcours des trois profils réalisés, sans défaut ouvert (voir le chapitre 6)'],
        ['Audit de sécurité interne', 'Réalisé ; points prioritaires corrigés ; quatre axes restent à approfondir (voir le chapitre 7)'],
        ['Test sur PostgreSQL de production, charge, concurrence', '**Non réalisés**'],
      ],
    }),

    h1('Tests automatisés du backend'),
    table({
      head: ['Domaine', 'Fichier', 'Tests', 'Ce qui est vérifié'], widths: [1.9, 2.4, 0.8, 5], small: true,
      rows: [
        ['Authentification, permissions', 'test_auth_permissions.py', '24', 'Connexion par identifiant ou e-mail ; erreur identique pour compte inconnu et mot de passe faux ; verrouillage après échecs ; compte désactivé refusé même avec un jeton déjà émis ; déconnexion ; changement de mot de passe obligatoire ; mots de passe faibles refusés ; aucun mot de passe dans le journal ; chaque rôle limité à ses droits ; refus par défaut ; anti-escalade de privilèges'],
        ['Circuit des dossiers', 'test_workflow.py', '26', 'Circuit complet agent → secrétariat → administrateur → délivrance ; seul l\'administrateur valide ou rejette ; statut non forçable ; transitions interdites refusées ; motif obligatoire ; retours collecte et secrétariat ; dossiers figés ; informations minimales exigées ; numérotation officielle (doublon refusé, numéro jamais écrasé) ; aperçu non officiel et impression refusée avant validation'],
        ['Intégrité, audit, pièces, statistiques', 'test_integrity.py', '24', 'Aucune suppression physique (l\'API archive) ; journal d\'audit et historique de statuts en ajout seul ; consultation et export du journal eux-mêmes tracés ; pièces justificatives (extension, signature de fichier, taille, accès filtré, téléchargement audité) ; statistiques égales aux données de la base'],
        ['Champs du formulaire', 'test_form_fields.py', '18', 'Téléphone guinéen au format normalisé ; numéros étrangers ; adresses e-mail ; âge, rang de naissance et dates bornés ; nationalité des parents et du déclarant ; audit des changements'],
        ['Durcissement sécurité', 'test_hardening.py', '13', 'Adresse IP du client non falsifiable (en-tête X-Forwarded-For) ; export CSV protégé contre les formules ; révocation des jetons après changement de mot de passe, réinitialisation ou désactivation ; compteur d\'échecs de connexion exact'],
        ['Délivrances et établissements', 'test_deliveries_hospitals.py', '12', 'Détail et compteurs des délivrances ; duplicata ; filtres du tableau de bord appliqués aux listes ; préremplissage unique des établissements de Ratoma, sans doublon ni recréation d\'un établissement archivé'],
        ['Fonctions du secrétariat', 'test_secretary_features.py', '12', 'NPI ; avertissement et confirmation si des champs sont vides à la validation ; liste des actes limitée aux actes validés ; gestion des établissements par le secrétaire et pas par l\'agent ; périodes du tableau de bord'],
        ['Historiques des actes', 'test_dossier_history.py', '11', 'Réservé à l\'administrateur ; chronologie en français clair ; ancienne et nouvelle valeur ; recherche et filtres ; dossiers archivés toujours lisibles'],
        ['Notifications et file de travail', 'test_notifications.py', '8', 'Pastilles du menu selon le travail en attente de chaque profil ; traitement en une seule étape par le secrétariat ; l\'agent ne peut pas sauter le secrétariat'],
        ['Code des établissements', 'test_hospital_code.py', '5', 'Code WH-0001-26 généré, unique, non modifiable, remis à zéro chaque année'],
        ['Divers', 'test_misc.py', '5', 'Filtre « responsable » ; textes publics de la page de connexion ; paramètres protégés et audités ; comptes de départ créés sans doublon'],
        ['Stockage des pièces', 'test_storage.py', '2', 'Enregistrement et téléchargement authentifié des pièces dans la base'],
        ['Sauvegarde', 'test_backup.py', '1', 'Sauvegarde, corruption volontaire puis restauration (SQLite)'],
        ['**Total**', '', '**161**', ''],
      ],
    }),

    h1('Résultats par fonctionnalité demandée'),
    p('Pour chaque fonctionnalité du cahier des charges, le moyen de vérification est un test automatisé (nom du test) ou une vérification manuelle dans le navigateur.'),
    table({
      head: ['Fonctionnalité testée', 'Résultat attendu', 'Vérification', 'Résultat'], widths: [2.2, 3, 3.6, 1.2], small: true,
      rows: [
        ['Connexion', 'Accès à l\'espace de travail du profil ; erreur générique si échec', '`test_login_returns_tokens_and_profile`, `test_login_by_email`, `test_wrong_password_is_generic_401_and_audited`', OK],
        ['Verrouillage de compte', 'Blocage temporaire après des échecs répétés', '`test_account_locks_after_repeated_failures`', OK],
        ['Compte désactivé', 'Plus aucun accès, même avec un jeton déjà émis', '`test_inactive_account_cannot_login_nor_use_existing_token`', OK],
        ['Changement de mot de passe obligatoire', 'Aucune action métier avant le changement', '`test_must_change_password_blocks_business_api_until_changed`', OK],
        ['Création d\'une déclaration', 'Enregistrement réussi ; référence générée par le serveur', '`test_full_circuit_collection_secretariat_admin_delivery`, `test_cannot_create_with_forged_status_or_reference`', OK],
        ['Agent : ses dossiers seulement', 'L\'agent ne voit ni ne touche les dossiers des autres', '`test_agent_only_sees_and_touches_own_declarations`', OK],
        ['Transmission', 'Dossier visible au secrétariat ; informations minimales exigées', '`test_incomplete_declaration_cannot_be_transmitted`, `test_badges_follow_the_work_waiting_for_each_profile`', OK],
        ['Pièces justificatives', 'Fiche photographiée jointe ; fichiers dangereux refusés ; téléchargement tracé', '`test_paper_form_photo_is_attached_listed_and_archived_by_the_agent`, `test_dangerous_or_mismatched_files_rejected`', OK],
        ['Complément de l\'acte', 'Informations enregistrées par le secrétariat', '`test_secretary_can_correct_a_transmitted_dossier_and_it_stays_where_it_is`', OK],
        ['Soumission à validation', 'Refusée sans les informations requises', '`test_secretary_cannot_submit_acte_without_required_data`', OK],
        ['Validation définitive', 'Réservée à l\'administrateur technique', '`test_only_admin_can_validate_or_reject`, `test_agent_cannot_take_charge_or_submit`', OK],
        ['Numéro officiel', 'Saisi à la validation ; doublon refusé ; jamais écrasé', '`test_duplicate_number_in_same_registry_refused`, `test_number_never_overwritten_once_attributed`', OK],
        ['Validation avec champs vides', 'Avertissement sans rien écrire tant que non confirmé', '`test_validation_warns_about_empty_fields_and_writes_nothing_until_confirmed`', OK],
        ['Retour et rejet', 'Motif obligatoire ; dossier retourné à la bonne étape', '`test_rejection_and_corrections_require_a_reason`, `test_return_to_collection_then_back_through_the_circuit`', OK],
        ['Dossiers figés', 'Plus de modification après validation ou rejet', '`test_rejected_and_validated_dossiers_are_frozen`', OK],
        ['Aperçu, impression, délivrance', 'Filigrane avant validation ; impression et délivrance seulement après ; duplicata', '`test_preview_flagged_unofficial_and_print_refused_before_validation`, `test_a_second_delivery_is_a_duplicate_and_appears_in_the_other_deliveries`', OK],
        ['Suppression', 'Aucune suppression physique', '`test_model_and_queryset_deletes_are_blocked`, `test_api_delete_archives_instead_of_deleting`', OK],
        ['Journal d\'audit', 'Opérations historisées, journal non modifiable', '`test_audit_records_each_step`, `test_audit_log_cannot_be_modified_or_deleted`', OK],
        ['Historiques des actes', 'Administrateur seul ; qui a fait quoi, avant/après', '`test_only_the_administrator_can_read_the_histories`, `test_every_field_change_shows_before_and_after`', OK],
        ['Utilisateurs et rôles', 'Création, rôle, désactivation ; pas d\'auto-promotion', '`test_assigning_role_to_other_user_works_and_is_audited`, `test_admin_cannot_change_own_roles_or_permissions`', OK],
        ['Permissions par rôle', 'Chaque rôle limité à ses droits ; refus par défaut', '`test_each_role_gets_only_its_own_permissions`, `test_viewset_is_fail_closed_for_unmapped_actions`', OK],
        ['Établissements', 'Création, désactivation, archivage ; secrétaire autorisé, agent non', '`test_the_secretary_manages_the_health_facilities`, `test_the_agent_still_cannot_manage_them`', OK],
        ['Statistiques et tableau de bord', 'Chiffres égaux aux données ; cartes = listes', '`test_kpis_match_the_database`, `test_dashboard_filters_apply_to_the_acte_list`', OK],
        ['Téléphone, nationalité, âge', 'Formats contrôlés par l\'API', '`test_valid_phones_are_stored_in_the_canonical_format`, `test_age_rank_and_parent_birth_date_are_bounded`', OK],
        ['Export CSV', 'Réservé aux profils autorisés, sans injection de formules', '`test_export_restricted_to_authorised_profiles`, `test_declaration_export_neutralises_child_names`', OK],
        ['Sauvegarde / restauration', 'Aller-retour sans perte', '`test_backup_contains_a_consistent_database_and_documents`', 'Conforme (SQLite)'],
        ['Affichage mobile et écrans étroits', 'Pas de défilement horizontal, menu utilisable', 'Vérification manuelle (émulation de largeur)', 'Conforme'],
        ['Impression papier réelle de l\'acte', 'Rendu lisible sur le papier officiel', 'Non réalisée', '**Non testé**'],
      ],
    }),

    h1('Vérifications manuelles dans le navigateur'),
    p('Réalisées au fil du développement, avec l\'API réelle et des données de démonstration. Elles complètent les tests automatisés pour tout ce qui concerne l\'interface.'),
    table({
      head: ['Parcours vérifié', 'Résultat'], widths: [7.4, 2.6], small: true,
      rows: [
        ['Connexion sur ordinateur et sur écran de téléphone ; redirection selon les droits', OK],
        ['Toutes les entrées du menu, une à une : bonne page, données chargées, aucun message d\'erreur', OK],
        ['Déconnexion depuis le menu, le tiroir mobile et le menu du compte ; jetons effacés', OK],
        ['Circuit complet par l\'interface : création, transmission, prise en charge, complément, soumission, validation avec numéro, aperçu, délivrance', OK],
        ['Profil secrétaire : menu limité, pages réservées refusées, aucune action de décision', OK],
        ['Profil agent de collecte : uniquement ses dossiers, ni export ni gestion', OK],
        ['Pièces jointes : fichier falsifié refusé avec message ; PDF valide ajouté et ouvert', OK],
        ['Établissements : création, désactivation, archivage, restauration', OK],
        ['Création d\'un utilisateur : mot de passe faible refusé puis accepté ; rôle attribué', OK],
        ['Aperçu de l\'acte : modèle calqué sur la fiche officielle, filigrane « ACTE NON VALIDE », mention de l\'officier délégué', OK],
        ['Tableau de bord : filtres de période, cartes cliquables', OK],
        ['Historiques des actes : liste, recherche, histoire d\'un dossier', OK],
        ['Nouveau logo et icône de l\'application', OK],
      ],
    }),

    h1('Contrôles de sécurité'),
    p('Un audit de sécurité du code a été mené en plusieurs phases : cartographie de l\'application, recherche de failles par domaine, tentative de réfutation de chaque hypothèse, enregistrement des constats puis vérification. Il a été fait à partir du code source, sans attaque en conditions réelles.'),
    h3('Points corrigés'),
    ul([
      '**Adresse IP du client** : l\'en-tête `X-Forwarded-For` n\'est plus cru aveuglément ; le nombre de relais de confiance se règle (`NUM_PROXIES`). Le journal d\'audit et la limitation des tentatives de connexion ne peuvent plus être trompés.',
      '**Exports CSV** : les cellules qui ressemblent à des formules de tableur sont neutralisées.',
      '**Jetons de connexion** : révoqués lors d\'un changement de mot de passe, d\'une réinitialisation par l\'administrateur ou d\'une désactivation de compte.',
      '**Verrouillage de compte** : compteur d\'échecs exact même en cas de tentatives simultanées.',
    ]),
    h3('Points restant à approfondir'),
    ul([
      'Cycle de vie complet des jetons de connexion.',
      'Limitation générale du débit sur toute l\'API (aujourd\'hui limitée à la connexion).',
      'Ordre d\'écriture du journal d\'audit par rapport aux opérations.',
      'Vulnérabilités signalées par `npm audit` sur les bibliothèques de l\'interface (Angular 17) : mise à niveau à planifier.',
    ]),

    h1('Anomalies constatées et corrigées'),
    table({
      head: ['Constat', 'Cause', 'Correction'], widths: [3.2, 3.4, 3.4], small: true,
      rows: [
        ['Menu inactif ou déconnexion sans effet après le redémarrage du serveur', 'Onglet resté ouvert : pages chargées à la demande devenues introuvables', 'Page de connexion chargée d\'emblée ; déconnexion sans dépendance au réseau ; rechargement automatique de la page'],
        ['Tiroir de menu mobile rogné', 'Tout le panneau défilait', 'En-tête et pied fixes, seul le menu défile'],
        ['Messages d\'erreur avec noms techniques', 'Affichage brut de l\'API', 'Libellés en français'],
        ['Doublons dans le filtre « Responsable »', 'Tri ajouté à la requête', 'Requête corrigée et test ajouté'],
        ['Numéro saisi perdu à l\'actualisation automatique pendant la validation avec avertissement', 'Rafraîchissement toutes les 30 secondes', 'Actualisation suspendue pendant la confirmation'],
        ['Liste d\'historiques pouvant afficher un résultat périmé après deux filtres rapprochés', 'Réponses de requêtes qui se croisent', 'Requête précédente annulée'],
        ['Aperçu de l\'acte débordant sur les petits écrans', 'Filigrane trop large', 'Débordement masqué'],
        ['Chronologie de l\'historique dans le désordre pour des événements de la même seconde', 'Nouveau tri côté écran', 'Ordre du serveur conservé'],
      ],
    }),

    h1('Limites et points non vérifiés'),
    ul([
      '**Tests unitaires du frontend** : écrits et compilés, mais non exécutés (pas de navigateur de test sur le poste de développement). À lancer avec `npm test` sur un poste équipé de Chrome.',
      '**PostgreSQL de production** : les tests tournent sur SQLite. Les verrouillages de lignes, la sauvegarde `pg_dump` et la restauration `pg_restore` n\'ont pas été éprouvés ; la restauration doit être testée en recette (scénario E5).',
      '**Charge et concurrence** : aucun test avec de nombreux utilisateurs simultanés.',
      '**Impression réelle** sur papier et boîte de dialogue d\'impression du navigateur : non vérifiées.',
      '**Téléphones réels** : seule une émulation de largeur d\'écran a été utilisée.',
      '**Accessibilité** : bases respectées (étiquettes, navigation au clavier), pas d\'audit formel.',
      '**Données réelles** : aucune donnée réelle n\'a été utilisée ; la qualité des données de production dépend de la saisie.',
    ]),
    note('**Conclusion.** Les règles métier et les règles de sécurité essentielles sont vérifiées automatiquement et ne régressent pas. Les limites ci-dessus ne bloquent pas la recette, mais la restauration de sauvegarde sur PostgreSQL et l\'impression papier de l\'acte doivent être confirmées avant la mise en exploitation réelle.', 'ok'),

    h1('Comment rejouer les tests'),
    code(`cd backend
python -m venv venv && venv\\Scripts\\activate        # Linux/macOS : source venv/bin/activate
pip install -r requirements.txt
set SECRET_KEY=une-cle-de-test & set DEBUG=True      # Linux/macOS : export SECRET_KEY=... DEBUG=True
python manage.py test tests
python manage.py makemigrations --check

cd ../frontend
npm install
npm run build
npx tsc -p tsconfig.spec.json --noEmit`),
  ],
};
