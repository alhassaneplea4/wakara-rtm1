"""
Offline synchronisation: applies the operations prepared on a device.

Nothing here re-implements a business rule. Every operation is replayed through the SAME services as the
online API (declarations.services, documents.services) in the name of the authenticated user, so permissions,
ownership, workflow and required fields are checked exactly as usual. This module only adds what the offline
mode needs around them: idempotence (``op_id``), the device clock checks, the version check and the trace.
"""
import datetime
import hashlib
import json

from django.conf import settings
from django.core.exceptions import PermissionDenied, ValidationError as DjangoValidationError
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied as DRFPermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError

from audit import service as audit
from audit.middleware import sync_context
from audit.models import AuditAction
from core.exceptions import IncompleteConfirmationRequired, VersionConflict
from core.permissions import user_has_perm
from core.workflow import Status
from declarations import services as declaration_services
from declarations.models import Declaration
from declarations.serializers import DeclarationDetailSerializer, DeclarationWriteSerializer
from documents import services as document_services
from documents.models import SupportingDocument

from . import recovery
from .models import Device, SyncOperation

OpStatus = SyncOperation.Status
OpType = SyncOperation.Type


class DeviceRevoked(Exception):
    """The administrator revoked this device: nothing it sends is accepted."""


class DeviceLimit(Exception):
    """The user already uses the maximum number of devices (SYNC_MAX_DEVICES_PER_USER)."""


class OperationRefused(Exception):
    """An operation the server will not apply. ``status`` is 'rejected' (wrong / forbidden) or 'conflict'."""

    def __init__(self, status, code, detail, fields=None):
        super().__init__(detail)
        self.status, self.code, self.detail, self.fields = status, code, detail, fields


# ── Devices ───────────────────────────────────────

def get_device(user, device_id, label='', user_agent=''):
    """The device of this user, registered at its first contact. Raises DeviceRevoked, DeviceLimit."""
    device = Device.objects.filter(device_id=device_id, user=user).first()
    created = device is None
    if created:
        # a new identifier: bounded, so that a user cannot multiply devices to escape a revocation or the audit
        active = Device.objects.filter(user=user, is_revoked=False).count()
        if active >= settings.SYNC_MAX_DEVICES_PER_USER:
            raise DeviceLimit()
        device = Device.objects.create(
            device_id=device_id, user=user, label=(label or '')[:120], user_agent=(user_agent or '')[:255])
    if created:
        audit.log(AuditAction.DEVICE_REGISTERED, user=user, object_type='Device', object_id=str(device_id),
                  object_repr=device.label or str(device_id))
    if device.is_revoked:
        raise DeviceRevoked()
    device.last_seen_at = timezone.now()
    if label and label[:120] != device.label:
        device.label = label[:120]
    device.save(update_fields=['last_seen_at', 'label'])
    return device


def set_device_revoked(device, revoked: bool, by):
    """
    Revoke (or restore) a device. Revoking cuts its sessions NOW: the tokens bound to the device are refused from
    the next request (see accounts.authentication) and the refresh tokens that could still serve it are blacklisted.
    """
    from accounts.tokens import revoke_device_tokens
    device.is_revoked = revoked
    device.revoked_at = timezone.now() if revoked else None
    device.revoked_by = by if revoked else None
    device.save(update_fields=['is_revoked', 'revoked_at', 'revoked_by'])
    cut = revoke_device_tokens(device.user, device.device_id) if revoked else 0
    audit.log(AuditAction.DEVICE_REVOKED if revoked else AuditAction.DEVICE_RESTORED, user=by,
              object_type='Device', object_id=str(device.device_id),
              object_repr=f"{device.label or device.device_id} — {device.user.username}",
              changes={'sessions_closed': cut} if revoked else None)
    return device


# ── Recovery code of a device (sync/recovery.py) ──

class RecoveryCodeInvalid(Exception):
    """The code sent by a device is not a recovery code (wrong length or characters)."""


class RecoveryUnavailable(Exception):
    """No recovery code is registered for this device, or it can no longer be read."""

    def __init__(self, code, detail):
        super().__init__(detail)
        self.code, self.detail = code, detail


