"""API of the offline mode: ping, push (operations and photos), pull, history and devices."""
from django.conf import settings
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import mixins, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from core.models import get_setting
from core.permissions import AnyOf, HasWakaraPermission, user_has_perm
from hospitals.models import Hospital

from . import services
from .models import Device, SyncOperation

OpType = SyncOperation.Type


def offline_enabled() -> bool:
    return get_setting('offline.enabled', 'true').strip().lower() not in ('false', '0', 'non', 'no', 'off')


class PingView(APIView):
    """GET /api/sync/ping/ — is the server reachable, what time is it there, is the offline mode still on."""
    permission_classes = [AllowAny]
    authentication_classes = []

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
        OpType.DECLARATION_CREATE, OpType.DECLARATION_UPDATE, OpType.DECLARATION_TRANSMIT])
    entity_uuid = serializers.UUIDField()
    device_time = serializers.DateTimeField(required=False, allow_null=True, default=None)
    base_version = serializers.IntegerField(required=False, allow_null=True, min_value=1, default=None)
    payload = serializers.JSONField(required=False, default=dict)

    def validate_payload(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("Contenu invalide.")
        return value


class PushSerializer(serializers.Serializer):
    device = DeviceField()
    # the user who prepared the operations on the device: nobody else may synchronise them
    user = serializers.UUIDField(required=False, allow_null=True, default=None)
    sent_at = serializers.DateTimeField(required=False, allow_null=True, default=None)
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


def _device_or_refusal(request, device_id, label):
    try:
        return services.get_device(request.user, device_id, label, request.META.get('HTTP_USER_AGENT', '')), None
    except services.DeviceRevoked:
        return None, Response({'code': 'device_revoked',
                               'detail': "Cet appareil a été révoqué par l'administrateur."},
                              status=status.HTTP_403_FORBIDDEN)


class PushView(APIView):
    """
    POST /api/sync/push/ — a small batch of operations prepared on a device.

    Always answers 200 with one result per operation: applied | duplicate | rejected | conflict | skipped.
    Each operation is its own transaction and goes through the usual business services.
    """
    permission_classes = [HasWakaraPermission]
    required_permission = AnyOf('declaration.create', 'declaration.update', 'declaration.transmit')
    parser_classes = [JSONParser]

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
    sent_at = serializers.DateTimeField(required=False, allow_null=True, default=None)
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


class DocumentPushView(APIView):
    """POST /api/sync/documents/ — one photo / scan prepared offline (multipart), idempotent on ``op_id``."""
    permission_classes = [HasWakaraPermission]
    required_permission = 'document.upload'
    parser_classes = [MultiPartParser, FormParser]

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


# ── Pull ──────────────────────────────────────────

class PullView(APIView):
    """
    GET /api/sync/pull/?since=<cursor> — what the device keeps to work without connection: the agent's own
    dossiers, the active health facilities and the rules it must mirror. The server stays the authority.
    """
    permission_classes = [HasWakaraPermission]
    required_permission = 'declaration.view'

    def get(self, request):
        raw = request.query_params.get('since') or ''
        since = parse_datetime(raw) if raw else None
        if raw and since is None:
            return Response({'detail': "Paramètre « since » invalide."}, status=status.HTTP_400_BAD_REQUEST)
        declarations, cursor, has_more = services.pull_declarations(request.user, since, request)
        hospitals = []
        if user_has_perm(request.user, 'hospital.view'):
            hospitals = [
                {'uuid': str(h['uuid']), 'code': h['code'], 'name': h['name']}
                for h in Hospital.objects.filter(is_active=True).order_by('name').values('uuid', 'code', 'name')]
        response = Response({
            'server_time': timezone.now().isoformat(),
            'offline_enabled': offline_enabled(),
            'cursor': cursor.isoformat() if cursor else None,
            'has_more': has_more,
            'declarations': declarations,
            'hospitals': hospitals,
            'rules': {
                'required_for_transmission': list(settings.DECLARATION_REQUIRED_FOR_TRANSMISSION),
                'max_upload_size': settings.MAX_UPLOAD_SIZE,
                'max_batch': settings.SYNC_MAX_BATCH,
            },
        })
        response['Cache-Control'] = 'private, no-store'
        return response


# ── History and devices ───────────────────────────

class SyncOperationSerializer(serializers.ModelSerializer):
    username = serializers.CharField(source='user.username', read_only=True)
    device_label = serializers.CharField(source='device.label', read_only=True)
    type_label = serializers.CharField(source='get_op_type_display', read_only=True)
    status_label = serializers.CharField(source='get_status_display', read_only=True)

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

    class Meta:
        model = Device
        fields = ['id', 'device_id', 'username', 'user_name', 'label', 'user_agent', 'created_at',
                  'last_seen_at', 'last_sync_at', 'is_revoked', 'revoked_at']

    def get_user_name(self, obj):
        return obj.user.get_full_name() or obj.user.username


class DeviceViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    """Devices known to the server. Revoking one makes the server refuse everything it sends."""
    queryset = Device.objects.select_related('user')
    serializer_class = DeviceSerializer
    permission_classes = [HasWakaraPermission]
    permission_map = {'list': 'audit.view', 'revoke': 'user.manage_status', 'restore': 'user.manage_status'}
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
