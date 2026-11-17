"""
Duplicate-prevention models.

Mapping with the functional vocabulary (existing models are reused, not duplicated):
  BirthDeclaration  → ``declarations.Declaration``     (provisional declaration)
  BirthRecord       → ``actes.Acte``                    (official act, carries the official number)
  BirthIdentity     → ``BirthIdentity``                 normalised copy used for matching
  DuplicateCheck / DuplicateMatch / DuplicateCase / DuplicateDecision / DuplicateEvidence /
  DuplicateReviewHistory                                new here (offline synchronisation: the ``sync`` app)

Three identifiers never get mixed up: ``Declaration.uuid`` (technical, may be generated offline),
``Declaration.reference`` (provisional Wakara reference) and ``Acte.numero_acte`` (official number).

A score is NOT a legal decision. Nothing here deletes, merges or cancels a declaration or an act:
every decision is an append-only row with its reason and author.
"""
import uuid as uuid_lib

from django.conf import settings
from django.db import models
from django.db.models import Q

from core.mixins import AppendOnlyModel


class RiskLevel:
    HIGH = 'HIGH'
    MEDIUM = 'MEDIUM'
    LOW = 'LOW'
    CHOICES = [(HIGH, 'Risque élevé'), (MEDIUM, 'Risque moyen'), (LOW, 'Risque faible')]
    RANK = {HIGH: 3, MEDIUM: 2, LOW: 1}


class CaseStatus:
    OPEN = 'OPEN'                       # detected, waiting for someone to take it
    IN_REVIEW = 'IN_REVIEW'             # under investigation
    AWAITING_INFO = 'AWAITING_INFO'     # complementary verification requested
    RESOLVED = 'RESOLVED'
    CHOICES = [(OPEN, 'En attente de décision'), (IN_REVIEW, "En cours d'investigation"),
               (AWAITING_INFO, 'Vérification complémentaire'), (RESOLVED, 'Résolu')]
    UNRESOLVED = (OPEN, IN_REVIEW, AWAITING_INFO)


class Decision:
    CONFIRMED_DUPLICATE = 'CONFIRMED_DUPLICATE'
    DISTINCT_CHILDREN = 'DISTINCT_CHILDREN'
    MULTIPLE_BIRTH = 'MULTIPLE_BIRTH'
    DATA_ENTRY_ERROR = 'DATA_ENTRY_ERROR'
    INSUFFICIENT_INFO = 'INSUFFICIENT_INFO'
    FURTHER_VERIFICATION = 'FURTHER_VERIFICATION'
    CHOICES = [
        (CONFIRMED_DUPLICATE, 'Doublon confirmé'),
        (DISTINCT_CHILDREN, 'Deux enfants distincts'),
        (MULTIPLE_BIRTH, 'Naissance multiple'),
        (DATA_ENTRY_ERROR, 'Erreur de saisie'),
        (INSUFFICIENT_INFO, 'Informations insuffisantes'),
        (FURTHER_VERIFICATION, 'Vérification complémentaire nécessaire'),
    ]
    # Decisions that close the case, and those that keep it open (and the dossiers blocked).
    FINAL = (CONFIRMED_DUPLICATE, DISTINCT_CHILDREN, MULTIPLE_BIRTH, DATA_ENTRY_ERROR)
    NON_FINAL = (INSUFFICIENT_INFO, FURTHER_VERIFICATION)
    # Final decisions that designate one of the two dossiers as the redundant entry.
    DESIGNATES_DUPLICATE = (CONFIRMED_DUPLICATE, DATA_ENTRY_ERROR)


class AnomalyType:
    SIMILAR_IDENTITY = 'SIMILAR_IDENTITY'
    SYNC_CONFLICT = 'SYNC_CONFLICT'
    ACTE_EXISTS = 'ACTE_EXISTS'
    POSSIBLE_MULTIPLE_BIRTH = 'POSSIBLE_MULTIPLE_BIRTH'
    REPEATED_ENTRY = 'REPEATED_ENTRY'
    CHOICES = [
        (SIMILAR_IDENTITY, 'Identité similaire'),
        (SYNC_CONFLICT, 'Conflit de synchronisation'),
        (ACTE_EXISTS, 'Acte déjà établi'),
        (POSSIBLE_MULTIPLE_BIRTH, 'Naissance multiple possible'),
        (REPEATED_ENTRY, 'Saisie répétée'),
    ]