def register_recovery(device, raw_code: str):
    """The device gives the code that can open its vault. A new code replaces the previous one."""
    code = recovery.normalize(raw_code)
    if not code:
        raise RecoveryCodeInvalid()
    device.recovery_blob = recovery.encrypt(code)
    device.recovery_set_at = timezone.now()
    device.recovery_revealed_at = None
    device.recovery_revealed_by = None
    device.save(update_fields=['recovery_blob', 'recovery_set_at', 'recovery_revealed_at', 'recovery_revealed_by'])
    # the code itself is never written anywhere but its encrypted column
    audit.log(AuditAction.DEVICE_RECOVERY_REGISTERED, user=device.user, object_type='Device',
              object_id=str(device.device_id), object_repr=f"{device.label or device.device_id} — {device.user.username}")
    return device


def recovery_registered(user, device_id) -> bool:
    """Does the server hold a readable recovery code for this device? (The device registers a new one when not.)"""
    if not device_id:
        return False
    device = Device.objects.filter(user=user, device_id=device_id).only('recovery_blob').first()
    return bool(device and recovery.decrypt(device.recovery_blob))


def reveal_recovery(device, by, reason: str) -> str:
    """
    The code, for the administrator to give to the agent who forgot his PIN. The reading is audited with its reason
    and marked on the device. Raises RecoveryUnavailable when there is nothing to read.
    """
    if not device.recovery_blob:
        raise RecoveryUnavailable(
            'no_recovery', "Cet appareil n'a pas enregistré de code de récupération : l'agent doit le déverrouiller "
                           "avec son code, avec Internet, pour qu'il en enregistre un.")
    code = recovery.decrypt(device.recovery_blob)
    if code is None:
        raise RecoveryUnavailable(
            'recovery_unreadable', "Le code de récupération de cet appareil ne peut plus être lu (clé de chiffrement "
                                   "modifiée). L'appareil en enregistrera un nouveau à son prochain déverrouillage avec Internet.")
    device.recovery_revealed_at = timezone.now()
    device.recovery_revealed_by = by
    device.save(update_fields=['recovery_revealed_at', 'recovery_revealed_by'])
    audit.log(AuditAction.DEVICE_RECOVERY_REVEALED, user=by, object_type='Device', object_id=str(device.device_id),
              object_repr=f"{device.label or device.device_id} — {device.user.username}", reason=reason)
    return code


# ── Device clock ──────────────────────────────────

def resolve_device_time(device_time, sent_at, now=None):
    """
    The moment of an action done on the device, as the server keeps it.

    The date that counts is the one of the entry on the device (business decision), but a phone clock is both
    unreliable and under the control of whoever holds the phone, so it is never taken at face value:

      - ``sent_at`` (the device clock when the batch left) is compulsory: without it the clock cannot be checked and
        the server time is used ('clock_unverified');
      - the skew against the server clock is measured; up to ``SYNC_CLOCK_TOLERANCE_SECONDS`` it is ignored, up to
        ``SYNC_MAX_CLOCK_SKEW_HOURS`` the device time is corrected by it ('clock_corrected'), beyond that the clock is
        not trusted at all and the server time is used ('clock_untrusted') — a crafted ``sent_at`` can therefore not
        be used to move an entry far back in time;
      - a time still in the future, or older than ``SYNC_MAX_DEVICE_AGE_DAYS``, is not trusted: server time
        ('future_date' / 'too_old');
      - an entry older than ``SYNC_LATE_ENTRY_DAYS`` is kept but flagged ('late_entry') for the secretariat to check.
    Returns (effective_time, skew_seconds or None, anomaly code or '').
    """
    now = now or timezone.now()
    if device_time is None:
        return now, None, ''
    if sent_at is None:
        return now, None, 'clock_unverified'
    delta = now - sent_at
    skew = int(delta.total_seconds())
    if abs(delta) > datetime.timedelta(hours=settings.SYNC_MAX_CLOCK_SKEW_HOURS):
        return now, skew, 'clock_untrusted'
    tolerance = datetime.timedelta(seconds=settings.SYNC_CLOCK_TOLERANCE_SECONDS)
    effective, anomaly = device_time, ''
    if abs(delta) > tolerance:
        effective, anomaly = device_time + delta, 'clock_corrected'
    if effective > now + tolerance:
        return now, skew, 'future_date'
    if effective > now:
        effective = now
    if effective < now - datetime.timedelta(days=settings.SYNC_MAX_DEVICE_AGE_DAYS):
        return now, skew, 'too_old'
    if not anomaly and effective < now - datetime.timedelta(days=settings.SYNC_LATE_ENTRY_DAYS):
        anomaly = 'late_entry'
    return effective, skew, anomaly


