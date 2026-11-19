// Dictionnaire des données : construit à partir de donnees-schema.json (structure réelle des modèles)
// et des descriptions ci-dessous. Si un champ n'a pas de description, le build le signale.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(HERE, 'donnees-schema.json'), 'utf-8'));

const TYPES = {
  CharField: (f) => `Texte (${f.max})`, EmailField: () => 'E-mail', TextField: () => 'Texte long', DateField: () => 'Date',
  DateTimeField: () => 'Date et heure', TimeField: () => 'Heure', BooleanField: () => 'Oui / non', UUIDField: () => 'UUID',
  BigAutoField: () => 'Entier (auto)', PositiveIntegerField: () => 'Entier', PositiveSmallIntegerField: () => 'Entier',
  BigIntegerField: () => 'Entier (long)', IntegerField: () => 'Entier', FloatField: () => 'Nombre décimal',
  JSONField: () => 'JSON', GenericIPAddressField: () => 'Adresse IP', BinaryField: () => 'Binaire', FileField: () => 'Fichier',
  ForeignKey: (f) => `Lien → ${f.rel}`, OneToOneField: (f) => `Lien 1-1 → ${f.rel}`,
};

const MODELS = {
  CustomUser: ['Utilisateur', 'Compte de connexion (identifiant, coordonnées, état du compte).'],
  Role: ['Rôle', 'Ensemble de permissions (administrateur, secrétaire, agent de collecte, ou rôle créé par l\'administrateur).'],
  Permission: ['Permission', 'Droit élémentaire (40 au catalogue), identifié par un code.'],
  RolePermission: ['Permission d\'un rôle', 'Associe un rôle à une permission.'],
  UserRole: ['Rôle d\'un utilisateur', 'Associe un utilisateur à un rôle, avec l\'auteur et la date de l\'attribution.'],
  UserPermission: ['Ajustement de permission', 'Permission accordée ou retirée à un utilisateur en plus (ou à la place) de ses rôles.'],
  Hospital: ['Établissement de santé', 'Hôpital, maternité ou centre de santé qui déclare des naissances.'],
  ReferenceCounter: ['Compteur de références', 'Compteur verrouillé qui produit les références WKR-AAAA-NNNN et les codes d\'établissement.'],
  Declaration: ['Déclaration de naissance', 'Dossier central : statut, établissement, dates de réception, transmission et validation.'],
  Child: ['Enfant', 'Enfant concerné par la déclaration (une seule fiche par déclaration).'],
  Parent: ['Parent', 'Père ou mère de l\'enfant (au plus un de chaque type par déclaration).'],
  Declarant: ['Déclarant', 'Personne qui déclare la naissance (père, mère ou autre).'],
  StatusHistory: ['Historique des statuts', 'Chaque changement de statut d\'un dossier (ajout seul).'],
  Acte: ['Acte de naissance', 'Références du registre, numéro officiel, circonscription et mentions (un acte par déclaration).'],
  NumberSequence: ['Séquence de numéros', 'Dernier numéro attribué par année et registre (numérotation automatique, si activée).'],
  PrintLog: ['Impression', 'Chaque impression d\'un acte, avec son numéro de copie.'],
  Delivery: ['Délivrance', 'Remise d\'un acte à un bénéficiaire ; duplicata si ce n\'est pas la première.'],
  StoredFile: ['Fichier stocké', 'Contenu binaire d\'une pièce lorsque les pièces sont conservées dans la base.'],
  SupportingDocument: ['Pièce justificative', 'Photo ou fichier joint à un dossier (fiche physique, pièce d\'identité).'],
  AuditLog: ['Journal d\'audit', 'Trace de chaque opération : auteur, action, objet, modifications, motif, adresse IP (ajout seul).'],
  LoginAttempt: ['Tentatives de connexion', 'Mots de passe erronés d\'un compte depuis une adresse : le verrouillage est tenu par couple (compte, adresse).'],
  RevokedAccessToken: ['Jeton d\'accès révoqué', 'Jeton d\'accès arrêté par une déconnexion : refusé jusqu\'à son expiration naturelle, puis la ligne est purgée.'],
  TwoFactorBackupCode: ['Code de secours (double authentification)', 'Code à usage unique qui remplace l\'application d\'authentification en cas de perte du téléphone ; seule une empreinte est conservée.'],
  Device: ['Appareil hors connexion', 'Navigateur ou téléphone d\'un utilisateur qui travaille hors connexion ; révocable par l\'administrateur. Porte aussi le code de récupération (chiffré).'],
  SyncOperation: ['Opération synchronisée', 'Trace de chaque opération reçue d\'un appareil et de ce que le serveur en a fait (le contenu n\'est pas conservé : seule son empreinte).'],
  DuplicateCounter: ['Compteur des dossiers de doublons', 'Compteur verrouillé qui produit les références DUP-AAAA-NNNN.'],
  BirthIdentity: ['Identité normalisée d\'une naissance', 'Version normalisée (sans accents ni majuscules, formes phonétiques) des informations d\'une déclaration, servant uniquement à la comparaison. Les données saisies ne sont jamais modifiées.'],
  DuplicateCheck: ['Analyse de doublons', 'Chaque analyse faite sur une déclaration : déclencheur, candidats examinés, meilleur score (ajout seul).'],
  DuplicateMatch: ['Correspondance', 'Ressemblance trouvée entre deux déclarations : score sur 100, critères, niveau de risque, signaux d\'alerte.'],
  DuplicateCase: ['Dossier d\'investigation', 'Dossier DUP-AAAA-NNNN ouvert pour une correspondance moyenne ou élevée, jusqu\'à la décision d\'un responsable.'],
  DuplicateDecision: ['Décision sur un dossier de doublons', 'Décision humaine motivée, avec son auteur et la date (ajout seul).'],
  DuplicateEvidence: ['Élément de preuve', 'Observation, vérification ou pièce ajoutée à un dossier d\'investigation.'],
  DuplicateReviewHistory: ['Historique d\'un dossier de doublons', 'Chaque action sur un dossier d\'investigation (prise en charge, observation, décision, réouverture).'],
  SiteSetting: ['Paramètre du site', 'Paramètre modifiable dans l\'application (textes de connexion, valeurs par défaut).'],
};

