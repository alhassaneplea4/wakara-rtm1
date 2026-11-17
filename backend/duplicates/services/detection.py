"""
DuplicateDetectionService — central, server-side analysis of one declaration against every other
declaration and official act of the mairie (whatever the agent, device, synchronisation or service
that entered it, archived ones included).

Detection is serialised by a row lock (``duplicate-detection``): of two declarations committed at the
same moment, the second analysis always sees the first one. The final detection is therefore
exhaustive and server-side; whatever a device could check locally is only indicative.
"""
import datetime
import logging

from django.db import transaction
from django.db.models import Q

from core.workflow import Status
from duplicates.config import CANDIDATE_LIMIT, ENGINE_VERSION, get_config
from duplicates.models import BirthIdentity, DuplicateCheck, DuplicateCounter, DuplicateMatch, RiskLevel
from duplicates.services.audit import DuplicateAuditService
from duplicates.services.cases import DuplicateCaseService
from duplicates.services.identity import BirthIdentityService
from duplicates.services.scoring import DuplicateScoringService

log = logging.getLogger(__name__)
DETECTION_LOCK = 'duplicate-detection'


def acquire_lock(key: str):
    """Row lock held until the end of the surrounding transaction (no-op on SQLite, which serialises writes)."""
    counter, _ = DuplicateCounter.objects.select_for_update().get_or_create(key=key)
    return counter


