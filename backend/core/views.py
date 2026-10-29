"""Public login-page settings, editable settings, and the internal "inbox" counters."""
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from audit import service as audit
from audit.models import AuditAction
from core.models import DEFAULT_SETTINGS, SiteSetting, get_setting
from core.permissions import HasWakaraPermission, user_has_perm
from core.workflow import Status


class PublicSettingsView(APIView):
    """GET /api/public/settings/ — texts of the login page only (no authentication)."""
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request):
        keys = [k for k, _v, _d, public in DEFAULT_SETTINGS if public]
        return Response({k: get_setting(k) for k in keys})


class SettingSerializer(serializers.ModelSerializer):
    class Meta:
        model = SiteSetting
        fields = ['key', 'value', 'description', 'is_public']
        read_only_fields = ['key', 'description', 'is_public']


class SettingsView(APIView):
    """GET lists editable settings; PATCH {key: value, ...} updates known keys."""
    permission_classes = [HasWakaraPermission]
    required_permission = 'settings.manage'

    def get(self, request):
        known = {k: (d, p) for k, _v, d, p in DEFAULT_SETTINGS}
        return Response([
            {'key': k, 'value': get_setting(k), 'description': known[k][0], 'is_public': known[k][1]}
            for k in known
        ])

    def patch(self, request):
        known = {k: (d, p, v) for k, v, d, p in DEFAULT_SETTINGS}
        changes = {}
        for key, value in request.data.items():
            if key not in known:
                return Response({'detail': f"Paramètre inconnu : {key}"}, status=status.HTTP_400_BAD_REQUEST)
            old = get_setting(key)
            if str(value) != old:
                SiteSetting.objects.update_or_create(
                    key=key, defaults={'value': str(value)[:2000], 'description': known[key][0],
                                       'is_public': known[key][1], 'updated_by': request.user})
                changes[key] = {'from': old, 'to': str(value)[:2000]}
        if changes:
            audit.log(AuditAction.UPDATE, user=request.user, object_type='SiteSetting', changes=changes)
        return self.get(request)


class InboxView(APIView):
    """GET /api/inbox/ — internal notifications: work waiting for the current user."""
    permission_classes = [HasWakaraPermission]
    required_permission = 'declaration.view'

    def get(self, request):
        from declarations.models import Declaration
        from declarations.services import visible_declarations
        qs = visible_declarations(request.user, Declaration.objects.all())
        items = []

        def add(code, label, status_value, perm):
            if user_has_perm(request.user, perm):
                n = qs.filter(status=status_value).count()
                if n:
                    items.append({'code': code, 'label': label, 'count': n, 'status': status_value})

        add('to_complete', 'Dossiers transmis à traiter', Status.TRANSMITTED, 'acte.complete')
        add('in_completion', 'Dossiers en complément', Status.IN_COMPLETION, 'acte.update')
        add('to_validate', 'Dossiers en attente de validation', Status.PENDING_VALIDATION, 'dossier.validate')
        add('to_correct_secretariat', 'À corriger (secrétariat)', Status.TO_CORRECT_SECRETARIAT, 'acte.update')
        mine = qs.filter(status=Status.TO_CORRECT_COLLECTION)
        if user_has_perm(request.user, 'declaration.update') and mine.exists():
            items.append({'code': 'to_correct_collection', 'label': 'Déclarations à corriger',
                          'count': mine.count(), 'status': Status.TO_CORRECT_COLLECTION})
        return Response({'total': sum(i['count'] for i in items), 'items': items})