// description commune à plusieurs tables
const COMMON = {
  id: 'Identifiant interne', uuid: 'Identifiant technique exposé par l\'API',
  created_at: 'Date de création (posée par le serveur)', updated_at: 'Date de dernière modification (posée par le serveur)',
  created_by: 'Auteur de la création (posé par le serveur)', updated_by: 'Auteur de la dernière modification (posé par le serveur)',
  is_archived: 'Archivage logique (jamais de suppression)', archived_at: 'Date d\'archivage', archived_by: 'Auteur de l\'archivage',
  first_names: 'Prénoms', last_name: 'Nom', nationality: 'Nationalité (texte libre ou liste des pays)',
  npi: 'Numéro personnel d\'identification (texte libre, 50 caractères)', phone: 'Téléphone, enregistré au format +224 624 62 94 77',
  address: 'Adresse / domicile', profession: 'Profession', id_type: 'Type de pièce d\'identité', id_number: 'Numéro de la pièce d\'identité',
  birth_place: 'Lieu de naissance', email: 'Adresse e-mail', name: 'Libellé', is_active: 'Actif (oui) ou désactivé (non)',
  declaration: 'Déclaration concernée', user: 'Utilisateur concerné', role: 'Rôle concerné', permission: 'Permission concernée',
  description: 'Description', key: 'Clé', value: 'Valeur',
};