ANOMALY_NOTES = {
    'clock_corrected': " (horloge de l'appareil décalée : heure corrigée)",
    'clock_untrusted': " (horloge de l'appareil trop décalée : date du serveur retenue)",
    'clock_unverified': " (horloge de l'appareil non vérifiable : date du serveur retenue)",
    'future_date': " (date de l'appareil dans le futur : date du serveur retenue)",
    'too_old': " (date de l'appareil trop ancienne : date du serveur retenue)",
    'before_birth': " (date de l'appareil antérieure à la naissance : date du serveur retenue)",
    'late_entry': " (saisie ancienne : date de l'appareil conservée, à vérifier)",
}
# Anomalies after which the date of the device is NOT the one kept: worth an audit event of their own.
DISTRUSTED_ANOMALIES = ('clock_untrusted', 'clock_unverified', 'future_date', 'too_old', 'before_birth')


def _birth_date_of(op):
    """Birth date the operation refers to (the one in its payload, else the one of the dossier on the server)."""
    raw = (op.get('payload') or {}).get('birth_date') if op['type'] != OpType.DOCUMENT_UPLOAD else None
    if raw:
        try:
            return datetime.date.fromisoformat(str(raw)[:10])
        except ValueError:
            return None
    return (Declaration.all_objects.filter(uuid=_declaration_uuid(op)).values_list('birth_date', flat=True).first())


def _not_before_birth(op, effective, anomaly, now):
    """An entry cannot precede the birth it declares: such a date is a forgery or a clock error."""
    birth = _birth_date_of(op)
    if birth is not None and timezone.localtime(effective).date() < birth:
        return now, 'before_birth'
    return effective, anomaly


def _offline_note(verb, effective, now, anomaly):
    """History comment of a deferred action, e.g. « Saisie hors connexion le 10/11/2026 à 14:32 »."""
    deferred = (now - effective) > datetime.timedelta(seconds=settings.SYNC_CLOCK_TOLERANCE_SECONDS)
    if not deferred and not anomaly:
        return ''
    local = timezone.localtime(effective)
    return (f"{verb} hors connexion le {local:%d/%m/%Y} à {local:%H:%M}, synchronisée le "
            f"{timezone.localtime(now):%d/%m/%Y} à {timezone.localtime(now):%H:%M}"
            + ANOMALY_NOTES.get(anomaly, '') + '.')


# ── Operations ────────────────────────────────────

def _reachable_declaration(user, uuid, lock=True):
    """
    The dossier targeted by an operation. A device works on what its user may see online and nothing else: the
    agent on his own dossiers, the secretariat and the administrator on those of the whole mairie
    (``declaration_services.visible_declarations``). Every business rule is then checked again by the service
    the operation goes through.
    """
    qs = Declaration.all_objects.select_for_update() if lock else Declaration.all_objects
    declaration = qs.filter(uuid=uuid).first()
    if declaration is None:
        raise OperationRefused(OpStatus.REJECTED, 'not_found', "Ce dossier n'existe pas sur le serveur.")
    if not declaration_services.visible_declarations(user, Declaration.all_objects.filter(pk=declaration.pk)).exists():
        raise OperationRefused(OpStatus.REJECTED, 'forbidden', "Ce dossier appartient à un autre utilisateur.")
    if declaration.is_archived:
        raise OperationRefused(OpStatus.CONFLICT, 'archived', "Ce dossier a été archivé sur le serveur.")
    return declaration


