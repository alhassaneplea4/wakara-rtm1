"""
Acte business logic: dossier creation, official numbering, printing, delivery, document model.

OFFICIAL NUMBERING: the attribution rule has not been confirmed by the mairie. Therefore:
  - by default the official number is entered manually by the validating administrator,
    and uniqueness per (year, registry) is guaranteed by a DB constraint + transaction;
  - automatic sequential numbering per (year, registry) is available only when
    ``ACTE_AUTO_NUMBERING`` is enabled in the environment.
"""
from django.conf import settings
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone

from audit import service as audit
from audit.models import AuditAction
from core.models import get_setting
from core.workflow import Status
from declarations.models import Declaration, StatusHistory

from .models import Acte, Delivery, NumberSequence, PrintLog


def ensure_acte(declaration: Declaration, user) -> Acte:
    """Create the acte dossier (idempotent) with the configured geographic defaults."""
    acte = Acte.all_objects.filter(declaration=declaration).first()
    if acte:
        return acte
    acte = Acte.objects.create(
        declaration=declaration,
        annee=declaration.birth_date.year if declaration.birth_date else None,
        region=get_setting('acte.default_region'),
        prefecture=get_setting('acte.default_prefecture'),
        commune=get_setting('acte.default_commune'),
        centre=get_setting('acte.default_centre'),
        created_by=user, updated_by=user,
    )
    audit.log(AuditAction.CREATE, user=user, obj=acte, changes={'declaration': declaration.reference})
    return acte


def can_edit_acte(user, acte) -> bool:
    from core.permissions import user_has_perm
    return acte.declaration.status in Status.ACTE_EDITABLE and user_has_perm(user, 'acte.update')


@transaction.atomic
def assign_official_number(acte: Acte, user, *, annee=None, registre=None, feuillet=None,
                           numero_acte=None) -> Acte:
    """
    Attribute (or confirm) the official number. Transactional, checked server-side.
    Manual number: validated + unique per (annee, registre).
    Auto mode (only if enabled): next value of the (annee, registre) sequence, row-locked.
    """
    acte = Acte.all_objects.select_for_update().get(pk=acte.pk)
    if acte.numero_acte:
        return acte  # already attributed: never overwritten

    if annee is not None:
        acte.annee = annee
    if registre is not None:
        acte.registre = registre
    if feuillet is not None:
        acte.feuillet = feuillet
    if not acte.annee:
        raise ValidationError({'annee': "L'année du registre est requise pour attribuer le numéro."})

    numero_acte = (numero_acte or '').strip()
    if not numero_acte:
        if not settings.ACTE_AUTO_NUMBERING:
            raise ValidationError({'numero_acte': (
                "Le numéro officiel de l'acte est requis (la numérotation automatique "
                "n'est pas activée : règle à confirmer par la mairie).")})
        seq, _ = NumberSequence.objects.select_for_update().get_or_create(
            annee=acte.annee, registre=acte.registre)
        seq.last_value += 1
        seq.save(update_fields=['last_value'])
        numero_acte = str(seq.last_value)

    clash = Acte.all_objects.filter(
        annee=acte.annee, registre=acte.registre, numero_acte=numero_acte).exclude(pk=acte.pk)
    if clash.exists():
        raise ValidationError({'numero_acte': "Ce numéro est déjà attribué dans ce registre."})

    acte.numero_acte = numero_acte
    acte.numero_assigned_at = timezone.now()
    acte.numero_assigned_by = user
    acte.updated_by = user
    try:
        with transaction.atomic():
            acte.save()
    except IntegrityError:
        raise ValidationError({'numero_acte': "Ce numéro est déjà attribué dans ce registre."})
    audit.log(AuditAction.NUMBER_ASSIGNED, user=user, obj=acte,
              changes={'annee': acte.annee, 'registre': acte.registre, 'numero_acte': numero_acte})
    return acte