const SPECIFIC = {
  'CustomUser.password': 'Empreinte du mot de passe (jamais le mot de passe en clair)',
  'CustomUser.username': 'Identifiant de connexion', 'CustomUser.is_superuser': 'Compte de maintenance Django (aucun droit métier)',
  'CustomUser.is_staff': 'Accès à l\'administration Django (maintenance)', 'CustomUser.last_login': 'Dernière connexion',
  'CustomUser.date_joined': 'Date de création du compte', 'CustomUser.first_name': 'Prénom', 'CustomUser.hospital': 'Établissement de rattachement (facultatif)',
  'CustomUser.must_change_password': 'Oui : le mot de passe doit être changé avant toute action',
  'CustomUser.failed_login_count': 'Nombre d\'échecs de connexion consécutifs', 'CustomUser.locked_until': 'Compte verrouillé jusqu\'à cette date',
  'Role.codename': 'Code technique du rôle', 'Role.name': 'Nom du rôle', 'Role.is_system': 'Rôle système, protégé',
  'Permission.codename': 'Code de la permission (ex. dossier.validate)', 'Permission.name': 'Libellé affiché', 'Permission.category': 'Famille de permissions',
  'UserRole.is_active': 'Attribution en vigueur', 'UserRole.assigned_at': 'Date de l\'attribution', 'UserRole.assigned_by': 'Auteur de l\'attribution',
  'UserPermission.granted': 'Oui : permission accordée ; non : permission retirée', 'UserPermission.set_by': 'Auteur de l\'ajustement',
  'Hospital.code': 'Code automatique WH-0001-26 (non modifiable)', 'Hospital.name': 'Nom de l\'établissement', 'Hospital.facility_type': 'Type (hôpital, maternité, centre de santé…)',
  'Hospital.region': 'Région', 'Hospital.commune': 'Commune', 'Hospital.contact_name': 'Personne à contacter', 'Hospital.is_active': 'Établissement actif ou désactivé',
  'ReferenceCounter.key': 'Nature et année du compteur', 'ReferenceCounter.value': 'Dernière valeur attribuée',
  'Declaration.reference': 'Référence de suivi interne WKR-AAAA-NNNN (unique)', 'Declaration.status': 'Statut dans le circuit (voir chapitre Workflow)',
  'Declaration.hospital': 'Établissement déclarant (peut être vide)', 'Declaration.hospital_document_ref': 'Référence du document remis par l\'hôpital',
  'Declaration.doctor_name': 'Médecin', 'Declaration.midwife_name': 'Sage-femme', 'Declaration.birth_date': 'Date de naissance de l\'enfant',
  'Declaration.birth_time': 'Heure de naissance', 'Declaration.birth_place': 'Lieu de naissance', 'Declaration.notes': 'Observations',
  'Declaration.received_at': 'Date de réception du dossier', 'Declaration.assigned_to': 'Responsable actuel du dossier',
  'Declaration.last_decision_reason': 'Dernier motif de retour ou de rejet', 'Declaration.transmitted_at': 'Date de transmission au secrétariat',
  'Declaration.validated_at': 'Date de validation définitive', 'Declaration.validated_by': 'Administrateur qui a validé',
  'Child.declaration': 'Déclaration (une seule fiche enfant)', 'Child.gender': 'Sexe (M ou F)', 'Child.birth_rank': 'Rang de naissance chez la mère (1 = premier enfant)',
  'Parent.parent_type': 'FATHER (père) ou MOTHER (mère)', 'Parent.date_of_birth': 'Date de naissance', 'Parent.age': 'Âge (calculé à la saisie, modifiable)',
  'Declarant.declaration': 'Déclaration (un seul déclarant)', 'Declarant.relationship': 'Lien avec l\'enfant (père, mère, autre)',
  'StatusHistory.from_status': 'Statut de départ', 'StatusHistory.to_status': 'Nouveau statut', 'StatusHistory.changed_by': 'Auteur du changement',
  'StatusHistory.changed_at': 'Date et heure du changement', 'StatusHistory.reason': 'Motif (obligatoire pour retours et rejets)',
  'Acte.declaration': 'Déclaration (un seul acte)', 'Acte.annee': 'Année du registre', 'Acte.registre': 'Registre', 'Acte.feuillet': 'Feuillet',
  'Acte.numero_acte': 'Numéro officiel de l\'acte (unique par année et registre)', 'Acte.numero_assigned_at': 'Date d\'attribution du numéro',
  'Acte.numero_assigned_by': 'Administrateur qui a attribué le numéro', 'Acte.region': 'Région administrative', 'Acte.prefecture': 'Préfecture',
  'Acte.commune': 'Commune', 'Acte.centre': 'Centre d\'état civil', 'Acte.declaration_date': 'Date de la déclaration', 'Acte.officer_name': 'Officier d\'état civil (mention)',
  'Acte.mentions': 'Mentions complémentaires',
  'NumberSequence.annee': 'Année', 'NumberSequence.registre': 'Registre', 'NumberSequence.last_value': 'Dernier numéro attribué',
  'PrintLog.acte': 'Acte imprimé', 'PrintLog.printed_by': 'Auteur de l\'impression', 'PrintLog.printed_at': 'Date et heure de l\'impression', 'PrintLog.copy_number': 'Numéro de la copie',
  'Delivery.acte': 'Acte délivré', 'Delivery.delivered_at': 'Date et heure de la remise', 'Delivery.recipient_name': 'Bénéficiaire (remis à)',
  'Delivery.recipient_relationship': 'Qualité du bénéficiaire', 'Delivery.recipient_id_type': 'Type de pièce du bénéficiaire', 'Delivery.recipient_id_number': 'Numéro de la pièce',
  'Delivery.is_duplicate': 'Oui : duplicata (déjà délivré auparavant)', 'Delivery.notes': 'Observations', 'Delivery.delivered_by': 'Agent qui a délivré',
  'StoredFile.name': 'Nom aléatoire du fichier (non devinable)', 'StoredFile.content': 'Contenu du fichier', 'StoredFile.size': 'Taille en octets',
  'SupportingDocument.kind': 'Nature (PAPER_FORM : fiche physique, ou autre pièce)', 'SupportingDocument.file': 'Emplacement du fichier (privé)',
  'SupportingDocument.original_name': 'Nom d\'origine du fichier', 'SupportingDocument.content_type': 'Type de fichier contrôlé', 'SupportingDocument.size': 'Taille en octets',
  'SupportingDocument.sha256': 'Empreinte SHA-256 du contenu', 'SupportingDocument.description': 'Description', 'SupportingDocument.uploaded_by': 'Auteur de l\'ajout',
  'AuditLog.user': 'Auteur (lien)', 'AuditLog.username': 'Identifiant de l\'auteur, conservé tel quel', 'AuditLog.action': 'Type d\'action (connexion, création, modification, validation…)',
  'AuditLog.object_type': 'Type d\'objet concerné', 'AuditLog.object_id': 'Identifiant de l\'objet', 'AuditLog.object_repr': 'Description lisible de l\'objet',
  'AuditLog.changes': 'Modifications champ par champ (ancienne et nouvelle valeur)', 'AuditLog.reason': 'Motif', 'AuditLog.ip_address': 'Adresse IP du client',
  'AuditLog.user_agent': 'Navigateur utilisé', 'AuditLog.created_at': 'Date et heure de l\'opération',
  'SiteSetting.key': 'Clé du paramètre', 'SiteSetting.value': 'Valeur', 'SiteSetting.is_public': 'Visible sur la page de connexion', 'SiteSetting.updated_by': 'Auteur de la modification',
};

