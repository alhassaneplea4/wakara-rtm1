from django_filters import rest_framework as filters
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from audit import service as audit
from audit.models import AuditAction
from core.permissions import HasWakaraPermission
from core.workflow import Status
from declarations.services import visible_declarations

from . import services
from .models import Acte, Delivery
from .serializers import (
    ActeListSerializer, ActeSerializer, ActeUpdateSerializer, DeliveryCreateSerializer,
    DeliverySerializer, PrintLogSerializer,
)


class ActeFilter(filters.FilterSet):
    status = filters.MultipleChoiceFilter(field_name='declaration__status', choices=Status.CHOICES)
    hospital = filters.UUIDFilter(field_name='declaration__hospital__uuid')

    class Meta:
        model = Acte
        fields = ['status', 'hospital', 'annee', 'registre']


class ActeViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.UpdateModelMixin,
                  viewsets.GenericViewSet):
    """Acte dossiers. Created automatically by the workflow; never deleted."""
    queryset = Acte.objects.select_related('declaration__hospital', 'declaration__child')
    permission_classes = [HasWakaraPermission]
    lookup_field = 'uuid'
    filterset_class = ActeFilter
    http_method_names = ['get', 'patch', 'post', 'head', 'options']
    search_fields = ['numero_acte', 'declaration__reference', 'declaration__child__last_name',
                     'declaration__child__first_names']
    ordering_fields = ['updated_at', 'numero_acte', 'annee']
    permission_map = {
        'list': 'acte.view', 'retrieve': 'acte.view',
        'partial_update': 'acte.update',
        'document': 'acte.view', 'print_acte': 'acte.print',
        'deliver': 'acte.deliver', 'prints': 'acte.view',
    }

    def get_queryset(self):
        qs = super().get_queryset()
        visible = visible_declarations(self.request.user)
        return qs.filter(declaration__in=visible)

    def get_serializer_class(self):
        return {'list': ActeListSerializer, 'partial_update': ActeUpdateSerializer}.get(
            self.action, ActeSerializer)

    def partial_update(self, request, *args, **kwargs):
        acte = self.get_object()
        if not services.can_edit_acte(request.user, acte):
            raise PermissionDenied("Cet acte ne peut pas être modifié dans l'état actuel du dossier.")
        before = audit.snapshot(acte, list(ActeUpdateSerializer.Meta.fields))
        serializer = ActeUpdateSerializer(acte, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save(updated_by=request.user)
        changes = audit.diff(before, audit.snapshot(acte, list(ActeUpdateSerializer.Meta.fields)))
        if changes:
            audit.log(AuditAction.UPDATE, user=request.user, obj=acte, changes=changes)
        return Response(ActeSerializer(acte, context=self.get_serializer_context()).data)

    @action(detail=True, methods=['get'], url_path='document')
    def document(self, request, uuid=None):
        """Structured content for the printable model (flagged non-official before validation)."""
        return Response(services.build_document(self.get_object()))

    @action(detail=True, methods=['post'], url_path='print')
    def print_acte(self, request, uuid=None):
        acte = self.get_object()
        log = services.record_print(acte, request.user)
        return Response(PrintLogSerializer(log).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['get'], url_path='prints')
    def prints(self, request, uuid=None):
        acte = self.get_object()
        return Response(PrintLogSerializer(acte.print_logs.select_related('printed_by'), many=True).data)

    @action(detail=True, methods=['post'], url_path='deliver')
    def deliver(self, request, uuid=None):
        acte = self.get_object()
        serializer = DeliveryCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        delivery = services.record_delivery(acte, request.user, dict(serializer.validated_data))
        return Response(DeliverySerializer(delivery).data, status=status.HTTP_201_CREATED)


class DeliveryViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    """Delivery follow-up list (read-only)."""
    queryset = Delivery.objects.select_related(
        'acte__declaration__child', 'delivered_by').order_by('-delivered_at')
    serializer_class = DeliverySerializer
    permission_classes = [HasWakaraPermission]
    search_fields = ['recipient_name', 'acte__numero_acte', 'acte__declaration__reference']
    ordering_fields = ['delivered_at']
    permission_map = {'list': 'acte.view'}

    def get_queryset(self):
        qs = super().get_queryset()
        return qs.filter(acte__declaration__in=visible_declarations(self.request.user))