def _create(user, op, effective, now, anomaly):
    if not user_has_perm(user, 'declaration.create'):
        raise PermissionDenied("Permission requise : declaration.create")
    existing = Declaration.all_objects.filter(uuid=op['entity_uuid']).first()
    if existing is not None:
        if existing.created_by_id != user.id:
            raise OperationRefused(OpStatus.REJECTED, 'uuid_taken', "Cet identifiant de dossier est déjà utilisé.")
        return existing  # created by an earlier push whose answer never reached the device
    payload = dict(op.get('payload') or {})
    payload.pop('acte', None)  # the acte belongs to the secretariat, never to a device
    serializer = DeclarationWriteSerializer(data=payload)
    serializer.is_valid(raise_exception=True)
    return declaration_services.create_declaration(
        user, dict(serializer.validated_data), uuid=op['entity_uuid'], device_created_at=effective,
        history_note=_offline_note('Saisie', effective, now, anomaly))


def _expected_version(user, op):
    """
    The version of the dossier this operation was prepared against.
      - an operation prepared on the version the device had read carries it (``base_version``);
      - an operation stacked on an earlier one of the same dossier (``after_op``) expects the version THAT one
        produced, so a change made by somebody else in between is still detected and the user's own earlier
        operations never cause a conflict;
      - None when there is nothing to compare with (no reference at all).
    """
    if op.get('base_version') is not None:
        return op['base_version']
    previous = op.get('after_op')
    if not previous:
        return None
    record = SyncOperation.objects.filter(
        op_id=previous, user=user, declaration_uuid=_declaration_uuid(op), status=OpStatus.APPLIED).first()
    version = (record.result or {}).get('sync_version') if record else None
    if not version:
        raise OperationRefused(OpStatus.CONFLICT, 'blocked',
                               "L'opération précédente de ce dossier n'est pas encore appliquée par le serveur.")
    return version


def _update(user, op, effective, now, anomaly):
    declaration = _reachable_declaration(user, op['entity_uuid'])
    if not declaration_services.can_edit_data(user, declaration):
        raise OperationRefused(
            OpStatus.CONFLICT, 'not_editable',
            f"Le dossier est maintenant « {declaration.get_status_display()} » : il ne peut plus être modifié "
            "depuis l'appareil.")
    expected = _expected_version(user, op)
    if expected is None:
        raise OperationRefused(OpStatus.REJECTED, 'validation', "Version de référence manquante.")
    payload = dict(op.get('payload') or {})
    if not user_has_perm(user, 'acte.update'):
        payload.pop('acte', None)  # the registry header belongs to the secretariat, never to a collection device
    serializer = DeclarationWriteSerializer(declaration, data=payload, partial=True)
    serializer.is_valid(raise_exception=True)
    return declaration_services.update_declaration(
        user, declaration, dict(serializer.validated_data), expected_version=expected)


# Decisions taken on what the device showed: refused when the dossier changed since (see _transition).
_NUMBERING_FIELDS = ('annee', 'registre', 'feuillet', 'numero_acte', 'accept_incomplete')


def _transition(user, op, effective, now, anomaly):
    """
    A step of the workflow taken on the device (take over, submit to validation, validate, send back, reject).
    The transition table, the permission of each step, the required data and the official numbering are those of
    the online API: the service is the same. What the device adds is a guard against deciding on stale data:
    ``from_status`` (the step the device saw) must still be the current one, and ``base_version`` — when the
    device had no pending change of its own on the dossier — must still be its version.
    """
    from declarations.serializers import TransitionSerializer
    declaration = _reachable_declaration(user, op['entity_uuid'])
    payload = dict(op.get('payload') or {})
    seen = payload.pop('from_status', None)
    serializer = TransitionSerializer(data=payload)
    serializer.is_valid(raise_exception=True)
    data = serializer.validated_data
    if seen and declaration.status != seen:
        raise OperationRefused(
            OpStatus.CONFLICT, 'status_changed',
            f"Le dossier est passé de « {dict(Status.CHOICES).get(seen, seen)} » à « {declaration.get_status_display()} » "
            "sur le serveur depuis votre décision : elle n'est pas appliquée.")
    expected = _expected_version(user, op)
    if expected is not None and declaration.sync_version != expected:
        raise VersionConflict(expected, declaration.sync_version)
    note = _offline_note('Décision prise' if data['status'] != Status.PENDING_VALIDATION else 'Soumission faite',
                         effective, now, anomaly)
    return declaration_services.transition_status(
        declaration.pk, data['status'], user, reason=data.get('reason', ''),
        payload={k: data[k] for k in _NUMBERING_FIELDS if k in data},
        device_time=effective if data['status'] == Status.TRANSMITTED else None, history_note=note)


