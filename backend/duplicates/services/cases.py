"""
DuplicateCaseService — opening and keeping up to date the investigation cases, and the guard that
prevents the OFFICIAL validation of a dossier that is still under suspicion.

What is blocked is only the final validation (attribution of the official number). The normal circuit
(collection → secretariat → validation queue) is never stopped by a score: a case is the alert that sends
the dossier to a human, and only a human decision lifts the block.
"""
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from duplicates.config import effective_blocking_levels, get_config
from duplicates.models import (
    AnomalyType, CaseStatus, Decision, DuplicateCase, DuplicateCounter, DuplicateReviewHistory, RiskLevel,
)
from duplicates.services.audit import DuplicateAuditService

NUMBERING_LOCK = 'official-numbering'


def device_of(declaration):
    """Device (UUID string) that sent a declaration through the offline synchronisation, else ''."""
    if declaration.device_created_at is None:
        return ''
    from sync.models import SyncOperation
    device_uuid = (SyncOperation.objects.filter(declaration_uuid=declaration.uuid, op_type='declaration.create')
                   .values_list('device__device_id', flat=True).first())
    return str(device_uuid or 'appareil inconnu')


def next_case_reference() -> str:
    year = timezone.localdate().year
    counter, _ = DuplicateCounter.objects.select_for_update().get_or_create(key=f'duplicate-case-{year}')
    counter.value += 1
    counter.save(update_fields=['value'])
    return f"DUP-{year}-{counter.value:04d}"