class DuplicateDetectionService:
    # ── candidate retrieval ──────────────────────

    @staticmethod
    def candidate_identities(identity: BirthIdentity, config: dict, exhaustive: bool = False):
        """
        (candidates, truncated). Cheap pre-filter before the fuzzy scoring, in TIERS from the most telling to the
        least: the exact keys of the mother (name, phonetic form, phone), the child's name, the exact birth date,
        then the date window. Each tier has its own cap, and the first tiers are kept first when the total cap is
        reached, so a busy week of births can never push out of the list an older dossier that shares the mother
        or the child's name. ``truncated`` says that a cap was hit (the analysis is then not exhaustive: it is
        recorded, and the validation redoes it with ``exhaustive=True``, which has no cap at all).
        REJECTED dossiers are ignored; archived ones are kept (old declarations must still be found).
        """
        base = (BirthIdentity.objects.exclude(declaration_id=identity.declaration_id)
                .exclude(declaration__status=Status.REJECTED)
                .select_related('declaration', 'declaration__acte').order_by('-declaration_id'))
        tiers = []
        for field in ('mother_name_key', 'mother_phonetic', 'mother_phone_norm', 'child_name_key'):
            if getattr(identity, field):
                tiers.append(Q(**{field: getattr(identity, field)}))
        if identity.birth_date:
            d, w = identity.birth_date, datetime.timedelta(days=config['date_window_days'])
            exact = Q(birth_date=d)
            if d.day <= 12 and d.day != d.month:
                exact |= Q(birth_date=datetime.date(d.year, d.day, d.month))
            tiers.append(exact)
            tiers.append(Q(birth_date__range=(d - w, d + w)))
        per_tier = None if exhaustive else CANDIDATE_LIMIT
        total_cap = None if exhaustive else CANDIDATE_LIMIT * 3
        found, truncated = {}, False
        for q in tiers:
            qs = base.filter(q)
            rows = list(qs if per_tier is None else qs[:per_tier + 1])
            if per_tier is not None and len(rows) > per_tier:
                truncated, rows = True, rows[:per_tier]
            for row in rows:
                if total_cap is not None and len(found) >= total_cap and row.declaration_id not in found:
                    truncated = True
                    continue
                found.setdefault(row.declaration_id, row)
        return list(found.values()), truncated

    @staticmethod
    def has_official_act(declaration) -> bool:
        acte = getattr(declaration, 'acte', None)
        return bool(acte and acte.numero_acte)

    # ── analysis ─────────────────────────────────

    @classmethod
    def last_check(cls, declaration):
        return declaration.duplicate_checks.order_by('-performed_at', '-id').first()

    @classmethod
    @transaction.atomic
    def analyze(cls, declaration, *, trigger='MANUAL', user=None, force=True, exhaustive=False) -> DuplicateCheck:
        """Run (or reuse) the analysis. Returns the DuplicateCheck, with ``.cases`` = cases touched."""
        acquire_lock(DETECTION_LOCK)
        config = get_config()
        identity, changed = BirthIdentityService.refresh(declaration)
        if not force and not changed:
            last = cls.last_check(declaration)
            if last and last.identity_hash == identity.data_hash:
                last.cases = []
                return last

        results, seen = [], set()
        candidates, truncated = cls.candidate_identities(identity, config, exhaustive)
        if truncated:
            log.warning("Duplicate analysis of %s truncated: more candidates than the cap.", declaration.pk)
        for cand in candidates:
            res = DuplicateScoringService.score(identity, cand, config)
            seen.add(cand.declaration_id)
            results.append((cand, res))
        # pairs already recorded but no longer returned by the pre-filter (data corrected since): re-score them
        known = DuplicateMatch.objects.filter(Q(declaration=declaration) | Q(candidate=declaration))
        for match in known:
            other_id = match.candidate_id if match.declaration_id == declaration.id else match.declaration_id
            if other_id in seen:
                continue
            other = BirthIdentity.objects.filter(declaration_id=other_id).select_related(
                'declaration', 'declaration__acte').first()
            if other:
                results.append((other, DuplicateScoringService.score(identity, other, config)))

        recorded = [(c, r) for c, r in results
                    if r['risk_level'] in (RiskLevel.HIGH, RiskLevel.MEDIUM)
                    or r['score'] >= config['min_recorded_score']
                    or DuplicateMatch.objects.filter(
                        pair_key=DuplicateMatch.make_pair_key(declaration.id, c.declaration_id)).exists()]
        highest = max((r['score'] for _, r in recorded), default=0)
        check = DuplicateCheck.objects.create(
            declaration=declaration, trigger=trigger, identity_hash=identity.data_hash, performed_by=user,
            candidates_examined=len(candidates), candidates_truncated=truncated, matches_found=len(recorded),
            highest_score=highest,
            data_quality=identity.data_quality, engine_version=ENGINE_VERSION,
            config_snapshot={'weights': config['weights'], 'thresholds': config['thresholds']})

        cases = []
        for cand, res in recorded:
            match = cls._save_match(declaration, identity, cand, res, check)
            case = DuplicateCaseService.sync_case(match, user=user, identity=identity, other_identity=cand)
            if case is not None:
                cases.append(case)
        DuplicateAuditService.log_check(user, declaration, check)
        check.cases = cases
        return check

    @classmethod
    def _save_match(cls, declaration, identity, cand, res, check) -> DuplicateMatch:
        pair_key = DuplicateMatch.make_pair_key(declaration.id, cand.declaration_id)
        existing = DuplicateMatch.objects.filter(pair_key=pair_key).first()
        if existing and existing.declaration_id != declaration.id:
            # keep the orientation of the first detection (declaration = the later one, in practice)
            m_decl, m_cand = cand.declaration, declaration
            decl_hash, cand_hash = cand.data_hash, identity.data_hash
        else:
            m_decl, m_cand = declaration, cand.declaration
            decl_hash, cand_hash = identity.data_hash, cand.data_hash
        flags = dict(res['flags'])
        flags['official_act'] = {'declaration': cls.has_official_act(m_decl),
                                 'candidate': cls.has_official_act(m_cand)}
        values = dict(
            analysis=check, score=res['score'], raw_points=res['raw_points'],
            comparable_points=res['comparable_points'], data_quality=res['data_quality'],
            risk_level=res['risk_level'], criteria=res['criteria'], flags=flags,
            candidate_has_official_act=flags['official_act']['candidate'],
            declaration_hash=decl_hash, candidate_hash=cand_hash)
        if existing:
            for k, v in values.items():
                setattr(existing, k, v)
            existing.save()
            return existing
        return DuplicateMatch.objects.create(
            pair_key=pair_key, declaration=m_decl, candidate=m_cand, **values)

    @classmethod
    def ensure_fresh(cls, declaration, user=None) -> DuplicateCheck:
        """Make sure the declaration has been analysed on its CURRENT data (re-run otherwise)."""
        identity, changed = BirthIdentityService.refresh(declaration)
        last = cls.last_check(declaration)
        if last is None or changed or last.identity_hash != identity.data_hash or last.candidates_truncated:
            # before an official number nothing is left to a cap: the analysis is exhaustive
            return cls.analyze(declaration, trigger='PRE_VALIDATION', user=user, force=True, exhaustive=True)
        return last

    @classmethod
    def on_declaration_changed(cls, declaration, user, changes=None):
        """
        Hook of ``update_declaration``: a correction after a first analysis. The identity is rebuilt; if the
        normalised data changed, the open cases of the dossier get a history entry and the analysis is re-run.
        """
        try:
            _, changed = BirthIdentityService.refresh(declaration)
            if not changed:
                return None
            from duplicates.models import CaseStatus, DuplicateCase, DuplicateReviewHistory
            open_cases = DuplicateCase.objects.filter(
                Q(declaration=declaration) | Q(other_declaration=declaration)).exclude(
                status=CaseStatus.RESOLVED)
            for case in open_cases:
                DuplicateAuditService.record(
                    case, DuplicateReviewHistory.Action.DATA_CHANGED, user,
                    note=f"Données de {declaration.reference} modifiées : {', '.join(sorted(changes or {}))}.",
                    detail={'declaration': declaration.reference, 'fields': sorted(changes or {})})
        except Exception:  # noqa: BLE001
            log.exception("Identity refresh failed for declaration %s", declaration.pk)
        return cls.analyze_safely(declaration, trigger='UPDATE', user=user)

    @classmethod
    def analyze_safely(cls, declaration, *, trigger, user=None):
        """
        Hook used by the normal circuit: a failure of the engine must never lose a declaration. The
        official validation re-runs the analysis (``ensure_fresh``) and cannot pass without it.
        """
        try:
            return cls.analyze(declaration, trigger=trigger, user=user, force=False)
        except Exception:  # noqa: BLE001
            log.exception("Duplicate analysis failed for declaration %s", declaration.pk)
            return None