class DuplicateCounter(models.Model):
    """Row locks and numbering of this module (kept apart from the declaration reference counters)."""
    key = models.CharField(max_length=60, unique=True)
    value = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name = "Compteur / verrou"
        verbose_name_plural = "Compteurs / verrous"

    def __str__(self):
        return f"{self.key}={self.value}"


class BirthIdentity(models.Model):
    """Normalised, comparison-ready copy of a declaration. Rebuilt whenever the declaration changes."""
    declaration = models.OneToOneField(
        'declarations.Declaration', on_delete=models.PROTECT, related_name='identity')
    # child
    child_name_key = models.CharField(max_length=300, blank=True, db_index=True)
    child_phonetic = models.CharField(max_length=300, blank=True)
    gender = models.CharField(max_length=1, blank=True)
    birth_date = models.DateField(null=True, blank=True, db_index=True)
    birth_time = models.TimeField(null=True, blank=True)
    birth_rank = models.PositiveSmallIntegerField(null=True, blank=True)
    birth_place_norm = models.CharField(max_length=300, blank=True)
    hospital = models.ForeignKey('hospitals.Hospital', on_delete=models.SET_NULL, null=True, blank=True,
                                 related_name='+')
    hospital_ref_norm = models.CharField(max_length=120, blank=True)
    # mother
    mother_name_key = models.CharField(max_length=300, blank=True, db_index=True)
    mother_phonetic = models.CharField(max_length=300, blank=True, db_index=True)
    mother_dob = models.DateField(null=True, blank=True)
    mother_birth_place_norm = models.CharField(max_length=300, blank=True)
    mother_phone_norm = models.CharField(max_length=30, blank=True, db_index=True)
    mother_address_norm = models.CharField(max_length=400, blank=True)
    mother_id_norm = models.CharField(max_length=60, blank=True)
    # father
    father_name_key = models.CharField(max_length=300, blank=True)
    father_phonetic = models.CharField(max_length=300, blank=True)
    father_dob = models.DateField(null=True, blank=True)
    father_birth_place_norm = models.CharField(max_length=300, blank=True)
    father_phone_norm = models.CharField(max_length=30, blank=True)
    father_address_norm = models.CharField(max_length=400, blank=True)
    father_id_norm = models.CharField(max_length=60, blank=True)
    # quality of the information
    data_hash = models.CharField(max_length=64, db_index=True)
    data_quality = models.PositiveSmallIntegerField(default=0)   # 0..100, share of useful identity data
    missing_fields = models.JSONField(default=list, blank=True)
    engine_version = models.CharField(max_length=20, blank=True)
    computed_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Identité de naissance normalisée"
        verbose_name_plural = "Identités de naissance normalisées"

    def __str__(self):
        return f"Identité de {self.declaration.reference}"


class DuplicateCheck(AppendOnlyModel):
    """One automatic analysis of one declaration (append-only: kept as evidence of what was checked)."""
    TRIGGERS = [('CREATE', 'Création'), ('UPDATE', 'Modification'), ('SYNC', 'Synchronisation'),
                ('MANUAL', 'Analyse manuelle'), ('PRE_VALIDATION', 'Avant validation')]

    uuid = models.UUIDField(default=uuid_lib.uuid4, editable=False, unique=True)
    declaration = models.ForeignKey(
        'declarations.Declaration', on_delete=models.PROTECT, related_name='duplicate_checks')
    trigger = models.CharField(max_length=20, choices=TRIGGERS)
    identity_hash = models.CharField(max_length=64)
    performed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name='+')
    performed_at = models.DateTimeField(auto_now_add=True, db_index=True)
    candidates_examined = models.PositiveIntegerField(default=0)
    # True when a cap of the pre-filter was hit: the analysis was not exhaustive (the validation redoes it)
    candidates_truncated = models.BooleanField(default=False)
    matches_found = models.PositiveIntegerField(default=0)
    highest_score = models.FloatField(default=0)
    data_quality = models.PositiveSmallIntegerField(default=0)
    engine_version = models.CharField(max_length=20, blank=True)
    config_snapshot = models.JSONField(default=dict, blank=True)

    class Meta:
        verbose_name = "Analyse de doublons"
        verbose_name_plural = "Analyses de doublons"
        ordering = ['-performed_at', '-id']
        indexes = [models.Index(fields=['declaration', '-performed_at'])]

    def __str__(self):
        return f"Analyse {self.declaration.reference} ({self.performed_at:%Y-%m-%d %H:%M})"