def _transmit(user, op, effective, now, anomaly):
    declaration = _reachable_declaration(user, op['entity_uuid'])
    if declaration.status not in Status.DECLARATION_EDITABLE:
        raise OperationRefused(
            OpStatus.CONFLICT, 'invalid_transition',
            f"Le dossier est déjà « {declaration.get_status_display()} » sur le serveur.")
    return declaration_services.transition_status(
        declaration.pk, Status.TRANSMITTED, user, device_time=effective,
        history_note=_offline_note('Transmise', effective, now, anomaly))


def _upload(user, op, effective, now, anomaly):
    if not user_has_perm(user, 'document.upload'):
        raise PermissionDenied("Permission requise : document.upload")
    existing = SupportingDocument.all_objects.filter(uuid=op['entity_uuid']).first()
    if existing is not None:
        if existing.uploaded_by_id != user.id:
            raise OperationRefused(OpStatus.REJECTED, 'uuid_taken', "Cet identifiant de pièce est déjà utilisé.")
        return existing
    declaration = _reachable_declaration(user, op['declaration_uuid'], lock=False)
    upload = op['file']
    error = document_services.upload_error(upload)
    if error:
        raise OperationRefused(OpStatus.REJECTED, 'validation', error, fields={'file': [error]})
    return document_services.store_document(
        user, declaration, upload, kind=op.get('kind') or SupportingDocument.Kind.PAPER_FORM,
        description=op.get('description', ''), uuid=op['entity_uuid'], expected_sha256=op.get('sha256'))


HANDLERS = {
    OpType.DECLARATION_CREATE: _create,
    OpType.DECLARATION_UPDATE: _update,
    OpType.DECLARATION_TRANSMIT: _transmit,
    OpType.DOCUMENT_UPLOAD: _upload,
    OpType.DECLARATION_TRANSITION: _transition,
}


def _payload_hash(op) -> str:
    if op['type'] == OpType.DOCUMENT_UPLOAD:
        return (op.get('sha256') or '')[:64]
    body = json.dumps(op.get('payload') or {}, sort_keys=True, default=str)
    return hashlib.sha256(body.encode('utf-8')).hexdigest()


def _flatten(detail):
    """A readable sentence out of a DRF / Django validation detail."""
    if isinstance(detail, dict):
        return ' — '.join(_flatten(v) for k, v in detail.items() if k not in ('code', 'missing_fields'))
    if isinstance(detail, (list, tuple)):
        return ' '.join(_flatten(v) for v in detail)
    return str(detail)


