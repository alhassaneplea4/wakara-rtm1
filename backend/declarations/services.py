"""
Business logic of the dossier workflow (kept out of the views).

All authorisation and state rules are enforced HERE, server-side:
  - allowed transitions come from core.workflow
  - the permission required by each transition is checked against the actor
  - the dossier is locked for non-authorised editors
"""
import datetime

from django.conf import settings
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.utils import timezone

from audit import service as audit
from audit.models import AuditAction
from core.permissions import user_has_perm
from core.workflow import Status, available_transitions, get_transition

from .models import Child, Declarant, Declaration, Parent, ReferenceCounter, StatusHistory


# ── Visibility & edit rights ──────────────────────

def visible_declarations(user, queryset=None):
    """Declarations the user may see: everything with view_all, otherwise only own."""
    qs = queryset if queryset is not None else Declaration.objects.all()
    if user_has_perm(user, 'declaration.view_all'):
        return qs
    return qs.filter(created_by=user)


def can_edit_data(user, declaration) -> bool:
    """May ``user`` modify the identity data of this dossier in its current status?"""
    status = declaration.status
    if status in Status.DECLARATION_EDITABLE and user_has_perm(user, 'declaration.update'):
        return user_has_perm(user, 'declaration.view_all') or declaration.created_by_id == user.id
    if status in Status.ACTE_EDITABLE and user_has_perm(user, 'acte.update'):
        return True
    return False


def user_transitions(user, declaration):
    """Transitions the user can trigger right now (used by the API to drive the UI)."""
    result = []
    for t in available_transitions(declaration.status):
        if t.via_delivery or not user_has_perm(user, t.permission):
            continue
        if t.source in (Status.DRAFT, Status.TO_CORRECT_COLLECTION):
            if not (user_has_perm(user, 'declaration.view_all') or declaration.created_by_id == user.id):
                continue
        result.append(t)
    return result


# ── References ────────────────────────────────────

@transaction.atomic
def generate_reference() -> str:
    """WKR-{year}-{seq}. The counter row is locked, so concurrent calls never collide."""
    year = timezone.localdate().year
    counter, _ = ReferenceCounter.objects.select_for_update().get_or_create(key=f'declaration-{year}')
    counter.value += 1
    counter.save(update_fields=['value'])
    return f"WKR-{year}-{counter.value:04d}"


# ── Data completeness ─────────────────────────────

def _field_filled(declaration, spec: str) -> bool:
    scope, _, field = spec.partition('.')
    if not field:  # plain declaration field
        return bool(getattr(declaration, scope, None))
    if scope == 'child':
        child = getattr(declaration, 'child', None)
        if field == 'name':
            return bool(child and (child.first_names or child.last_name))
        return bool(child and getattr(child, field, None))
    if scope in ('mother', 'father'):
        parent = declaration.parents.filter(parent_type=scope.upper()).first()
        if field == 'name':
            return bool(parent and (parent.first_names or parent.last_name))
        return bool(parent and getattr(parent, field, None))
    if scope == 'declarant':
        declarant = getattr(declaration, 'declarant', None)
        if field == 'name':
            return bool(declarant and (declarant.first_names or declarant.last_name))
        return bool(declarant and getattr(declarant, field, None))
    if scope == 'acte':
        acte = getattr(declaration, 'acte', None)
        return bool(acte and getattr(acte, field, None))
    return True


def missing_fields(declaration, required_specs) -> list:
    return [spec for spec in required_specs if not _field_filled(declaration, spec)]


FIELD_LABELS = {
    'birth_date': 'date de naissance', 'child.gender': "sexe de l'enfant",
    'child.name': "nom de l'enfant", 'mother.name': 'nom de la mère',
    'acte.declaration_date': 'date de déclaration', 'declarant.name': 'nom du déclarant',
}


# ── Creation ──────────────────────────────────────

@transaction.atomic
def create_declaration(user, data: dict) -> Declaration:
    child = data.pop('child', None) or {}
    mother = data.pop('mother', None)
    father = data.pop('father', None)
    declarant = data.pop('declarant', None)
    declaration = Declaration.objects.create(
        reference=generate_reference(),
        received_at=timezone.localdate(),
        created_by=user, updated_by=user, assigned_to=user,
        **data,
    )
    Child.objects.create(declaration=declaration, **child)
    for kind, payload in ((Parent.MOTHER, mother), (Parent.FATHER, father)):
        if payload:
            Parent.objects.create(declaration=declaration, parent_type=kind, **payload)
    if declarant:
        Declarant.objects.create(declaration=declaration, **declarant)
    StatusHistory.objects.create(declaration=declaration, from_status='', to_status=Status.DRAFT,
                                 changed_by=user)
    audit.log(AuditAction.CREATE, user=user, obj=declaration,
              changes={'reference': declaration.reference, 'status': declaration.status})
    return declaration


@transaction.atomic
def update_declaration(user, declaration: Declaration, data: dict) -> Declaration:
    """Apply a (partial) update of the declaration and its nested sections; audits the diff."""
    if not can_edit_data(user, declaration):
        raise PermissionDenied("Ce dossier ne peut pas être modifié dans son état actuel ou par vous.")

    before = _full_snapshot(declaration)
    child = data.pop('child', None)
    mother = data.pop('mother', None)
    father = data.pop('father', None)
    declarant = data.pop('declarant', None)

    for field, value in data.items():
        setattr(declaration, field, value)
    declaration.updated_by = user
    declaration.save()

    if child is not None:
        obj, _ = Child.objects.get_or_create(declaration=declaration)
        _apply(obj, child)
    for kind, payload in ((Parent.MOTHER, mother), (Parent.FATHER, father)):
        if payload is not None:
            obj, _ = Parent.objects.get_or_create(declaration=declaration, parent_type=kind)
            _apply(obj, payload)
    if declarant is not None:
        obj, _ = Declarant.objects.get_or_create(declaration=declaration)
        _apply(obj, declarant)

    declaration = Declaration.objects.get(pk=declaration.pk)
    changes = audit.diff(before, _full_snapshot(declaration))
    if changes:
        audit.log(AuditAction.UPDATE, user=user, obj=declaration, changes=changes)
    return declaration


