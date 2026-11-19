"""API of the offline mode: ping, push (operations and photos), pull, history and devices."""
from django.conf import settings
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import mixins, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle, UserRateThrottle
from rest_framework.views import APIView

from accounts.authentication import device_of_token
from audit import service as audit
from audit.models import AuditAction
from core.models import get_setting
from core.permissions import AnyOf, HasWakaraPermission, user_has_perm

from . import services
from .models import Device, SyncOperation

OpType = SyncOperation.Type


class AccessLostMixin:
    """
    A signed-in, active user who is refused only because he no longer holds the right (role withdrawn…) gets the code
    ``access_lost``: the device then forgets the copies of the dossiers it holds (it keeps what is still to be sent).
    A refusal for another reason (password to change, not signed in) keeps the usual answer and wipes nothing.
    """

    def permission_denied(self, request, message=None, code=None):
        user = request.user
        if (user and user.is_authenticated and user.is_active and not getattr(user, 'must_change_password', False)
                and not getattr(user, 'must_set_up_two_factor', False)):
            raise PermissionDenied({
                'code': 'access_lost',
                'detail': "Vos droits ne permettent plus de travailler sur cet appareil : les copies de dossiers vont être effacées."})
        super().permission_denied(request, message=message, code=code)


class SyncRateThrottle(UserRateThrottle):
    scope = 'sync'


class PingRateThrottle(AnonRateThrottle):
    scope = 'sync_ping'


class RecoveryRateThrottle(UserRateThrottle):
    scope = 'recovery'


def offline_enabled() -> bool:
    return get_setting('offline.enabled', 'true').strip().lower() not in ('false', '0', 'non', 'no', 'off')


class PingView(APIView):
    """GET /api/sync/ping/ — is the server reachable, what time is it there, is the offline mode still on."""
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [PingRateThrottle]

    def get(self, request):
        response = Response({'server_time': timezone.now().isoformat(), 'offline_enabled': offline_enabled()})
        response['Cache-Control'] = 'no-store'
        return response


# ── Push ──────────────────────────────────────────

class DeviceField(serializers.Serializer):
    id = serializers.UUIDField()
    label = serializers.CharField(required=False, allow_blank=True, max_length=120, default='')


