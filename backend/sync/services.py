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
from core.exceptions import VersionConflict
from core.permissions import user_has_perm
from core.workflow import Status
from declarations import services as declaration_services
from declarations.models import Declaration
from declarations.serializers import DeclarationDetailSerializer, DeclarationWriteSerializer
from documents import services as document_services
from documents.models import SupportingDocument

from .models import Device, SyncOperation

OpStatus = SyncOperation.Status
OpType = SyncOperation.Type


class DeviceRevoked(Exception):
    """The administrator revoked this device: nothing it sends is accepted."""


class OperationRefused(Exception):
    """An operation the server will not apply. ``status`` is 'rejected' (wrong / forbidden) or 'conflict'."""

    def __init__(self, status, code, detail, fields=None):
        super().__init__(detail)
        self.status, self.code, self.detail, self.fields = status, code, detail, fields


# ── Devices ───────────────────────────────────────

def get_device(user, device_id, label='', user_agent=''):
    """The device of this user, registered at its first contact. Raises DeviceRevoked."""
    device, created = Device.objects.get_or_create(
        device_id=device_id, user=user,
        defaults={'label': (label or '')[:120], 'user_agent': (user_agent or '')[:255]})
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
    device.is_revoked = revoked
    device.revoked_at = timezone.now() if revoked else None
    device.revoked_by = by if revoked else None
    device.save(update_fields=['is_revoked', 'revoked_at', 'revoked_by'])
    audit.log(AuditAction.DEVICE_REVOKED if revoked else AuditAction.DEVICE_RESTORED, user=by,
              object_type='Device', object_id=str(device.device_id),
              object_repr=f"{device.label or device.device_id} — {device.user.username}")
    return device


# ── Device clock ──────────────────────────────────

def resolve_device_time(device_time, sent_at, now=None):
    """
    The moment of an action done on the device, as the server keeps it.

    The date that counts is the one of the entry on the device (business decision). A phone clock is not
    reliable, so:
      - ``sent_at`` is the device clock when the batch left; compared with the server clock it gives the
        skew of the device. Beyond the tolerance, the device time is corrected by that skew ('clock_corrected');
      - a time still in the future, or older than SYNC_MAX_DEVICE_AGE_DAYS, is not trusted: the server
        time is used instead ('future_date' / 'too_old').
    Returns (effective_time, skew_seconds or None, anomaly code or '').
    """
    now = now or timezone.now()
    if device_time is None:
        return now, None, ''
    tolerance = datetime.timedelta(seconds=settings.SYNC_CLOCK_TOLERANCE_SECONDS)
    skew, anomaly, effective = None, '', device_time
    if sent_at is not None:
        delta = now - sent_at
        skew = int(delta.total_seconds())
        if abs(delta) > tolerance:
            effective, anomaly = device_time + delta, 'clock_corrected'
    if effective > now + tolerance:
        return now, skew, 'future_date'
    if effective > now:
        effective = now
    if effective < now - datetime.timedelta(days=settings.SYNC_MAX_DEVICE_AGE_DAYS):
        return now, skew, 'too_old'
    return effective, skew, anomaly


ANOMALY_NOTES = {
    'clock_corrected': " (horloge de l'appareil décalée : heure corrigée)",
    'future_date': " (date de l'appareil dans le futur : date du serveur retenue)",
    'too_old': " (date de l'appareil trop ancienne : date du serveur retenue)",
}


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

def _own_declaration(user, uuid, lock=True):
    """The dossier targeted by an operation; only its author may work on it from a device."""
    qs = Declaration.all_objects.select_for_update() if lock else Declaration.all_objects
    declaration = qs.filter(uuid=uuid).first()
    if declaration is None:
        raise OperationRefused(OpStatus.REJECTED, 'not_found', "Ce dossier n'existe pas sur le serveur.")
    if declaration.created_by_id != user.id:
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


def _update(user, op, effective, now, anomaly):
    declaration = _own_declaration(user, op['entity_uuid'])
    if declaration.status not in Status.DECLARATION_EDITABLE:
        raise OperationRefused(
            OpStatus.CONFLICT, 'not_editable',
            f"Le dossier est maintenant « {declaration.get_status_display()} » : il ne peut plus être modifié "
            "depuis l'appareil.")
    if op.get('base_version') is None:
        raise OperationRefused(OpStatus.REJECTED, 'validation', "Version de référence manquante.")
    payload = dict(op.get('payload') or {})
    payload.pop('acte', None)
    serializer = DeclarationWriteSerializer(declaration, data=payload, partial=True)
    serializer.is_valid(raise_exception=True)
    return declaration_services.update_declaration(
        user, declaration, dict(serializer.validated_data), expected_version=op['base_version'])


def _transmit(user, op, effective, now, anomaly):
    declaration = _own_declaration(user, op['entity_uuid'])
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
    declaration = _own_declaration(user, op['declaration_uuid'], lock=False)
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


REFUSALS = (OperationRefused, VersionConflict, DRFValidationError, DjangoValidationError,
            PermissionDenied, DRFPermissionDenied)


def _declaration_uuid(op):
    return op.get('declaration_uuid') or op['entity_uuid']


def _detail(user, declaration_uuid, request):
    """Current state of the dossier for the device (None when it is not visible to this user)."""
    declaration = (Declaration.all_objects.filter(uuid=declaration_uuid, created_by=user)
                   .select_related('hospital', 'child', 'declarant', 'acte', 'created_by', 'assigned_to',
                                   'validated_by')
                   .prefetch_related('parents', 'status_history__changed_by').first())
    return serialize_declaration(declaration, request) if declaration else None


def serialize_declaration(declaration, request):
    data = dict(DeclarationDetailSerializer(declaration, context={'request': request}).data)
    data['is_archived'] = declaration.is_archived
    data['device_created_at'] = declaration.device_created_at
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
                    record.result = {'reference': obj.reference, 'status': obj.status,
                                     'sync_version': obj.sync_version}
        record.save()
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
    The agent's own dossiers changed since ``since`` (all the editable ones and the recent ones at the first
    pull), oldest change first. Returns (rows, next cursor, has_more).
    """
    qs = Declaration.all_objects.filter(created_by=user)
    if since is not None:
        qs = qs.filter(updated_at__gt=since)
    else:
        from django.db.models import Q
        recent = timezone.now() - datetime.timedelta(days=settings.SYNC_PULL_INITIAL_DAYS)
        qs = qs.filter(is_archived=False).filter(
            Q(status__in=Status.DECLARATION_EDITABLE) | Q(updated_at__gte=recent))
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
    return [serialize_declaration(d, request) for d in rows], cursor, has_more
