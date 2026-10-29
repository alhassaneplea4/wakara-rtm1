from django.db.models import Count, Q
from rest_framework.decorators import action
from rest_framework.response import Response

from audit import service as audit
from audit.models import AuditAction
from core.viewsets import AuditedModelViewSet

from .models import Hospital
from .serializers import HospitalSerializer


class HospitalViewSet(AuditedModelViewSet):
    """Create / read / update / (de)activate / archive. No physical deletion."""
    queryset = Hospital.objects.all()
    serializer_class = HospitalSerializer
    lookup_field = 'uuid'
    filterset_fields = ['commune', 'is_active', 'facility_type']
    search_fields = ['name', 'code']
    ordering_fields = ['name', 'code', 'created_at']
    audit_fields = ['code', 'name', 'facility_type', 'region', 'commune', 'address',
                    'contact_name', 'phone', 'email', 'is_active']
    archive_permission = 'hospital.archive'
    permission_map = {
        'list': 'hospital.view', 'retrieve': 'hospital.view',
        'create': 'hospital.create',
        'update': 'hospital.update', 'partial_update': 'hospital.update',
        'activate': 'hospital.update', 'deactivate': 'hospital.update',
        'destroy': 'hospital.archive', 'restore': 'hospital.archive',
    }

    def get_queryset(self):
        qs = super().get_queryset()
        return qs.annotate(declaration_count=Count(
            'declarations', filter=Q(declarations__is_archived=False), distinct=True)).order_by('name')

    @action(detail=True, methods=['post'])
    def activate(self, request, uuid=None):
        hospital = self.get_object()
        hospital.is_active = True
        hospital.updated_by = request.user
        hospital.save(update_fields=['is_active', 'updated_by', 'updated_at'])
        audit.log(AuditAction.UPDATE, user=request.user, obj=hospital,
                  changes={'is_active': {'from': False, 'to': True}})
        return Response(self.get_serializer(hospital).data)

    @action(detail=True, methods=['post'])
    def deactivate(self, request, uuid=None):
        hospital = self.get_object()
        hospital.is_active = False
        hospital.updated_by = request.user
        hospital.save(update_fields=['is_active', 'updated_by', 'updated_at'])
        audit.log(AuditAction.UPDATE, user=request.user, obj=hospital,
                  changes={'is_active': {'from': True, 'to': False}},
                  reason=str(request.data.get('reason', '')))
        return Response(self.get_serializer(hospital).data)