def _refusal(exc):
    """(status, error dict) for an exception raised while applying an operation."""
    if isinstance(exc, OperationRefused):
        return exc.status, {'code': exc.code, 'detail': exc.detail, **({'fields': exc.fields} if exc.fields else {})}
    if isinstance(exc, VersionConflict):
        return OpStatus.CONFLICT, {'code': 'version_conflict', 'detail': str(exc),
                                   'expected_version': exc.expected, 'current_version': exc.current}
    if isinstance(exc, IncompleteConfirmationRequired):
        return OpStatus.REJECTED, {
            'code': 'incomplete_confirmation_required',
            'detail': "Des champs attendus ne sont pas renseignés : " + ', '.join(exc.labels)
                      + ". Rouvrez le dossier, confirmez la validation puis synchronisez de nouveau.",
            'missing_fields': exc.missing}
    if isinstance(exc, DRFValidationError):
        return OpStatus.REJECTED, {'code': 'validation', 'detail': _flatten(exc.detail), 'fields': exc.detail}
    if isinstance(exc, DjangoValidationError):
        code = getattr(exc, 'code', None)
        if hasattr(exc, 'error_dict'):
            fields = exc.message_dict
            detail = _flatten(fields.get('detail') or fields)
        else:
            fields, detail = None, ' '.join(exc.messages)
        if code == 'invalid_transition':
            return OpStatus.CONFLICT, {'code': 'invalid_transition', 'detail': detail}
        return OpStatus.REJECTED, {'code': code or 'validation', 'detail': detail,
                                   **({'fields': fields} if fields else {})}
    if isinstance(exc, (PermissionDenied, DRFPermissionDenied)):
        return OpStatus.REJECTED, {'code': 'forbidden', 'detail': str(exc) or "Action non autorisée."}
    raise exc


REFUSALS = (OperationRefused, VersionConflict, IncompleteConfirmationRequired, DRFValidationError,
            DjangoValidationError, PermissionDenied, DRFPermissionDenied)


def _declaration_uuid(op):
    return op.get('declaration_uuid') or op['entity_uuid']


def _detail(user, declaration_uuid, request):
    """Current state of the dossier for the device (None when it is not visible to this user)."""
    declaration = (declaration_services.visible_declarations(user, Declaration.all_objects.filter(uuid=declaration_uuid))
                   .select_related('hospital', 'child', 'declarant', 'acte', 'created_by', 'assigned_to',
                                   'validated_by')
                   .prefetch_related('parents', 'status_history__changed_by').first())
    return serialize_declaration(declaration, request) if declaration else None


def serialize_declaration(declaration, request, hidden=False):
    """
    The dossier as the device keeps it: the usual detail + what a screen of the secretariat needs without the
    network (the registry header of the acte). ``hidden``: no longer listed (redundant entry of a confirmed
    duplicate) — the device drops its copy exactly as for an archived dossier.
    """
    data = dict(DeclarationDetailSerializer(declaration, context={'request': request}).data)
    data['is_archived'] = declaration.is_archived or hidden
    data['device_created_at'] = declaration.device_created_at
    acte = getattr(declaration, 'acte', None)
    if acte is not None and user_has_perm(request.user, 'acte.view'):
        from actes.serializers import ActeSerializer
        data['acte'] = dict(ActeSerializer(acte, context={'request': request}).data)
    return data


def _answer(record, user, request, *, duplicate=False):
    status = 'duplicate' if duplicate else record.status
    answer = {
        'op_id': str(record.op_id), 'type': record.op_type, 'status': status,
        'entity_uuid': str(record.entity_uuid), 'date_anomaly': record.date_anomaly,
        'error': record.error or None,
        'declaration': _detail(user, record.declaration_uuid, request) if record.declaration_uuid else None,
    }
    if record.op_type == OpType.DOCUMENT_UPLOAD and record.status == OpStatus.APPLIED:
        answer['document'] = record.result
    elif (record.status == OpStatus.APPLIED and (record.result or {}).get('duplicate_cases')
          and user_has_perm(user, 'duplicate.view')):
        # only for the control centre: telling a collection agent that what he typed looks like an existing birth
        # would let him query the civil register
        answer['duplicate_cases'] = record.result['duplicate_cases']
    return answer


