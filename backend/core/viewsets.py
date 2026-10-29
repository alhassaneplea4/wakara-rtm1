"""Base ViewSet that records who did what, server-side, and never deletes."""
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from audit import service as audit
from audit.models import AuditAction
from core.permissions import HasWakaraPermission


class AuditedModelViewSet(viewsets.ModelViewSet):
    """
    ModelViewSet where:
      - created_by / updated_by come from request.user (never from the payload)
      - create / update / archive are written to the audit log (with a field diff)
      - DELETE performs a logical archive
    Subclasses set ``audit_fields`` and ``permission_map``.
    """
    permission_classes = [HasWakaraPermission]
    audit_fields: list = []
    archive_permission: str = ''  # who may list / restore archived rows

    def _snapshot(self, instance):
        return audit.snapshot(instance, self.audit_fields)

    def perform_create(self, serializer):
        extra = {}
        model = serializer.Meta.model
        if hasattr(model, 'created_by'):
            extra['created_by'] = self.request.user
            extra['updated_by'] = self.request.user
        instance = serializer.save(**extra)
        audit.log(AuditAction.CREATE, user=self.request.user, obj=instance,
                  changes=self._snapshot(instance))
        return instance

    def perform_update(self, serializer):
        before = self._snapshot(serializer.instance)
        extra = {'updated_by': self.request.user} if hasattr(serializer.Meta.model, 'updated_by') else {}
        instance = serializer.save(**extra)
        changes = audit.diff(before, self._snapshot(instance))
        if changes:
            audit.log(AuditAction.UPDATE, user=self.request.user, obj=instance, changes=changes)
        return instance

    def perform_destroy(self, instance):
        instance.archive(user=self.request.user)
        audit.log(AuditAction.ARCHIVE, user=self.request.user, obj=instance)

    def get_queryset(self):
        qs = super().get_queryset()
        model = qs.model
        if not hasattr(model, 'is_archived'):
            return qs
        wants_archived = self.request.query_params.get('archived') == 'true'
        if wants_archived or self.action == 'restore':
            from core.permissions import user_has_perm
            if self.archive_permission and user_has_perm(self.request.user, self.archive_permission):
                return model.all_objects.filter(is_archived=True)
            return qs.none()
        return qs

    @action(detail=True, methods=['post'], url_path='restore')
    def restore(self, request, *args, **kwargs):
        instance = self.get_object()
        instance.unarchive()
        audit.log(AuditAction.RESTORE, user=request.user, obj=instance)
        return Response(self.get_serializer(instance).data)