class DuplicateCaseService:
    # ── classification ───────────────────────────

    @staticmethod
    def classify(match) -> str:
        flags = match.flags or {}
        act = flags.get('official_act', {})
        if act.get('candidate') or act.get('declaration'):
            return AnomalyType.ACTE_EXISTS
        if flags.get('twin_suspected'):
            return AnomalyType.POSSIBLE_MULTIPLE_BIRTH
        d, c = match.declaration, match.candidate
        offline = d.device_created_at is not None or c.device_created_at is not None
        if offline and (d.created_by_id != c.created_by_id or device_of(d) != device_of(c)):
            return AnomalyType.SYNC_CONFLICT
        if d.created_by_id and d.created_by_id == c.created_by_id:
            return AnomalyType.REPEATED_ENTRY
        return AnomalyType.SIMILAR_IDENTITY

    @staticmethod
    def unresolved_for_pair(pair_key):
        return DuplicateCase.objects.filter(pair_key=pair_key).exclude(status=CaseStatus.RESOLVED).first()

    # ── opening / refreshing ─────────────────────

    @classmethod
    def sync_case(cls, match, user=None, identity=None, other_identity=None):
        """
        Open a case for a MEDIUM/HIGH match, or refresh the unresolved case of the pair.
        Returns the unresolved case concerned, or None. Never closes a case by itself.
        """
        case = cls.unresolved_for_pair(match.pair_key)
        if match.risk_level not in (RiskLevel.HIGH, RiskLevel.MEDIUM):
            if case:
                cls._refresh(case, match, user)
            return case

        if case:
            cls._refresh(case, match, user)
            return case

        last = (DuplicateCase.objects.filter(pair_key=match.pair_key, status=CaseStatus.RESOLVED)
                .order_by('-resolved_at', '-id').first())
        if last:
            if last.final_decision in Decision.DESIGNATES_DUPLICATE:
                return None   # already settled: one of the two is formally the redundant entry
            if last.resolution_hashes == {'declaration': match.declaration_hash,
                                          'candidate': match.candidate_hash}:
                return None   # a human already ruled on exactly these data
        return cls.open_case(match, user=user, system=True,
                             note="Données modifiées depuis la décision précédente." if last else '')

    @classmethod
    @transaction.atomic
    def open_case(cls, match, user=None, system=True, note=''):
        existing = cls.unresolved_for_pair(match.pair_key)
        if existing:
            return existing
        case = DuplicateCase.objects.create(
            reference=next_case_reference(), pair_key=match.pair_key, match=match,
            declaration=match.declaration, other_declaration=match.candidate,
            risk_level=match.risk_level, score=match.score, anomaly_type=cls.classify(match),
            status=CaseStatus.OPEN)
        DuplicateAuditService.record(
            case, DuplicateReviewHistory.Action.CASE_OPENED, None if system else user,
            note=note or ("Dossier ouvert automatiquement après l'analyse." if system
                          else "Dossier ouvert manuellement."),
            detail={'score': match.score, 'risk_level': match.risk_level, 'anomaly_type': case.anomaly_type,
                    'data_quality': match.data_quality, 'opened_by': (user.username if user else None)})
        return case

    @classmethod
    def _refresh(cls, case, match, user):
        old = (case.score, case.risk_level)
        # the risk level kept on the case is the highest reached while it is unresolved: correcting the data
        # afterwards cannot silently lift the block, only a human decision can
        peak = max(case.risk_level, match.risk_level, key=lambda r: RiskLevel.RANK[r])
        changed = case.score != match.score or case.risk_level != peak
        case.score, case.risk_level = match.score, peak
        new_type = cls.classify(match)
        type_changed = new_type != case.anomaly_type
        case.anomaly_type = new_type
        case.match = match
        case.save()
        if changed or type_changed:
            DuplicateAuditService.record(
                case, DuplicateReviewHistory.Action.ANALYSIS_UPDATED, None,
                note=(f"Analyse mise à jour : score {old[0]:.0f} → {match.score:.0f} "
                      f"(niveau courant : {match.risk_level})."),
                detail={'from': {'score': old[0], 'risk_level': old[1]},
                        'to': {'score': match.score, 'risk_level': match.risk_level}})

    # ── blocking rules ───────────────────────────

    @classmethod
    def blocking_cases(cls, declaration):
        """(unresolved cases of risk level in ``blocking_levels``, cases designating it as redundant entry)."""
        levels = effective_blocking_levels(get_config()['blocking_levels'])
        pair = Q(declaration=declaration) | Q(other_declaration=declaration)
        unresolved = list(DuplicateCase.objects.filter(pair, risk_level__in=levels)
                          .exclude(status=CaseStatus.RESOLVED).select_related('declaration', 'other_declaration'))
        designated = list(DuplicateCase.objects.filter(
            status=CaseStatus.RESOLVED, final_decision__in=Decision.DESIGNATES_DUPLICATE,
            duplicate_declaration=declaration).select_related('principal_declaration'))
        return unresolved, designated

    @classmethod
    def status_for(cls, declaration) -> dict:
        """Compact duplicate status of a dossier (shown on the dossier screen)."""
        unresolved, designated = cls.blocking_cases(declaration)
        any_open = DuplicateCase.objects.filter(
            Q(declaration=declaration) | Q(other_declaration=declaration)).exclude(
            status=CaseStatus.RESOLVED)
        return {
            'blocked': bool(unresolved or designated),
            'open_cases': [{'uuid': str(c.uuid), 'reference': c.reference, 'risk_level': c.risk_level,
                            'status': c.status, 'score': c.score} for c in any_open],
            'designated_duplicate': [{'uuid': str(c.uuid), 'reference': c.reference,
                                      'principal_reference': c.principal_declaration.reference
                                      if c.principal_declaration else ''} for c in designated],
        }

    @classmethod
    def assert_official_validation_allowed(cls, declaration, user=None):
        """
        Called inside ``assign_official_number`` (the only place the official number is attributed).
        Serialised with a lock shared by every validation, so two simultaneous validations cannot both
        slip through a case that the other one would have blocked.
        """
        from duplicates.services.detection import DuplicateDetectionService, acquire_lock
        acquire_lock(NUMBERING_LOCK)
        DuplicateDetectionService.ensure_fresh(declaration, user)
        unresolved, designated = cls.blocking_cases(declaration)
        if designated:
            refs = ', '.join(c.reference for c in designated)
            raise ValidationError(
                f"Ce dossier a été identifié comme doublon d'un autre dossier ({refs}) : aucun second acte "
                "officiel ne peut être établi pour la même naissance.", code='duplicate_block')
        if unresolved:
            refs = ', '.join(c.reference for c in unresolved)
            raise ValidationError(
                f"Validation impossible : un contrôle de doublon est en cours ({refs}). Un responsable "
                "habilité doit le traiter dans le Centre de contrôle des doublons.", code='duplicate_block')