def process_operation(user, device, op, sent_at, request):
    """
    Apply one operation in its own transaction and return the answer for the device.

    The trace row is taken first and locked: a replay of the same ``op_id`` (answer lost, double tap, two
    tabs) waits for the first one and then gets its result, it never applies twice. A refused operation
    rolls back its own changes only; its trace and the audit event stay.
    """
    now = timezone.now()
    effective, skew, anomaly = resolve_device_time(op.get('device_time'), sent_at, now)
    effective, anomaly = _not_before_birth(op, effective, anomaly, now)
    with transaction.atomic():
        record, created = SyncOperation.objects.select_for_update().get_or_create(
            op_id=op['op_id'],
            defaults={
                'user': user, 'device': device, 'op_type': op['type'], 'entity_uuid': op['entity_uuid'],
                'declaration_uuid': _declaration_uuid(op), 'payload_hash': _payload_hash(op),
                'status': OpStatus.REJECTED, 'device_time': op.get('device_time'), 'effective_time': effective,
                'clock_skew_seconds': skew, 'date_anomaly': anomaly,
            })
        if not created:
            if record.user_id != user.id:
                return {'op_id': str(op['op_id']), 'type': op['type'], 'status': OpStatus.REJECTED,
                        'entity_uuid': str(op['entity_uuid']), 'date_anomaly': '', 'declaration': None,
                        'error': {'code': 'forbidden', 'detail': "Cette opération appartient à un autre utilisateur."}}
            if record.status == OpStatus.APPLIED:
                return _answer(record, user, request, duplicate=True)
            record.attempts += 1
            record.device, record.payload_hash = device, _payload_hash(op)
            record.device_time, record.effective_time = op.get('device_time'), effective
            record.clock_skew_seconds, record.date_anomaly = skew, anomaly

        with sync_context(op_id=record.op_id, device_id=device.device_id, device_time=effective):
            try:
                with transaction.atomic():
                    obj = HANDLERS[op['type']](user, op, effective, now, anomaly)
            except REFUSALS as exc:
                record.status, record.error = _refusal(exc)
                record.result, record.applied_at = {}, None
                audit.log(
                    AuditAction.SYNC_CONFLICT if record.status == OpStatus.CONFLICT else AuditAction.SYNC_REJECTED,
                    user=user, object_type='Declaration', object_id=str(record.declaration_uuid),
                    changes={'operation': op['type'], 'code': record.error.get('code'),
                             'detail': record.error.get('detail')})
            else:
                record.status, record.error, record.applied_at = OpStatus.APPLIED, {}, now
                if op['type'] == OpType.DOCUMENT_UPLOAD:
                    record.result = {'uuid': str(obj.uuid), 'original_name': obj.original_name,
                                     'size': obj.size, 'sha256': obj.sha256}
                else:
                    # the version AFTER the operation, read back: later operations of the dossier expect this one
                    version = (Declaration.all_objects.filter(pk=obj.pk).values_list('sync_version', flat=True).first()
                               or obj.sync_version)
                    record.result = {'reference': obj.reference, 'status': obj.status, 'sync_version': version}
                    # duplicate control: the declaration is kept; a case for a human is opened if it looks like another
                    from duplicates.services.cases import DuplicateCaseService
                    cases = DuplicateCaseService.status_for(obj)['open_cases']
                    if cases:
                        record.result['duplicate_cases'] = [
                            {'reference': c['reference'], 'risk_level': c['risk_level']} for c in cases]
        record.save()
        if created and anomaly in DISTRUSTED_ANOMALIES + ('late_entry',):
            audit.log(AuditAction.SYNC_DATE_ANOMALY, user=user, object_type='Declaration',
                      object_id=str(record.declaration_uuid), changes={
                          'anomaly': anomaly, 'operation': op['type'], 'device_time': op.get('device_time'),
                          'kept': effective, 'server_time': now, 'skew_seconds': skew, 'device': str(device.device_id)})
        if record.status == OpStatus.APPLIED:
            Device.objects.filter(pk=device.pk).update(last_sync_at=now)
        return _answer(record, user, request)


def process_batch(user, device, operations, sent_at, request):
    """
    Apply the operations in the order given by the device. When one is refused, the following operations
    of the SAME dossier are not attempted ('skipped'): they were prepared on top of it.
    """
    answers, blocked = [], set()
    for op in operations:
        key = str(_declaration_uuid(op))
        if key in blocked:
            answers.append({
                'op_id': str(op['op_id']), 'type': op['type'], 'status': 'skipped',
                'entity_uuid': str(op['entity_uuid']), 'date_anomaly': '', 'declaration': None,
                'error': {'code': 'blocked', 'detail': "En attente : une opération précédente du même dossier a été refusée."}})
            continue
        answer = process_operation(user, device, op, sent_at, request)
        if answer['status'] in (OpStatus.REJECTED, OpStatus.CONFLICT):
            blocked.add(key)
        answers.append(answer)
    return answers