class DuplicateMatch(models.Model):
    """Similarity between two declarations. One row per unordered pair; re-evaluated when data changes."""
    uuid = models.UUIDField(default=uuid_lib.uuid4, editable=False, unique=True)
    pair_key = models.CharField(max_length=64, unique=True)          # "<small id>-<large id>"
    declaration = models.ForeignKey(
        'declarations.Declaration', on_delete=models.PROTECT, related_name='duplicate_matches')
    candidate = models.ForeignKey(
        'declarations.Declaration', on_delete=models.PROTECT, related_name='duplicate_matches_as_candidate')
    analysis = models.ForeignKey(DuplicateCheck, on_delete=models.PROTECT, related_name='matches')
    score = models.FloatField(db_index=True)                         # normalised 0..100
    raw_points = models.FloatField(default=0)
    comparable_points = models.FloatField(default=0)                 # weight actually comparable
    data_quality = models.PositiveSmallIntegerField(default=0)       # comparable_points as a percentage
    risk_level = models.CharField(max_length=10, choices=RiskLevel.CHOICES, db_index=True)
    criteria = models.JSONField(default=dict, blank=True)
    flags = models.JSONField(default=dict, blank=True)
    candidate_has_official_act = models.BooleanField(default=False)
    declaration_hash = models.CharField(max_length=64, blank=True)
    candidate_hash = models.CharField(max_length=64, blank=True)
    detected_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Correspondance"
        verbose_name_plural = "Correspondances"
        ordering = ['-score', '-detected_at']

    def __str__(self):
        return f"{self.declaration.reference} ≈ {self.candidate.reference} ({self.score:.0f})"

    @staticmethod
    def make_pair_key(a_id: int, b_id: int) -> str:
        lo, hi = sorted((a_id, b_id))
        return f"{lo}-{hi}"


class DuplicateCase(models.Model):
    """Investigation file opened for a suspicious pair. Never deletes or merges anything."""
    uuid = models.UUIDField(default=uuid_lib.uuid4, editable=False, unique=True)
    reference = models.CharField(max_length=30, unique=True)         # DUP-YYYY-NNNN
    pair_key = models.CharField(max_length=64, db_index=True)
    match = models.ForeignKey(DuplicateMatch, on_delete=models.PROTECT, related_name='cases')
    declaration = models.ForeignKey(
        'declarations.Declaration', on_delete=models.PROTECT, related_name='duplicate_cases')
    other_declaration = models.ForeignKey(
        'declarations.Declaration', on_delete=models.PROTECT, related_name='duplicate_cases_as_other')
    risk_level = models.CharField(max_length=10, choices=RiskLevel.CHOICES, db_index=True)
    score = models.FloatField(default=0)
    anomaly_type = models.CharField(max_length=30, choices=AnomalyType.CHOICES, db_index=True)
    status = models.CharField(max_length=20, choices=CaseStatus.CHOICES, default=CaseStatus.OPEN, db_index=True)
    assigned_to = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name='+')
    detected_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    final_decision = models.CharField(max_length=30, choices=Decision.CHOICES, blank=True)
    # identity hashes of both declarations when the case was closed: a later data change can reopen the question
    resolution_hashes = models.JSONField(default=dict, blank=True)
    principal_declaration = models.ForeignKey(
        'declarations.Declaration', on_delete=models.PROTECT, null=True, blank=True,
        related_name='duplicate_cases_as_principal')
    duplicate_declaration = models.ForeignKey(
        'declarations.Declaration', on_delete=models.PROTECT, null=True, blank=True,
        related_name='duplicate_cases_as_duplicate')

    class Meta:
        verbose_name = "Dossier d'investigation"
        verbose_name_plural = "Dossiers d'investigation"
        ordering = ['-detected_at']
        constraints = [
            # at most one unresolved case per pair of declarations
            models.UniqueConstraint(fields=['pair_key'], condition=~Q(status='RESOLVED'),
                                    name='uniq_unresolved_case_per_pair'),
        ]

    def __str__(self):
        return self.reference

    @property
    def is_resolved(self) -> bool:
        return self.status == CaseStatus.RESOLVED