const dupSide = (who, label) => ({
  [`BirthIdentity.${who}_name_key`]: `Nom et prénoms ${label}, normalisés`, [`BirthIdentity.${who}_phonetic`]: `Forme phonétique du nom ${label}`,
  [`BirthIdentity.${who}_dob`]: `Date de naissance ${label}`, [`BirthIdentity.${who}_birth_place_norm`]: `Lieu de naissance ${label}, normalisé`,
  [`BirthIdentity.${who}_phone_norm`]: `Téléphone ${label}, normalisé (indicatif 224)`, [`BirthIdentity.${who}_address_norm`]: `Domicile ${label}, normalisé`,
  [`BirthIdentity.${who}_id_norm`]: `Numéro de pièce ou NPI ${label}, normalisé`,
});
Object.assign(SPECIFIC, {
  'CustomUser.session_version': 'Version des sessions : augmente à chaque changement de mot de passe ou désactivation, les jetons plus anciens sont refusés',
  'CustomUser.totp_secret': 'Secret de la double authentification, chiffré (jamais en clair)', 'CustomUser.two_factor_enabled': 'Oui : le code de l\'application d\'authentification est demandé à la connexion',
  'CustomUser.two_factor_enabled_at': 'Date d\'activation de la double authentification', 'CustomUser.totp_last_step': 'Dernier code accepté (un code ne sert qu\'une fois)',
  'LoginAttempt.ip_address': 'Adresse du client', 'LoginAttempt.failed_count': 'Échecs consécutifs depuis cette adresse', 'LoginAttempt.locked_until': 'Adresse verrouillée jusqu\'à cette date',
  'RevokedAccessToken.jti': 'Identifiant du jeton arrêté', 'RevokedAccessToken.expires_at': 'Date d\'expiration naturelle du jeton (la ligne est ensuite purgée)',
  'TwoFactorBackupCode.code_hash': 'Empreinte du code (le code n\'est affiché qu\'une fois)', 'TwoFactorBackupCode.used_at': 'Date d\'utilisation (vide : encore valable)',
  'Declaration.sync_version': 'Numéro de version, augmenté à chaque modification : détecte les conflits avec un appareil hors connexion',
  'Declaration.device_created_at': 'Date de saisie sur l\'appareil (après contrôle de l\'horloge)', 'Declaration.device_transmitted_at': 'Date de la dernière transmission faite depuis un appareil hors connexion',
  'Parent.marital_status': 'Situation matrimoniale', 'Declarant.marital_status': 'Situation matrimoniale',
  'Acte.commune_type': 'Commune urbaine ou rurale', 'Acte.centre_type': 'Centre principal ou secondaire',
  'AuditLog.origin': 'Origine : « offline » pour un événement appliqué par la synchronisation', 'AuditLog.device_id': 'Appareil concerné (hors connexion)',
  'AuditLog.sync_op_id': 'Opération de synchronisation concernée', 'AuditLog.device_time': 'Date de l\'action sur l\'appareil',
  'Device.device_id': 'Identifiant aléatoire de l\'appareil', 'Device.label': 'Libellé (ex. Chrome · Android)', 'Device.user_agent': 'Navigateur utilisé',
  'Device.last_seen_at': 'Dernier contact', 'Device.last_sync_at': 'Dernière synchronisation', 'Device.is_revoked': 'Oui : le serveur refuse tout ce que cet appareil envoie',
  'Device.revoked_at': 'Date de la révocation', 'Device.revoked_by': 'Administrateur qui a révoqué', 'Device.recovery_blob': 'Code de récupération de l\'appareil, chiffré (lisible seulement par l\'administrateur habilité, avec journal)',
  'Device.recovery_set_at': 'Date d\'enregistrement du code de récupération', 'Device.recovery_revealed_at': 'Date de la dernière communication du code à l\'agent', 'Device.recovery_revealed_by': 'Administrateur qui l\'a communiqué',
  'SyncOperation.op_id': 'Identifiant de l\'opération, créé sur l\'appareil (rejouer ne crée jamais de doublon)', 'SyncOperation.device': 'Appareil d\'origine',
  'SyncOperation.op_type': 'Type (création, modification, transmission, changement d\'étape, pièce)', 'SyncOperation.entity_uuid': 'Objet concerné', 'SyncOperation.declaration_uuid': 'Déclaration concernée',
  'SyncOperation.payload_hash': 'Empreinte du contenu reçu', 'SyncOperation.status': 'Résultat : appliquée, refusée ou conflit', 'SyncOperation.result': 'Résumé du résultat', 'SyncOperation.error': 'Motif en cas de refus ou de conflit',
  'SyncOperation.device_time': 'Date sur l\'appareil, telle que reçue', 'SyncOperation.effective_time': 'Date retenue après contrôle de l\'horloge', 'SyncOperation.clock_skew_seconds': 'Écart mesuré entre l\'horloge de l\'appareil et le serveur (secondes)',
  'SyncOperation.date_anomaly': 'Anomalie de date constatée (horloge corrigée, date future, saisie ancienne…)', 'SyncOperation.attempts': 'Nombre de tentatives', 'SyncOperation.received_at': 'Date de réception par le serveur', 'SyncOperation.applied_at': 'Date d\'application',
  'BirthIdentity.child_name_key': 'Nom et prénoms de l\'enfant, normalisés', 'BirthIdentity.child_phonetic': 'Forme phonétique du nom de l\'enfant', 'BirthIdentity.gender': 'Sexe', 'BirthIdentity.birth_date': 'Date de naissance',
  'BirthIdentity.birth_time': 'Heure de naissance', 'BirthIdentity.birth_rank': 'Rang de naissance', 'BirthIdentity.birth_place_norm': 'Lieu de naissance, normalisé', 'BirthIdentity.hospital': 'Établissement',
  'BirthIdentity.hospital_ref_norm': 'Référence hospitalière, normalisée', 'BirthIdentity.data_hash': 'Empreinte des données comparées (détecte un changement)', 'BirthIdentity.data_quality': 'Qualité des données (0 à 100)',
  'BirthIdentity.missing_fields': 'Critères non renseignés', 'BirthIdentity.engine_version': 'Version du moteur de comparaison', 'BirthIdentity.computed_at': 'Date du calcul',
  ...dupSide('mother', 'de la mère'), ...dupSide('father', 'du père'),
  'DuplicateCheck.trigger': 'Déclencheur (création, modification, synchronisation, validation, manuel)', 'DuplicateCheck.identity_hash': 'Empreinte de l\'identité analysée', 'DuplicateCheck.performed_by': 'Auteur de l\'analyse',
  'DuplicateCheck.performed_at': 'Date de l\'analyse', 'DuplicateCheck.candidates_examined': 'Candidats comparés', 'DuplicateCheck.candidates_truncated': 'Oui : un plafond a limité la recherche (journalisé)',
  'DuplicateCheck.matches_found': 'Correspondances trouvées', 'DuplicateCheck.highest_score': 'Meilleur score', 'DuplicateCheck.data_quality': 'Qualité des données', 'DuplicateCheck.engine_version': 'Version du moteur', 'DuplicateCheck.config_snapshot': 'Réglages en vigueur au moment de l\'analyse',
  'DuplicateMatch.pair_key': 'Clé du couple de déclarations', 'DuplicateMatch.candidate': 'Déclaration ressemblante', 'DuplicateMatch.analysis': 'Analyse qui l\'a trouvée', 'DuplicateMatch.score': 'Score sur 100 (aide à la décision)',
  'DuplicateMatch.raw_points': 'Points obtenus', 'DuplicateMatch.comparable_points': 'Points réellement comparables', 'DuplicateMatch.data_quality': 'Qualité des données comparées', 'DuplicateMatch.risk_level': 'Niveau : faible, moyen ou élevé',
  'DuplicateMatch.criteria': 'Détail critère par critère', 'DuplicateMatch.flags': 'Signaux (naissance multiple possible, données insuffisantes…)', 'DuplicateMatch.candidate_has_official_act': 'Oui : la déclaration ressemblante porte déjà un acte numéroté',
  'DuplicateMatch.declaration_hash': 'Empreinte de la déclaration au moment de l\'analyse', 'DuplicateMatch.candidate_hash': 'Empreinte de l\'autre déclaration', 'DuplicateMatch.detected_at': 'Date de détection',
  'DuplicateCase.reference': 'Référence DUP-AAAA-NNNN', 'DuplicateCase.pair_key': 'Clé du couple de déclarations', 'DuplicateCase.match': 'Correspondance d\'origine', 'DuplicateCase.other_declaration': 'Autre déclaration du couple',
  'DuplicateCase.risk_level': 'Niveau de risque', 'DuplicateCase.score': 'Score', 'DuplicateCase.anomaly_type': 'Nature de l\'anomalie', 'DuplicateCase.status': 'État du dossier (ouvert, en cours, résolu…)', 'DuplicateCase.assigned_to': 'Responsable de l\'investigation',
  'DuplicateCase.detected_at': 'Date de détection', 'DuplicateCase.resolved_at': 'Date de résolution', 'DuplicateCase.final_decision': 'Décision finale', 'DuplicateCase.resolution_hashes': 'Empreintes des données au moment de la décision',
  'DuplicateCase.principal_declaration': 'Déclaration principale retenue', 'DuplicateCase.duplicate_declaration': 'Déclaration redondante désignée',
  'DuplicateDecision.case': 'Dossier concerné', 'DuplicateDecision.decision': 'Décision (doublon confirmé, enfants distincts, naissance multiple, erreur de saisie…)', 'DuplicateDecision.reason': 'Motif obligatoire', 'DuplicateDecision.decided_by': 'Auteur',
  'DuplicateDecision.decided_by_name': 'Nom de l\'auteur, conservé tel quel', 'DuplicateDecision.decided_at': 'Date et heure', 'DuplicateDecision.principal_declaration': 'Déclaration principale', 'DuplicateDecision.duplicate_declaration': 'Déclaration redondante',
  'DuplicateDecision.resulting_status': 'Statut pris par la déclaration redondante (rejet motivé)',
  'DuplicateEvidence.case': 'Dossier concerné', 'DuplicateEvidence.kind': 'Nature (observation, vérification, pièce)', 'DuplicateEvidence.document': 'Pièce jointe', 'DuplicateEvidence.title': 'Titre', 'DuplicateEvidence.content': 'Contenu',
  'DuplicateEvidence.added_by': 'Auteur', 'DuplicateEvidence.added_by_name': 'Nom de l\'auteur, conservé tel quel', 'DuplicateEvidence.added_at': 'Date et heure',
  'DuplicateReviewHistory.case': 'Dossier concerné', 'DuplicateReviewHistory.action': 'Action', 'DuplicateReviewHistory.actor': 'Auteur', 'DuplicateReviewHistory.actor_name': 'Nom de l\'auteur, conservé tel quel',
  'DuplicateReviewHistory.at': 'Date et heure', 'DuplicateReviewHistory.note': 'Commentaire', 'DuplicateReviewHistory.detail': 'Détail de l\'action',
});