def _apply(obj, payload):
    for field, value in payload.items():
        setattr(obj, field, value)
    obj.save()


DECL_FIELDS = ['hospital', 'hospital_document_ref', 'doctor_name', 'midwife_name',
               'birth_date', 'birth_time', 'birth_place', 'notes']


def _full_snapshot(declaration) -> dict:
    snap = audit.snapshot(declaration, DECL_FIELDS)
    child = getattr(declaration, 'child', None) if declaration.pk else None
    if child:
        snap.update({f'child.{k}': v for k, v in audit.snapshot(
            child, ['first_names', 'last_name', 'gender', 'birth_weight', 'birth_length']).items()})
    for parent in declaration.parents.all():
        prefix = parent.parent_type.lower()
        snap.update({f'{prefix}.{k}': v for k, v in audit.snapshot(
            parent, ['first_names', 'last_name', 'age', 'profession', 'address', 'nationality',
                     'date_of_birth', 'birth_place', 'phone', 'id_type', 'id_number']).items()})
    declarant = getattr(declaration, 'declarant', None)
    if declarant:
        snap.update({f'declarant.{k}': v for k, v in audit.snapshot(
            declarant, ['first_names', 'last_name', 'relationship', 'profession', 'phone',
                        'address', 'id_type', 'id_number']).items()})
    return snap


# ── Workflow ──────────────────────────────────────

AUDIT_ACTION_BY_TARGET = {
    Status.TRANSMITTED: AuditAction.TRANSMIT,
    Status.VALIDATED: AuditAction.VALIDATE,
    Status.REJECTED: AuditAction.REJECT,
    Status.TO_CORRECT_COLLECTION: AuditAction.RETURN,
    Status.TO_CORRECT_SECRETARIAT: AuditAction.RETURN,
}


@transaction.atomic
def transition_status(declaration_pk, target: str, user, reason: str = '', payload: dict = None):
    """
    Move a dossier to ``target``. Raises:
      ValidationError   unknown / forbidden transition, missing reason, incomplete data
      PermissionDenied  the actor lacks the permission attached to this transition
    The declaration row is locked for the whole operation (no concurrent transitions).
    """
    payload = payload or {}
    declaration = Declaration.objects.select_for_update().get(pk=declaration_pk)
    t = get_transition(declaration.status, target)
    if t.via_delivery:
        raise ValidationError("Le passage à « délivré » se fait en enregistrant une délivrance.",
                              code='invalid_transition')
    if not user_has_perm(user, t.permission):
        raise PermissionDenied(f"Permission requise : {t.permission}")
    if t.source in (Status.DRAFT, Status.TO_CORRECT_COLLECTION) and not (
            user_has_perm(user, 'declaration.view_all') or declaration.created_by_id == user.id):
        raise PermissionDenied("Vous ne pouvez transmettre que vos propres déclarations.")

    reason = (reason or '').strip()
    if t.reason_required and not reason:
        raise ValidationError({'reason': "Un motif est obligatoire pour cette décision."})

    if target == Status.TRANSMITTED:
        missing = missing_fields(declaration, settings.DECLARATION_REQUIRED_FOR_TRANSMISSION)
        if missing:
            raise ValidationError({'missing_fields': missing, 'detail': (
                "Informations obligatoires manquantes : "
                + ', '.join(FIELD_LABELS.get(m, m) for m in missing))})
    if target == Status.PENDING_VALIDATION:
        from actes.services import ensure_acte
        ensure_acte(declaration, user)
        declaration = Declaration.objects.get(pk=declaration.pk)
        missing = missing_fields(declaration, settings.ACTE_REQUIRED_FOR_SUBMISSION)
        if missing:
            raise ValidationError({'missing_fields': missing, 'detail': (
                "Informations obligatoires manquantes : "
                + ', '.join(FIELD_LABELS.get(m, m) for m in missing))})
    if target == Status.IN_COMPLETION:
        from actes.services import ensure_acte
        ensure_acte(declaration, user)
    if target == Status.VALIDATED:
        from actes.services import finalize_numbering
        finalize_numbering(declaration, user, payload)

    old_status = declaration.status
    now = timezone.now()
    declaration.status = target
    declaration.updated_by = user
    if target == Status.TRANSMITTED:
        declaration.transmitted_at = now
    elif target == Status.VALIDATED:
        declaration.validated_at = now
        declaration.validated_by = user
    elif target == Status.IN_COMPLETION:
        declaration.assigned_to = user
    if t.reason_required:
        declaration.last_decision_reason = reason
    declaration.save()

    StatusHistory.objects.create(
        declaration=declaration, from_status=old_status, to_status=target,
        changed_by=user, reason=reason)
    audit.log(
        AUDIT_ACTION_BY_TARGET.get(target, AuditAction.TRANSITION), user=user, obj=declaration,
        changes={'status': {'from': old_status, 'to': target}}, reason=reason)
    return declaration