def finalize_numbering(declaration: Declaration, user, payload: dict) -> Acte:
    """Called by the workflow when a dossier is validated."""
    acte = ensure_acte(declaration, user)
    return assign_official_number(
        acte, user,
        annee=payload.get('annee'), registre=payload.get('registre'),
        feuillet=payload.get('feuillet'), numero_acte=payload.get('numero_acte'),
    )


# ── Document model ────────────────────────────────

def build_document(acte: Acte) -> dict:
    """
    Structured content of the acte for the (frontend-rendered) printable model.
    ``is_official`` is False until the dossier is validated: previews must then show a
    "projet — sans valeur juridique" mention.
    """
    d = acte.declaration
    child = getattr(d, 'child', None)
    parents = {p.parent_type: p for p in d.parents.all()}
    declarant = getattr(d, 'declarant', None)

    def person(p):
        if not p:
            return None
        return {
            'first_names': p.first_names, 'last_name': p.last_name,
            'date_of_birth': getattr(p, 'date_of_birth', None),
            'birth_place': getattr(p, 'birth_place', ''),
            'age': getattr(p, 'age', None), 'nationality': getattr(p, 'nationality', ''),
            'profession': p.profession, 'address': p.address,
        }

    return {
        'is_official': d.status in (Status.VALIDATED, Status.DELIVERED),
        'status': d.status,
        'reference': d.reference,
        'official_number': acte.numero_acte,
        'annee': acte.annee, 'registre': acte.registre, 'feuillet': acte.feuillet,
        'region': acte.region, 'prefecture': acte.prefecture,
        'commune': acte.commune, 'centre': acte.centre,
        'declaration_date': acte.declaration_date,
        'child': {
            'first_names': child.first_names if child else '',
            'last_name': child.last_name if child else '',
            'gender': child.gender if child else '',
            'birth_date': d.birth_date, 'birth_time': d.birth_time, 'birth_place': d.birth_place,
        },
        'father': person(parents.get('FATHER')),
        'mother': person(parents.get('MOTHER')),
        'declarant': {**person(declarant), 'relationship': declarant.relationship} if declarant else None,
        'hospital': d.hospital.name if d.hospital else '',
        'mentions': acte.mentions,
        'officer_name': acte.officer_name,
        'validated_at': d.validated_at,
    }


# ── Printing & delivery ───────────────────────────

def _require_official(acte: Acte):
    if acte.declaration.status not in (Status.VALIDATED, Status.DELIVERED):
        raise ValidationError(
            "Impression et délivrance ne sont possibles qu'après la validation définitive.",
            code='not_validated')


@transaction.atomic
def record_print(acte: Acte, user) -> PrintLog:
    _require_official(acte)
    count = PrintLog.objects.filter(acte=acte).count()
    log = PrintLog.objects.create(acte=acte, printed_by=user, copy_number=count + 1)
    audit.log(AuditAction.PRINT, user=user, obj=acte, changes={'copy_number': log.copy_number})
    return log


@transaction.atomic
def record_delivery(acte: Acte, user, data: dict) -> Delivery:
    """First delivery moves the dossier to DELIVERED; later ones are flagged as duplicates."""
    declaration = Declaration.objects.select_for_update().get(pk=acte.declaration_id)
    if declaration.status not in (Status.VALIDATED, Status.DELIVERED):
        raise ValidationError("Seul un acte validé peut être délivré.", code='not_validated')
    is_duplicate = declaration.status == Status.DELIVERED
    delivery = Delivery.objects.create(
        acte=acte, delivered_by=user, is_duplicate=is_duplicate,
        delivered_at=data.pop('delivered_at', None) or timezone.now(), **data)
    if not is_duplicate:
        old = declaration.status
        declaration.status = Status.DELIVERED
        declaration.updated_by = user
        declaration.save()
        StatusHistory.objects.create(declaration=declaration, from_status=old,
                                     to_status=Status.DELIVERED, changed_by=user,
                                     reason=f"Remis à {delivery.recipient_name}")
    audit.log(AuditAction.DELIVER, user=user, obj=acte,
              changes={'recipient': delivery.recipient_name, 'duplicate': is_duplicate})
    return delivery