# ── Pull ──────────────────────────────────────────

def pull_declarations(user, since, request):
    """
    The dossiers this user works on, changed since ``since``, oldest change first. Returns (rows, next cursor,
    has_more). The scope is the one of the online API (``visible_declarations``): an agent receives his own
    dossiers, the secretariat and the administrator those of the mairie. At the first pull: everything still
    in progress (to complete, to validate, to correct) and what changed recently — a long closed history is
    not needed to work without connection and stays reachable online.
    """
    from django.db.models import Q
    qs = declaration_services.visible_declarations(user, Declaration.all_objects.all())
    if settings.SYNC_PULL_SETTLE_SECONDS:
        qs = qs.filter(updated_at__lte=timezone.now() - datetime.timedelta(seconds=settings.SYNC_PULL_SETTLE_SECONDS))
    if since is not None:
        qs = qs.filter(updated_at__gt=since)
    else:
        recent = timezone.now() - datetime.timedelta(days=settings.SYNC_PULL_INITIAL_DAYS)
        qs = qs.filter(is_archived=False).filter(~Q(status__in=Status.FROZEN) | Q(updated_at__gte=recent))
    qs = (qs.select_related('hospital', 'child', 'declarant', 'acte', 'created_by', 'assigned_to', 'validated_by')
          .prefetch_related('parents', 'status_history__changed_by').order_by('updated_at', 'id'))
    size = settings.SYNC_PULL_PAGE_SIZE
    rows = list(qs[:size + 1])
    has_more = len(rows) > size
    rows = rows[:size]
    if has_more:
        # never cut between two rows sharing the same timestamp: the cursor would skip the second one
        last = rows[-1].updated_at
        rows += list(qs.filter(updated_at=last).exclude(pk__in=[r.pk for r in rows]))
    cursor = rows[-1].updated_at if rows else since
    # dossiers rejected as the redundant entry of a confirmed duplicate are no longer listed: the device drops them
    listed = set(declaration_services.listed_declarations(
        Declaration.all_objects.filter(pk__in=[r.pk for r in rows])).values_list('pk', flat=True))
    return [serialize_declaration(d, request, hidden=d.pk not in listed) for d in rows], cursor, has_more


def reference_data(user):
    """
    What a device needs to fill and check a form without the network, and which does not depend on any dossier:
    the active health facilities and the rules to mirror. Served on its own (``/sync/reference/``) as well as
    with every pull, so that a failure of the dossier synchronisation never leaves the device without it.
    """
    from hospitals.models import Hospital
    hospitals = []
    if any(user_has_perm(user, p) for p in ('hospital.view', 'declaration.create', 'declaration.update', 'acte.update')):
        hospitals = [
            {'uuid': str(h['uuid']), 'code': h['code'], 'name': h['name']}
            for h in Hospital.objects.filter(is_active=True).order_by('name').values('uuid', 'code', 'name')]
    return {
        'hospitals': hospitals,
        'rules': {
            'required_for_transmission': list(settings.DECLARATION_REQUIRED_FOR_TRANSMISSION),
            'required_for_submission': list(settings.ACTE_REQUIRED_FOR_SUBMISSION),
            'expected_for_validation': list(settings.VALIDATION_EXPECTED_FIELDS),
            'deadline_months': settings.DOSSIER_DEADLINE_MONTHS,
            'auto_numbering': bool(settings.ACTE_AUTO_NUMBERING),
            'separate_submit_and_validate': bool(settings.DOSSIER_SEPARATE_SUBMIT_AND_VALIDATE),
            'max_upload_size': settings.MAX_UPLOAD_SIZE,
            'max_batch': settings.SYNC_MAX_BATCH,
        },
    }