const COMMON_BUSINESS = new Set(['uuid', 'created_at', 'updated_at', 'created_by', 'updated_by', 'is_archived', 'archived_at', 'archived_by']);
const SKIP = new Set(['CustomUser.groups', 'CustomUser.user_permissions']);

export const missing = [];

/** Blocs de tableaux (un par modèle), groupés par domaine. */
export function dictionary(table, h3) {
  const blocks = [];
  const order = ['accounts', 'hospitals', 'declarations', 'actes', 'documents', 'audit', 'core', 'sync', 'duplicates'];
  const groups = { accounts: 'Utilisateurs, rôles et permissions', hospitals: 'Établissements', declarations: 'Déclarations', actes: 'Actes', documents: 'Pièces justificatives', audit: 'Audit', core: 'Paramètres', sync: 'Mode hors connexion', duplicates: 'Contrôle des doublons' };
  for (const app of order) {
    for (const m of SCHEMA.filter((x) => x.app === app)) {
      const [title, desc] = MODELS[m.model] || [m.model, ''];
      if (!MODELS[m.model]) missing.push('modèle ' + m.model);
      const business = m.fields.some((f) => f.name === 'is_archived');
      blocks.push(h3(`${title} — table ${m.table}`));
      blocks.push({ t: 'p', text: desc + (business ? ' Colonnes communes à toutes les tables métier (non répétées ci-dessous) : `id`, `uuid`, `created_at`, `updated_at`, `created_by`, `updated_by`, `is_archived`, `archived_at`, `archived_by`.' : ' Clé primaire : `id`.') });
      const rows = [];
      for (const f of m.fields) {
        const key = `${m.model}.${f.name}`;
        if (SKIP.has(key) || f.name === 'id') continue;
        if (business && COMMON_BUSINESS.has(f.name)) continue;
        const d = SPECIFIC[key] || COMMON[f.name];
        if (!d) missing.push(key);
        const typeFn = TYPES[f.type];
        if (!typeFn) missing.push('type ' + f.type);
        const notes = [];
        if (f.unique && f.name !== 'id') notes.push('unique');
        if (f.null) notes.push('facultatif');
        rows.push([`\`${f.name}\``, typeFn ? typeFn(f) : f.type, d || '', notes.join(', ')]);
      }
      blocks.push(table({ head: ['Champ', 'Type', 'Description', 'Contraintes'], widths: [2.3, 1.9, 4.6, 1.2], rows, small: true }));
    }
  }
  return { blocks, groups, count: SCHEMA.length };
}
