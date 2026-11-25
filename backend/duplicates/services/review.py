"""
DuplicateReviewService — what the people in charge do with a case: take it, comment, request a complementary
verification, attach the documents they consulted, compare the two declarations side by side, decide.

Every action re-checks the permission SERVER-SIDE (consult / investigate / decide are distinct), writes an
append-only history row and an audit-log entry. Nothing is ever deleted, merged or cancelled here: even a
"confirmed duplicate" decision only links the redundant dossier to the principal one and keeps both intact.
"""
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.utils import timezone

from audit.models import AuditAction
from core.permissions import user_has_perm
from core.workflow import Status
from documents.models import SupportingDocument
from duplicates import text
from duplicates.models import (
    CaseStatus, Decision, DuplicateCase, DuplicateDecision, DuplicateEvidence, DuplicateReviewHistory as H,
)
from duplicates.services.audit import DuplicateAuditService, actor_name
from duplicates.services.cases import device_of


def require(user, codename):
    if not user_has_perm(user, codename):
        raise PermissionDenied(f"Permission requise : {codename}")


def _own_declaration(case, declaration):
    """An observation or a verification request can only target one of the two dossiers of the case."""
    if declaration is not None and declaration.id not in (case.declaration_id, case.other_declaration_id):
        raise ValidationError({'declaration': "Ce dossier ne fait pas partie du contrôle en cours."})
    return declaration


def _lock(case):
    return DuplicateCase.objects.select_for_update().get(pk=case.pk)


# ── side-by-side comparison ──────────────────────

def _full_name(user):
    return (user.get_full_name() or user.username) if user else ''


def _cmp(kind, a, b):
    """Status of a pair of raw values: same / similar / different / missing."""
    if a in (None, '') or b in (None, ''):
        return 'missing'
    if kind == 'name':
        if text.normalize_text(a) == text.normalize_text(b) or text.name_key(a) == text.name_key(b):
            return 'same'
        return 'similar' if text.name_similarity(a, b) >= 0.8 else 'different'
    if kind == 'date':
        sim = text.date_similarity(a, b)
        return 'same' if sim == 1 else 'similar' if sim >= 0.5 else 'different'
    if kind == 'time':
        sim = text.time_similarity(a, b)
        return 'same' if sim == 1 else 'similar' if sim >= 0.7 else 'different'
    if kind == 'place':
        sim = text.place_similarity(a, b)
        return 'same' if sim == 1 else 'similar' if sim >= 0.8 else 'different'
    if kind == 'phone':
        return 'same' if text.normalize_phone(a) == text.normalize_phone(b) else 'different'
    return 'same' if text.normalize_text(a) == text.normalize_text(b) else 'different'


def _row(label, kind, a, b):
    def show(v):
        return '' if v in (None, '') else (v.strftime('%H:%M') if hasattr(v, 'hour') and not hasattr(v, 'year')
                                            else str(v))
    return {'label': label, 'a': show(a), 'b': show(b), 'status': _cmp(kind, a, b)}


def _parent(declaration, kind):
    for p in declaration.parents.all():
        if p.parent_type == kind and not p.is_archived:
            return p
    return None


