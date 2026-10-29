import csv

from django.http import HttpResponse
from django_filters import rest_framework as filters
from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action

from audit import service as audit
from core.permissions import HasWakaraPermission

from .models import AuditAction, AuditLog


class AuditLogSerializer(serializers.ModelSerializer):
    class Meta:
        model = AuditLog
        fields = ['id', 'created_at', 'username', 'action', 'object_type', 'object_id',
                  'object_repr', 'changes', 'reason', 'ip_address']


class AuditLogFilter(filters.FilterSet):
    date_from = filters.DateFilter(field_name='created_at', lookup_expr='date__gte')
    date_to = filters.DateFilter(field_name='created_at', lookup_expr='date__lte')
    username = filters.CharFilter(field_name='username', lookup_expr='icontains')

    class Meta:
        model = AuditLog
        fields = ['action', 'object_type', 'object_id', 'username']


class AuditLogViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    """Read-only. Consulting and exporting the log are themselves audited."""
    queryset = AuditLog.objects.all()
    serializer_class = AuditLogSerializer
    permission_classes = [HasWakaraPermission]
    filterset_class = AuditLogFilter
    search_fields = ['username', 'object_repr', 'reason']
    ordering_fields = ['created_at', 'action']
    permission_map = {'list': 'audit.view', 'retrieve': 'audit.view',
                      'export': 'data.export', 'actions': 'audit.view'}

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        # One entry per "first page" consultation keeps the log readable.
        if request.query_params.get('page', '1') == '1':
            audit.log(AuditAction.AUDIT_VIEWED, user=request.user, object_type='AuditLog',
                      changes={'filters': dict(request.query_params)})
        return response

    @action(detail=False, methods=['get'])
    def actions(self, request):
        from rest_framework.response import Response
        return Response([a for a, _ in AuditAction.CHOICES])

    @action(detail=False, methods=['get'])
    def export(self, request):
        qs = self.filter_queryset(self.get_queryset())[:10000]
        response = HttpResponse(content_type='text/csv; charset=utf-8')
        response['Content-Disposition'] = 'attachment; filename="journal-audit.csv"'
        response.write('﻿')
        writer = csv.writer(response, delimiter=';')
        writer.writerow(['Date', 'Utilisateur', 'Action', 'Type', 'Objet', 'Motif', 'IP'])
        for e in qs:
            writer.writerow([e.created_at.isoformat(), e.username, e.action, e.object_type,
                             e.object_repr, e.reason, e.ip_address or ''])
        audit.log(AuditAction.EXPORT, user=request.user, object_type='AuditLog',
                  changes={'filters': dict(request.query_params)})
        return response
