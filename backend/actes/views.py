from django.db.models import Count
from django.utils import timezone
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
    DeliveryDetailSerializer, DeliverySerializer, PrintLogSerializer,
)


class ActeFilter(filters.FilterSet):
    status = filters.MultipleChoiceFilter(field_name='declaration__status', choices=Status.CHOICES)
    hospital = filters.UUIDFilter(field_name='declaration__hospital__uuid')
    # same period / responsible filters as the declarations list, so a dashboard figure and its list agree
    received_from = filters.DateFilter(field_name='declaration__received_at', lookup_expr='gte')
    received_to = filters.DateFilter(field_name='declaration__received_at', lookup_expr='lte')
    assigned_to = filters.UUIDFilter(field_name='declaration__assigned_to__uuid')

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
        qs = qs.filter(declaration__in=visible)
        if self.action == 'list':
            # The "Actes de naissance" list holds the dossiers the secretariat has finished: waiting for the
            # validation decision, or validated. Dossiers still being worked on stay in « Déclarations »; once an
            # act is handed over it moves to « Délivrances ».
            qs = qs.filter(declaration__status__in=(Status.PENDING_VALIDATION, Status.VALIDATED))
        return qs

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
        data = serializer.validated_data
        if 'numero_acte' in data:
            data['numero_acte'] = (data['numero_acte'] or '').strip() or None
            services.check_number_is_free(
                acte, data.get('annee', acte.annee), data.get('registre', acte.registre), data['numero_acte'])
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


class DeliveryFilter(filters.FilterSet):
    delivered_from = filters.DateFilter(field_name='delivered_at', lookup_expr='date__gte')
    delivered_to = filters.DateFilter(field_name='delivered_at', lookup_expr='date__lte')
    hospital = filters.UUIDFilter(field_name='acte__declaration__hospital__uuid')
    delivered_by = filters.UUIDFilter(field_name='delivered_by__uuid')

    class Meta:
        model = Delivery
        fields = ['is_duplicate']


class DeliveryViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    """Delivery follow-up (read-only): the list, a detailed view of one delivery and a few counters."""
    queryset = Delivery.objects.select_related(
        'acte__declaration__child', 'acte__declaration__hospital', 'acte__declaration__validated_by',
        'acte__numero_assigned_by', 'delivered_by',
    ).annotate(print_count=Count('acte__print_logs', distinct=True)).order_by('-delivered_at')
    serializer_class = DeliverySerializer
    permission_classes = [HasWakaraPermission]
    lookup_field = 'uuid'
    filterset_class = DeliveryFilter
    search_fields = ['recipient_name', 'recipient_id_number', 'acte__numero_acte', 'acte__declaration__reference',
                     'acte__declaration__child__last_name', 'acte__declaration__child__first_names']
    ordering_fields = ['delivered_at', 'recipient_name']
    permission_map = {'list': 'acte.view', 'retrieve': 'acte.view', 'summary': 'acte.view'}

    def get_queryset(self):
        qs = super().get_queryset()
        return qs.filter(acte__declaration__in=visible_declarations(self.request.user))

    def get_serializer_class(self):
        return DeliveryDetailSerializer if self.action == 'retrieve' else DeliverySerializer

    @action(detail=False, methods=['get'], url_path='summary')
    def summary(self, request):
        """Counters for the filters currently applied (first deliveries, duplicates, today, this month)."""
        qs = self.filter_queryset(self.get_queryset()).order_by()
        today = timezone.localdate()
        return Response({
            'total': qs.count(),
            'first': qs.filter(is_duplicate=False).count(),
            'duplicates': qs.filter(is_duplicate=True).count(),
            'today': qs.filter(delivered_at__date=today).count(),
            'this_month': qs.filter(delivered_at__date__gte=today.replace(day=1)).count(),
        })