class DuplicateReviewService:
    # ── comparison ───────────────────────────────

    @classmethod
    def compare_declarations(cls, a, b, user=None) -> dict:
        """Sections of rows {label, a, b, status} to display two declarations side by side."""
        ca, cb = getattr(a, 'child', None), getattr(b, 'child', None)
        ma, mb = _parent(a, 'MOTHER'), _parent(b, 'MOTHER')
        fa, fb = _parent(a, 'FATHER'), _parent(b, 'FATHER')
        da, db = getattr(a, 'declarant', None), getattr(b, 'declarant', None)
        acte_a, acte_b = getattr(a, 'acte', None), getattr(b, 'acte', None)

        def g(obj, attr):
            return getattr(obj, attr, '') if obj else ''

        def person(label, pa, pb):
            return [
                _row('Nom', 'name', g(pa, 'last_name'), g(pb, 'last_name')),
                _row('Prénoms', 'name', g(pa, 'first_names'), g(pb, 'first_names')),
                _row('Date de naissance', 'date', g(pa, 'date_of_birth') or None, g(pb, 'date_of_birth') or None),
                _row('Lieu de naissance', 'place', g(pa, 'birth_place'), g(pb, 'birth_place')),
                _row('Téléphone', 'phone', g(pa, 'phone'), g(pb, 'phone')),
                _row('Adresse / quartier', 'place', g(pa, 'address'), g(pb, 'address')),
            ]

        sections = [
            {'key': 'child', 'title': "Enfant", 'rows': [
                _row('Nom', 'name', g(ca, 'last_name'), g(cb, 'last_name')),
                _row('Prénoms', 'name', g(ca, 'first_names'), g(cb, 'first_names')),
                _row('Sexe', 'exact', g(ca, 'gender'), g(cb, 'gender')),
                _row('Date de naissance', 'date', a.birth_date, b.birth_date),
                _row('Heure de naissance', 'time', a.birth_time, b.birth_time),
                _row('Lieu de naissance', 'place', a.birth_place, b.birth_place),
                _row('Rang de naissance', 'exact', g(ca, 'birth_rank'), g(cb, 'birth_rank')),
            ]},
            {'key': 'mother', 'title': 'Mère', 'rows': person('Mère', ma, mb)},
            {'key': 'father', 'title': 'Père', 'rows': person('Père', fa, fb)},
            {'key': 'hospital', 'title': 'Informations hospitalières', 'rows': [
                _row('Établissement', 'exact', a.hospital.name if a.hospital else '',
                     b.hospital.name if b.hospital else ''),
                _row('Référence hospitalière', 'exact', a.hospital_document_ref, b.hospital_document_ref),
                _row('Médecin', 'name', a.doctor_name, b.doctor_name),
                _row('Sage-femme', 'name', a.midwife_name, b.midwife_name),
                _row('Déclarant', 'name', f"{g(da, 'first_names')} {g(da, 'last_name')}".strip(),
                     f"{g(db, 'first_names')} {g(db, 'last_name')}".strip()),
            ]},
            {'key': 'file', 'title': 'Dossier et saisie', 'rows': [
                _row('Référence provisoire', 'exact', a.reference, b.reference),
                _row('Statut', 'exact', Status.SECRETARIAT_LABELS[a.status], Status.SECRETARIAT_LABELS[b.status]),
                _row('N° officiel de l\'acte', 'exact', g(acte_a, 'numero_acte') or '', g(acte_b, 'numero_acte') or ''),
                _row('Agent collecteur', 'exact', _full_name(a.created_by), _full_name(b.created_by)),
                _row('Saisie le', 'exact', timezone.localtime(a.device_created_at or a.created_at).strftime('%d/%m/%Y %H:%M'),
                     timezone.localtime(b.device_created_at or b.created_at).strftime('%d/%m/%Y %H:%M')),
                _row('Appareil', 'exact', device_of(a), device_of(b)),
                _row('Mode de réception', 'exact', 'Synchronisation' if a.device_created_at else 'En ligne',
                     'Synchronisation' if b.device_created_at else 'En ligne'),
            ]},
        ]
        counts = {'same': 0, 'similar': 0, 'different': 0, 'missing': 0}
        for s in sections:
            for r in s['rows']:
                counts[r['status']] += 1
        documents = {}
        can_docs = user is not None and user_has_perm(user, 'document.view')
        for key, d in (('a', a), ('b', b)):
            documents[key] = [{
                'uuid': str(doc.uuid), 'kind': doc.kind, 'kind_label': doc.get_kind_display(),
                'original_name': doc.original_name, 'size': doc.size, 'created_at': doc.created_at,
            } for doc in SupportingDocument.objects.filter(declaration=d)] if can_docs else []
        return {
            'a': cls._summary(a), 'b': cls._summary(b), 'sections': sections, 'counts': counts,
            'documents': documents, 'documents_visible': can_docs,
        }

    @staticmethod
    def _summary(d) -> dict:
        child = getattr(d, 'child', None)
        acte = getattr(d, 'acte', None)
        return {
            'uuid': str(d.uuid), 'reference': d.reference, 'status': d.status,
            'status_label': Status.SECRETARIAT_LABELS[d.status], 'child_name': str(child) if child else '',
            'birth_date': d.birth_date, 'official_number': acte.numero_acte if acte else None,
            'created_by_name': _full_name(d.created_by), 'created_at': d.created_at,
            'is_archived': d.is_archived,
        }

    @classmethod
    def view_comparison(cls, case, user):
        """Sensitive consultation: recorded in the case history and the audit log."""
        require(user, 'duplicate.view')
        DuplicateAuditService.record_view(case, user, H.Action.COMPARISON_VIEWED)
        return cls.compare_declarations(case.declaration, case.other_declaration, user)

    # ── investigation actions ────────────────────

    @classmethod
    @transaction.atomic
    def take(cls, case, user):
        require(user, 'duplicate.investigate')
        case = _lock(case)
        if case.is_resolved:
            raise ValidationError("Ce dossier est déjà résolu.", code='case_resolved')
        previous = case.assigned_to
        case.assigned_to = user
        if case.status == CaseStatus.OPEN:
            case.status = CaseStatus.IN_REVIEW
        case.save()
        DuplicateAuditService.record(case, H.Action.TAKEN, user, detail={
            'previous': _full_name(previous) if previous and previous != user else ''})
        return case

    @classmethod
    @transaction.atomic
    def assign(cls, case, user, assignee):
        require(user, 'duplicate.decide')
        from core.permissions import user_has_perm as has
        if not has(assignee, 'duplicate.investigate'):
            raise ValidationError({'assignee': "Cet utilisateur n'est pas habilité à investiguer."})
        case = _lock(case)
        if case.is_resolved:
            raise ValidationError("Ce dossier est déjà résolu.", code='case_resolved')
        case.assigned_to = assignee
        if case.status == CaseStatus.OPEN:
            case.status = CaseStatus.IN_REVIEW
        case.save()
        DuplicateAuditService.record(case, H.Action.ASSIGNED, user, detail={'assignee': _full_name(assignee)})
        return case

    @classmethod
    @transaction.atomic
    def add_note(cls, case, user, content, kind=DuplicateEvidence.Kind.OBSERVATION, declaration=None):
        require(user, 'duplicate.investigate')
        declaration = _own_declaration(case, declaration)
        content = (content or '').strip()
        if not content:
            raise ValidationError({'content': "Le texte est obligatoire."})
        allowed = (DuplicateEvidence.Kind.OBSERVATION, DuplicateEvidence.Kind.VERIFICATION_RESULT,
                   DuplicateEvidence.Kind.EXTERNAL_REFERENCE)
        if kind not in allowed:
            raise ValidationError({'kind': "Type d'élément non autorisé."})
        case = _lock(case)
        if case.is_resolved:
            raise ValidationError("Ce dossier est déjà résolu : rouvrez-le pour ajouter des éléments.",
                                  code='case_resolved')
        ev = DuplicateEvidence.objects.create(
            case=case, kind=kind, content=content, declaration=declaration, added_by=user,
            added_by_name=actor_name(user))
        if kind == DuplicateEvidence.Kind.VERIFICATION_RESULT and case.status == CaseStatus.AWAITING_INFO:
            case.status = CaseStatus.IN_REVIEW
            case.save()
        DuplicateAuditService.record(case, H.Action.OBSERVATION, user, note=content,
                                     detail={'kind': kind, 'evidence': str(ev.uuid)})
        return ev

    @classmethod
    @transaction.atomic
    def request_verification(cls, case, user, content, declaration=None):
        require(user, 'duplicate.investigate')
        declaration = _own_declaration(case, declaration)
        content = (content or '').strip()
        if not content:
            raise ValidationError({'content': "Précisez la vérification demandée."})
        case = _lock(case)
        if case.is_resolved:
            raise ValidationError("Ce dossier est déjà résolu.", code='case_resolved')
        ev = DuplicateEvidence.objects.create(
            case=case, kind=DuplicateEvidence.Kind.VERIFICATION_REQUEST, content=content,
            declaration=declaration, added_by=user, added_by_name=actor_name(user))
        case.status = CaseStatus.AWAITING_INFO
        case.save()
        DuplicateAuditService.record(case, H.Action.VERIFICATION_REQUESTED, user, note=content,
                                     detail={'evidence': str(ev.uuid)})
        return ev

    @classmethod
    @transaction.atomic
    def attach_document(cls, case, user, document_uuid, note=''):
        require(user, 'duplicate.investigate')
        require(user, 'document.view')
        doc = SupportingDocument.objects.filter(uuid=document_uuid).select_related('declaration').first()
        if doc is None or doc.declaration_id not in (case.declaration_id, case.other_declaration_id):
            raise ValidationError({'document': "Pièce introuvable pour les déclarations de ce dossier."})
        case = _lock(case)
        ev = DuplicateEvidence.objects.create(
            case=case, kind=DuplicateEvidence.Kind.DOCUMENT, document=doc, declaration=doc.declaration,
            title=doc.original_name, content=note or '', added_by=user, added_by_name=actor_name(user))
        DuplicateAuditService.record(case, H.Action.DOCUMENT_VIEWED, user, note=note or '',
                                     detail={'document': str(doc.uuid), 'name': doc.original_name,
                                             'declaration': doc.declaration.reference})
        DuplicateAuditService.log(AuditAction.DUPLICATE_VIEWED, user, case,
                                  {'document': str(doc.uuid), 'name': doc.original_name})
        return ev

    # ── decisions ────────────────────────────────

    @classmethod
    @transaction.atomic
    def decide(cls, case, user, decision, reason, duplicate_declaration=None):
        """
        Record a decision. ``duplicate_declaration`` (one of the two dossiers) is required when the decision
        designates a redundant entry (confirmed duplicate / data-entry error): the other one is the principal.
        Returns (case, decision_row, warnings).
        """
        require(user, 'duplicate.decide')
        if decision not in dict(Decision.CHOICES):
            raise ValidationError({'decision': "Décision inconnue."})
        reason = (reason or '').strip()
        if not reason:
            raise ValidationError({'reason': "Un motif est obligatoire pour toute décision."})
        case = _lock(case)
        if case.is_resolved:
            raise ValidationError("Ce dossier est déjà résolu : rouvrez-le pour prendre une nouvelle décision.",
                                  code='case_resolved')
        principal = duplicate = None
        if decision in Decision.DESIGNATES_DUPLICATE:
            ids = {case.declaration_id: case.declaration, case.other_declaration_id: case.other_declaration}
            if duplicate_declaration is None or duplicate_declaration.id not in ids:
                raise ValidationError({'duplicate_declaration': (
                    "Indiquez lequel des deux dossiers est la saisie redondante.")})
            duplicate = ids[duplicate_declaration.id]
            principal = next(d for i, d in ids.items() if i != duplicate.id)

        warnings = []
        outcome = ''   # what became of the redundant dossier: rejected / already_rejected / kept
        if decision in Decision.FINAL:
            new_status = CaseStatus.RESOLVED
        else:
            new_status = CaseStatus.AWAITING_INFO
        row = DuplicateDecision.objects.create(
            case=case, decision=decision, reason=reason, decided_by=user, decided_by_name=actor_name(user),
            principal_declaration=principal, duplicate_declaration=duplicate, resulting_status=new_status)
        case.status = new_status
        if new_status == CaseStatus.RESOLVED:
            case.resolved_at = timezone.now()
            case.final_decision = decision
            case.principal_declaration, case.duplicate_declaration = principal, duplicate
            case.resolution_hashes = {'declaration': case.match.declaration_hash,
                                      'candidate': case.match.candidate_hash}
            if duplicate is not None:
                from declarations.services import reject_as_redundant
                outcome = reject_as_redundant(duplicate, user, case.reference, principal.reference)
                if outcome == 'kept':
                    acte = getattr(duplicate, 'acte', None)
                    if acte and acte.numero_acte:
                        warnings.append(
                            f"Un acte officiel existe déjà pour {duplicate.reference} (n° {acte.numero_acte}). "
                            "Aucune modification ni annulation n'est faite automatiquement : "
                            "la rectification ou l'annulation doit suivre la procédure légale.")
                    else:
                        warnings.append(
                            f"{duplicate.reference} est déjà validé : il n'est pas rejeté automatiquement "
                            "et reste dans la liste des déclarations.")
        case.save()
        DuplicateAuditService.record(case, H.Action.DECISION, user, note=reason, detail={
            'decision': decision, 'resulting_status': new_status,
            'principal': principal.reference if principal else '',
            'duplicate': duplicate.reference if duplicate else '', 'outcome': outcome})
        DuplicateAuditService.log(AuditAction.DUPLICATE_DECISION, user, case, {
            'decision': decision, 'resulting_status': new_status,
            'principal': principal.reference if principal else '',
            'duplicate': duplicate.reference if duplicate else '', 'outcome': outcome}, reason=reason)
        case.redundant_outcome = outcome
        return case, row, warnings

    @classmethod
    @transaction.atomic
    def reopen(cls, case, user, reason):
        require(user, 'duplicate.decide')
        reason = (reason or '').strip()
        if not reason:
            raise ValidationError({'reason': "Un motif est obligatoire pour rouvrir un dossier."})
        case = _lock(case)
        if not case.is_resolved:
            raise ValidationError("Ce dossier n'est pas résolu.")
        if DuplicateCase.objects.filter(pair_key=case.pair_key).exclude(status=CaseStatus.RESOLVED).exists():
            raise ValidationError("Un autre dossier d'investigation est déjà ouvert pour ces déclarations.")
        previous = case.final_decision
        restored = False
        if case.duplicate_declaration_id:
            from declarations.services import restore_from_redundant
            restored = restore_from_redundant(case.duplicate_declaration, user, case.reference)
        case.status = CaseStatus.IN_REVIEW
        case.final_decision = ''
        case.principal_declaration = case.duplicate_declaration = None
        case.resolved_at = None
        case.resolution_hashes = {}
        case.assigned_to = user
        case.save()
        DuplicateAuditService.record(case, H.Action.REOPENED, user, note=reason,
                                     detail={'previous_decision': previous, 'redundant_restored': restored})
        DuplicateAuditService.log(AuditAction.DUPLICATE_DECISION, user, case,
                                  {'reopened': True, 'previous_decision': previous,
                                   'redundant_restored': restored}, reason=reason)
        return case