class DuplicateDecision(AppendOnlyModel):
    """An administrative decision on a case (append-only; a reason is mandatory)."""
    uuid = models.UUIDField(default=uuid_lib.uuid4, editable=False, unique=True)
    case = models.ForeignKey(DuplicateCase, on_delete=models.PROTECT, related_name='decisions')
    decision = models.CharField(max_length=30, choices=Decision.CHOICES)
    reason = models.TextField()
    decided_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='+')
    decided_by_name = models.CharField(max_length=200, blank=True)   # snapshot, survives account changes
    decided_at = models.DateTimeField(auto_now_add=True, db_index=True)
    principal_declaration = models.ForeignKey(
        'declarations.Declaration', on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    duplicate_declaration = models.ForeignKey(
        'declarations.Declaration', on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    resulting_status = models.CharField(max_length=20, choices=CaseStatus.CHOICES)

    class Meta:
        verbose_name = "Décision"
        verbose_name_plural = "Décisions"
        ordering = ['-decided_at', '-id']

    def __str__(self):
        return f"{self.case.reference}: {self.decision}"


class DuplicateEvidence(AppendOnlyModel):
    """Documents consulted, observations and verification requests attached to a case."""
    class Kind(models.TextChoices):
        DOCUMENT = 'DOCUMENT', 'Pièce justificative consultée'
        OBSERVATION = 'OBSERVATION', "Observation d'un agent"
        VERIFICATION_REQUEST = 'VERIFICATION_REQUEST', 'Demande de vérification complémentaire'
        VERIFICATION_RESULT = 'VERIFICATION_RESULT', 'Résultat de vérification'
        EXTERNAL_REFERENCE = 'EXTERNAL_REFERENCE', 'Référence externe (registre papier, hôpital…)'

    uuid = models.UUIDField(default=uuid_lib.uuid4, editable=False, unique=True)
    case = models.ForeignKey(DuplicateCase, on_delete=models.PROTECT, related_name='evidence')
    kind = models.CharField(max_length=30, choices=Kind.choices)
    declaration = models.ForeignKey(
        'declarations.Declaration', on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    document = models.ForeignKey(
        'documents.SupportingDocument', on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    title = models.CharField(max_length=200, blank=True)
    content = models.TextField(blank=True)
    added_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='+')
    added_by_name = models.CharField(max_length=200, blank=True)
    added_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "Preuve / pièce d'investigation"
        verbose_name_plural = "Preuves / pièces d'investigation"
        ordering = ['-added_at', '-id']


class DuplicateReviewHistory(AppendOnlyModel):
    """Complete, protected history of a case (creation, analyses, consultations, decisions…)."""
    class Action(models.TextChoices):
        CASE_OPENED = 'CASE_OPENED', 'Dossier ouvert'
        ANALYSIS_UPDATED = 'ANALYSIS_UPDATED', 'Analyse mise à jour'
        TAKEN = 'TAKEN', 'Pris en charge'
        ASSIGNED = 'ASSIGNED', 'Attribué'
        COMPARISON_VIEWED = 'COMPARISON_VIEWED', 'Comparaison consultée'
        DOCUMENT_VIEWED = 'DOCUMENT_VIEWED', 'Pièce consultée'
        OBSERVATION = 'OBSERVATION', 'Observation'
        VERIFICATION_REQUESTED = 'VERIFICATION_REQUESTED', 'Vérification demandée'
        DECISION = 'DECISION', 'Décision'
        REOPENED = 'REOPENED', 'Dossier rouvert'
        DATA_CHANGED = 'DATA_CHANGED', 'Données de la déclaration modifiées'

    case = models.ForeignKey(DuplicateCase, on_delete=models.PROTECT, related_name='history')
    action = models.CharField(max_length=30, choices=Action.choices)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name='+')
    actor_name = models.CharField(max_length=200, blank=True)      # "Système" when automatic
    at = models.DateTimeField(auto_now_add=True, db_index=True)
    note = models.TextField(blank=True)
    detail = models.JSONField(default=dict, blank=True)

    class Meta:
        verbose_name = "Historique d'examen"
        verbose_name_plural = "Historiques d'examen"
        ordering = ['at', 'id']
