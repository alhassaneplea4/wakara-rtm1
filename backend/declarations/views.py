"""Views for the declarations app."""
import csv

from django.http import HttpResponse
from django_filters import rest_framework as filters
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from audit import service as audit
from audit.models import AuditAction
from core.permissions import AnyOf, HasWakaraPermission
from core.workflow import Status

from . import services
from .models import Declaration
from .serializers import (
    DeclarationDetailSerializer, DeclarationListSerializer, DeclarationWriteSerializer,
    TransitionSerializer,
)


class DeclarationFilter(filters.FilterSet):
    status = filters.MultipleChoiceFilter(choices=Status.CHOICES)
    hospital = filters.UUIDFilter(field_name='hospital__uuid')
    birth_from = filters.DateFilter(field_name='birth_date', lookup_expr='gte')
    birth_to = filters.DateFilter(field_name='birth_date', lookup_expr='lte')
    received_from = filters.DateFilter(field_name='received_at', lookup_expr='gte')
    received_to = filters.DateFilter(field_name='received_at', lookup_expr='lte')
    assigned_to = filters.UUIDFilter(field_name='assigned_to__uuid')

    class Meta:
        model = Declaration
        fields = ['status', 'hospital', 'assigned_to']


class DeclarationViewSet(mixins.CreateModelMixin, mixins.RetrieveModelMixin,
                         mixins.UpdateModelMixin, mixins.DestroyModelMixin,
                         mixins.ListModelMixin, viewsets.GenericViewSet):
    """
    Declarations. Create / edit in the allowed statuses only; status changes go through
    ``POST /{uuid}/transition/``. DELETE is a logical archive.
    """
    queryset = Declaration.objects.select_related(
        'hospital', 'child', 'declarant', 'acte', 'created_by', 'assigned_to', 'validated_by',
    ).prefetch_related('parents', 'status_history__changed_by')
    permission_classes = [HasWakaraPermission]
    lookup_field = 'uuid'
    filterset_class = DeclarationFilter
    http_method_names = ['get', 'post', 'patch', 'put', 'delete', 'head', 'options']
    search_fields = ['reference', 'child__first_names', 'child__last_name',
                     'hospital_document_ref', 'acte__numero_acte']
    ordering_fields = ['created_at', 'updated_at', 'birth_date', 'received_at', 'reference', 'status']
    permission_map = {
        'list': 'declaration.view', 'retrieve': 'declaration.view',
        'create': 'declaration.create',
        # fine-grained rule (status + ownership) is enforced in services.can_edit_data
        'update': AnyOf('declaration.update', 'acte.update'),
        'partial_update': AnyOf('declaration.update', 'acte.update'),
        'destroy': 'declaration.archive',
        'transition': 'declaration.view',   # the real permission is checked per transition
        'export': 'data.export',
        'agents': 'declaration.view_all',
    }

    def get_queryset(self):
        return services.visible_declarations(self.request.user, super().get_queryset())

    def get_serializer_class(self):
        if self.action in ('create', 'update', 'partial_update'):
            return DeclarationWriteSerializer
        if self.action == 'retrieve':
            return DeclarationDetailSerializer
        return DeclarationListSerializer

    def create(self, request, *args, **kwargs):
        serializer = DeclarationWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        declaration = services.create_declaration(request.user, dict(serializer.validated_data))
        return Response(self._detail(declaration), status=status.HTTP_201_CREATED)

    def update(self, request, *args, **kwargs):
        declaration = self.get_object()
        serializer = DeclarationWriteSerializer(declaration, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        declaration = services.update_declaration(request.user, declaration, dict(serializer.validated_data))
        return Response(self._detail(declaration))

    def destroy(self, request, *args, **kwargs):
        declaration = self.get_object()
        if declaration.status not in (Status.DRAFT, Status.REJECTED):
            raise PermissionDenied("Seuls un brouillon ou un dossier rejeté peuvent être archivés.")
        declaration.archive(user=request.user)
        audit.log(AuditAction.ARCHIVE, user=request.user, obj=declaration)
        return Response(status=status.HTTP_204_NO_CONTENT)

    def _detail(self, declaration):
        declaration = self.get_queryset().get(pk=declaration.pk)
        return DeclarationDetailSerializer(declaration, context=self.get_serializer_context()).data

    @action(detail=True, methods=['post'], url_path='transition')
    def transition(self, request, uuid=None):
        """POST {status, reason?, annee?, registre?, feuillet?, numero_acte?}"""
        declaration = self.get_object()
        serializer = TransitionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        services.transition_status(
            declaration.pk, data['status'], request.user, reason=data.get('reason', ''),
            payload={k: data[k] for k in ('annee', 'registre', 'feuillet', 'numero_acte') if k in data},
        )
        return Response(self._detail(declaration))

    @action(detail=False, methods=['get'], url_path='agents', pagination_class=None)
    def agents(self, request):
        """Responsibles appearing on visible declarations (for the "responsable" filter)."""
        # order_by() clears the default ordering, which would otherwise be added to the DISTINCT
        rows = (self.get_queryset().filter(assigned_to__isnull=False).order_by()
                .values('assigned_to__uuid', 'assigned_to__first_name', 'assigned_to__last_name',
                        'assigned_to__username').distinct())
        return Response(sorted(
            ({'uuid': str(r['assigned_to__uuid']),
              'name': (f"{r['assigned_to__first_name']} {r['assigned_to__last_name']}".strip()
                       or r['assigned_to__username'])} for r in rows),
            key=lambda a: a['name'].lower()))

    @action(detail=False, methods=['get'], url_path='export')
    def export(self, request):
        """CSV export of the filtered list (sensitive: audited, restricted to data.export)."""
        qs = self.filter_queryset(self.get_queryset())
        response = HttpResponse(content_type='text/csv; charset=utf-8')
        response['Content-Disposition'] = 'attachment; filename="declarations.csv"'
        response.write('﻿')
        writer = csv.writer(response, delimiter=';')
        writer.writerow(['Référence', 'Statut', 'Établissement', 'Enfant', 'Date de naissance',
                         'Date de réception', 'N° officiel'])
        for d in qs[:5000]:
            child = getattr(d, 'child', None)
            acte = getattr(d, 'acte', None)
            writer.writerow([
                d.reference, d.get_status_display(), d.hospital.name if d.hospital else '',
                str(child) if child else '', d.birth_date, d.received_at,
                acte.numero_acte if acte and acte.numero_acte else '',
            ])
        audit.log(AuditAction.EXPORT, user=request.user, object_type='Declaration',
                  changes={'rows': min(qs.count(), 5000), 'filters': dict(request.query_params)})
        return response