class OperationSerializer(serializers.Serializer):
    op_id = serializers.UUIDField()
    type = serializers.ChoiceField(choices=[
        OpType.DECLARATION_CREATE, OpType.DECLARATION_UPDATE, OpType.DECLARATION_TRANSMIT,
        OpType.DECLARATION_TRANSITION])
    entity_uuid = serializers.UUIDField()
    device_time = serializers.DateTimeField(required=False, allow_null=True, default=None)
    base_version = serializers.IntegerField(required=False, allow_null=True, min_value=1, default=None)
    # operation of the same dossier this one was stacked on: the version to expect is the one it produced
    after_op = serializers.UUIDField(required=False, allow_null=True, default=None)
    payload = serializers.JSONField(required=False, default=dict)

    def validate_payload(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("Contenu invalide.")
        return value


class PushSerializer(serializers.Serializer):
    device = DeviceField()
    # the user who prepared the operations on the device: nobody else may synchronise them
    user = serializers.UUIDField(required=False, allow_null=True, default=None)
    # device clock when the batch leaves: compulsory, the date checks of the server rely on it
    sent_at = serializers.DateTimeField()
    operations = OperationSerializer(many=True, allow_empty=True)

    def validate_operations(self, value):
        if len(value) > settings.SYNC_MAX_BATCH:
            raise serializers.ValidationError(
                f"Trop d'opérations dans un même envoi (maximum {settings.SYNC_MAX_BATCH}).", code='batch_too_large')
        return value


def _refuse_other_user(request, user_uuid):
    if user_uuid is not None and user_uuid != request.user.uuid:
        return Response({'code': 'user_mismatch',
                         'detail': "Ces opérations ont été préparées par un autre utilisateur."},
                        status=status.HTTP_403_FORBIDDEN)
    return None


def _binding_refusal(request, device_id=None):
    """
    The session must be bound to the device that synchronises (claim ``did`` of the token, set at sign-in).
    Without it a token stolen from a phone could be replayed under another device identifier.
    """
    bound = device_of_token(request.auth)
    if bound is None:
        return Response({'code': 'device_binding_required',
                         'detail': "Reconnectez-vous avec votre mot de passe pour associer cette session à l'appareil."},
                        status=status.HTTP_403_FORBIDDEN)
    if device_id is not None and bound != str(device_id):
        return Response({'code': 'device_mismatch',
                         'detail': "Cette session appartient à un autre appareil : synchronisation refusée."},
                        status=status.HTTP_403_FORBIDDEN)
    return None


def _device_or_refusal(request, device_id, label):
    refusal = _binding_refusal(request, device_id)
    if refusal:
        return None, refusal
    try:
        return services.get_device(request.user, device_id, label, request.META.get('HTTP_USER_AGENT', '')), None
    except services.DeviceRevoked:
        return None, Response({'code': 'device_revoked',
                               'detail': "Cet appareil a été révoqué par l'administrateur."},
                              status=status.HTTP_403_FORBIDDEN)
    except services.DeviceLimit:
        return None, Response({'code': 'device_limit',
                               'detail': "Nombre maximum d'appareils atteint pour ce compte : "
                                         "demandez à l'administrateur de révoquer un ancien appareil."},
                              status=status.HTTP_403_FORBIDDEN)


class PushView(AccessLostMixin, APIView):
    """
    POST /api/sync/push/ — a small batch of operations prepared on a device.

    Always answers 200 with one result per operation: applied | duplicate | rejected | conflict | skipped.
    Each operation is its own transaction and goes through the usual business services.
    """
    permission_classes = [HasWakaraPermission]
    # whoever can act on a dossier: the agent, the secretariat, the validator, the administrator (each operation is
    # then checked against the permission of its own step by the business service it goes through)
    required_permission = AnyOf(
        'declaration.create', 'declaration.update', 'declaration.transmit', 'acte.update', 'acte.submit',
        'acte.complete', 'dossier.validate', 'dossier.reject')
    parser_classes = [JSONParser]
    throttle_classes = [SyncRateThrottle]

    def post(self, request):
        serializer = PushSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        refusal = _refuse_other_user(request, data['user'])
        if refusal:
            return refusal
        device, refusal = _device_or_refusal(request, data['device']['id'], data['device']['label'])
        if refusal:
            return refusal
        results = services.process_batch(request.user, device, data['operations'], data['sent_at'], request)
        return Response({'server_time': timezone.now().isoformat(), 'results': results})


class DocumentPushSerializer(serializers.Serializer):
    op_id = serializers.UUIDField()
    device_id = serializers.UUIDField()
    device_label = serializers.CharField(required=False, allow_blank=True, max_length=120, default='')
    user = serializers.UUIDField(required=False, allow_null=True, default=None)
    sent_at = serializers.DateTimeField()
    device_time = serializers.DateTimeField(required=False, allow_null=True, default=None)
    uuid = serializers.UUIDField()
    declaration = serializers.UUIDField()
    kind = serializers.CharField(required=False, allow_blank=True, max_length=20, default='PAPER_FORM')
    description = serializers.CharField(required=False, allow_blank=True, max_length=255, default='')
    sha256 = serializers.RegexField(r'^[0-9a-fA-F]{64}$')
    file = serializers.FileField()

    def validate_kind(self, value):
        from documents.models import SupportingDocument
        if value and value not in SupportingDocument.Kind.values:
            raise serializers.ValidationError("Type de pièce inconnu.")
        return value or 'PAPER_FORM'


class DocumentPushView(AccessLostMixin, APIView):
    """POST /api/sync/documents/ — one photo / scan prepared offline (multipart), idempotent on ``op_id``."""
    permission_classes = [HasWakaraPermission]
    required_permission = 'document.upload'
    parser_classes = [MultiPartParser, FormParser]
    throttle_classes = [SyncRateThrottle]

    def post(self, request):
        serializer = DocumentPushSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        refusal = _refuse_other_user(request, data['user'])
        if refusal:
            return refusal
        device, refusal = _device_or_refusal(request, data['device_id'], data['device_label'])
        if refusal:
            return refusal
        op = {
            'op_id': data['op_id'], 'type': OpType.DOCUMENT_UPLOAD, 'entity_uuid': data['uuid'],
            'declaration_uuid': data['declaration'], 'device_time': data['device_time'], 'kind': data['kind'],
            'description': data['description'], 'sha256': data['sha256'].lower(), 'file': data['file'],
        }
        result = services.process_operation(request.user, device, op, data['sent_at'], request)
        return Response({'server_time': timezone.now().isoformat(), 'result': result})


class RecoveryRegisterSerializer(serializers.Serializer):
    device_id = serializers.UUIDField()
    device_label = serializers.CharField(required=False, allow_blank=True, max_length=120, default='')
    code = serializers.CharField(max_length=64, trim_whitespace=True)


class RecoveryRegisterView(AccessLostMixin, APIView):
    """
    POST /api/sync/recovery/ — the device gives the recovery code that can open its vault (see sync/recovery.py).
    The administrator can read it back to an agent who forgot his PIN. A new code replaces the previous one.
    """
    permission_classes = [HasWakaraPermission]
    required_permission = 'declaration.view'
    parser_classes = [JSONParser]
    throttle_classes = [SyncRateThrottle]

    def post(self, request):
        serializer = RecoveryRegisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        device, refusal = _device_or_refusal(request, data['device_id'], data['device_label'])
        if refusal:
            return refusal
        try:
            services.register_recovery(device, data['code'])
        except services.RecoveryCodeInvalid:
            return Response({'code': 'invalid_recovery_code', 'detail': "Code de récupération invalide."},
                            status=status.HTTP_400_BAD_REQUEST)
        return Response({'registered': True})


# ── Pull ──────────────────────────────────────────

class PullView(AccessLostMixin, APIView):
    """
    GET /api/sync/pull/?since=<cursor> — what the device keeps to work without connection: the agent's own
    dossiers, the active health facilities and the rules it must mirror. The server stays the authority.
    """
    permission_classes = [HasWakaraPermission]
    required_permission = 'declaration.view'
    throttle_classes = [SyncRateThrottle]

    def get(self, request):
        refusal = _binding_refusal(request)
        if refusal:
            return refusal
        raw = request.query_params.get('since') or ''
        since = parse_datetime(raw) if raw else None
        if raw and since is None:
            return Response({'detail': "Paramètre « since » invalide."}, status=status.HTTP_400_BAD_REQUEST)
        declarations, cursor, has_more = services.pull_declarations(request.user, since, request)
        response = Response({
            'server_time': timezone.now().isoformat(),
            'offline_enabled': offline_enabled(),
            'cursor': cursor.isoformat() if cursor else None,
            'has_more': has_more,
            'declarations': declarations,
            'recovery_registered': services.recovery_registered(request.user, device_of_token(request.auth)),
            **services.reference_data(request.user),
        })
        response['Cache-Control'] = 'private, no-store'
        return response


class ReferenceView(AccessLostMixin, APIView):
    """
    GET /api/sync/reference/ — health facilities and rules, without any dossier. The device asks for it first at
    every synchronisation: the forms must work offline even when the rest of the synchronisation could not run.
    """
    permission_classes = [HasWakaraPermission]
    required_permission = 'declaration.view'
    throttle_classes = [SyncRateThrottle]

    def get(self, request):
        refusal = _binding_refusal(request)
        if refusal:
            return refusal
        response = Response({
            'server_time': timezone.now().isoformat(), 'offline_enabled': offline_enabled(),
            'recovery_registered': services.recovery_registered(request.user, device_of_token(request.auth)),
            **services.reference_data(request.user),
        })
        response['Cache-Control'] = 'private, no-store'
        return response


# ── History and devices ───────────────────────────

class SyncOperationSerializer(serializers.ModelSerializer):
    username = serializers.CharField(source='user.username', read_only=True)
    device_label = serializers.CharField(source='device.label', read_only=True)
    type_label = serializers.CharField(source='get_op_type_display', read_only=True)
    status_label = serializers.CharField(source='get_status_display', read_only=True)

    def to_representation(self, instance):
        data = super().to_representation(instance)
        request = self.context.get('request')
        if request is not None and not user_has_perm(request.user, 'duplicate.view'):
            data['result'] = {k: v for k, v in (data.get('result') or {}).items() if k != 'duplicate_cases'}
        return data

    class Meta:
        model = SyncOperation
        fields = ['op_id', 'username', 'device_label', 'op_type', 'type_label', 'entity_uuid',
                  'declaration_uuid', 'status', 'status_label', 'result', 'error', 'device_time',
                  'effective_time', 'clock_skew_seconds', 'date_anomaly', 'attempts', 'received_at', 'applied_at']


class SyncOperationViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    """History of the synchronised operations: one's own, or everybody's with ``audit.view``."""
    queryset = SyncOperation.objects.select_related('user', 'device')
    serializer_class = SyncOperationSerializer
    permission_classes = [HasWakaraPermission]
    permission_map = {'list': 'declaration.view'}
    filterset_fields = ['status', 'op_type', 'declaration_uuid']
    ordering_fields = ['received_at']

    def get_queryset(self):
        qs = super().get_queryset()
        if user_has_perm(self.request.user, 'audit.view'):
            return qs
        return qs.filter(user=self.request.user)


class DeviceSerializer(serializers.ModelSerializer):
    username = serializers.CharField(source='user.username', read_only=True)
    user_name = serializers.SerializerMethodField()
    # whether a code is registered (never the code) and when it was last given to the agent
    has_recovery = serializers.SerializerMethodField()
    recovery_revealed_by_name = serializers.SerializerMethodField()

    class Meta:
        model = Device
        fields = ['id', 'device_id', 'username', 'user_name', 'label', 'user_agent', 'created_at',
                  'last_seen_at', 'last_sync_at', 'is_revoked', 'revoked_at',
                  'has_recovery', 'recovery_set_at', 'recovery_revealed_at', 'recovery_revealed_by_name']

    def get_user_name(self, obj):
        return obj.user.get_full_name() or obj.user.username

    def get_has_recovery(self, obj):
        return bool(obj.recovery_blob)

    def get_recovery_revealed_by_name(self, obj):
        who = obj.recovery_revealed_by
        return (who.get_full_name() or who.username) if who else ''


class DeviceViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    """Devices known to the server. Revoking one makes the server refuse everything it sends."""
    queryset = Device.objects.select_related('user', 'recovery_revealed_by')
    serializer_class = DeviceSerializer
    permission_classes = [HasWakaraPermission]
    permission_map = {'list': 'audit.view', 'revoke': 'user.manage_status', 'restore': 'user.manage_status',
                      'recovery': 'device.recover'}
    filterset_fields = ['is_revoked']
    search_fields = ['label', 'user__username']

    @action(detail=True, methods=['post'])
    def revoke(self, request, pk=None):
        device = services.set_device_revoked(self.get_object(), True, request.user)
        return Response(self.get_serializer(device).data)

    @action(detail=True, methods=['post'])
    def restore(self, request, pk=None):
        device = services.set_device_revoked(self.get_object(), False, request.user)
        return Response(self.get_serializer(device).data)

    @action(detail=True, methods=['post'], throttle_classes=[RecoveryRateThrottle])
    def recovery(self, request, pk=None):
        """
        The recovery code of the device, for an agent who forgot his PIN. The administrator confirms with his own
        password and gives a reason (both required); the reading is audited, the code is never logged.
        """
        device = self.get_object()
        reason = str(request.data.get('reason') or '').strip()
        password = request.data.get('password')
        if len(reason) < 10:
            return Response({'code': 'reason_required', 'detail':
                             "Indiquez le motif (10 caractères au moins) : il est inscrit au journal d'audit."},
                            status=status.HTTP_400_BAD_REQUEST)
        if not isinstance(password, str) or not request.user.check_password(password):
            audit.log(AuditAction.DEVICE_RECOVERY_DENIED, user=request.user, object_type='Device',
                      object_id=str(device.device_id), object_repr=f"{device.label or device.device_id} — {device.user.username}",
                      reason='Mot de passe incorrect')
            return Response({'code': 'wrong_password', 'detail': "Mot de passe incorrect."},
                            status=status.HTTP_403_FORBIDDEN)
        try:
            code = services.reveal_recovery(device, request.user, reason)
        except services.RecoveryUnavailable as exc:
            return Response({'code': exc.code, 'detail': exc.detail}, status=status.HTTP_409_CONFLICT)
        return Response({'code': code, 'recovery_set_at': device.recovery_set_at, 'device': self.get_serializer(device).data})
