"""Public login-page settings, editable settings, and the internal "inbox" counters."""
import datetime

from django.db.models import F, Sum
from django.utils import timezone
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from audit import service as audit
from audit.models import AuditAction
from core.models import DEFAULT_SETTINGS, PageHit, SiteSetting, get_setting
from core.permissions import HasWakaraPermission, user_has_perm
from core.workflow import Status


class PublicSettingsView(APIView):
    """GET /api/public/settings/ — texts of the login page only (no authentication)."""
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request):
        keys = [k for k, _v, _d, public in DEFAULT_SETTINGS if public]
        return Response({k: get_setting(k) for k in keys})


# The only pages whose visits are counted: the public ones. The pages of the application (they carry identifiers of
# dossiers) are never counted, never sent anywhere.
PUBLIC_PAGES = ('/login', '/confidentialite', '/conditions', '/mentions-legales', '/cookies')


class PublicHitRateThrottle(AnonRateThrottle):
    scope = 'public_hit'


class PublicHitView(APIView):
    """
    POST /api/public/hit/ {path} — one more visit of a public page. First-party and cookieless: only a counter per
    day and per page is kept. A visitor who refused the audience measurement (cookie banner) sends nothing, and a
    request carrying « Do Not Track » or « Global Privacy Control » is not counted.
    """
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [PublicHitRateThrottle]

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        path = data.get('path') if isinstance(data.get('path'), str) else ''
        refused = request.META.get('HTTP_DNT') == '1' or request.META.get('HTTP_SEC_GPC') == '1'
        if path in PUBLIC_PAGES and not refused:
            today = timezone.localdate()
            row, _ = PageHit.objects.get_or_create(day=today, path=path)
            PageHit.objects.filter(pk=row.pk).update(count=F('count') + 1)
        return Response(status=status.HTTP_204_NO_CONTENT)   # same answer whatever happened: nothing to learn


class AudienceView(APIView):
    """GET /api/stats/audience/ — visits of the public pages over the last 30 days (administrators and statisticians)."""
    permission_classes = [HasWakaraPermission]
    required_permission = 'stats.view'

    def get(self, request):
        since = timezone.localdate() - datetime.timedelta(days=29)
        rows = PageHit.objects.filter(day__gte=since)
        per_page = list(rows.values('path').annotate(visits=Sum('count')).order_by('-visits'))
        per_day = list(rows.values('day').annotate(visits=Sum('count')).order_by('day'))
        return Response({'since': since, 'total': sum(r['visits'] for r in per_page), 'pages': per_page, 'days': per_day})


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
        if not isinstance(request.data, dict):
            return Response({'detail': "Un objet {clé: valeur} est attendu."}, status=status.HTTP_400_BAD_REQUEST)
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
        add('in_completion', 'Actes incomplets', Status.IN_COMPLETION, 'acte.update')
        add('to_validate', 'Dossiers en attente de validation', Status.PENDING_VALIDATION, 'dossier.validate')
        add('to_correct_secretariat', 'À corriger (secrétariat)', Status.TO_CORRECT_SECRETARIAT, 'acte.update')
        mine = qs.filter(status=Status.TO_CORRECT_COLLECTION)
        if user_has_perm(request.user, 'declaration.update') and mine.exists():
            items.append({'code': 'to_correct_collection', 'label': 'Déclarations à corriger',
                          'count': mine.count(), 'status': Status.TO_CORRECT_COLLECTION})

        # six-month rule: dossiers past the deadline, to be sent to the courts (not treatable at the mairie any more)
        from core.deadline import months, overdue_filter
        late = qs.filter(overdue_filter()).count()
        if late:
            items.append({'code': 'overdue', 'label': f"Dossiers de plus de {months()} mois : à traiter aux tribunaux",
                          'count': late, 'status': 'OVERDUE'})

        # Badges of the side menu: number of dossiers waiting for THIS user, per menu entry.
        badges = {}

        def badge(route, count, allowed):
            if allowed and count:
                badges[route] = count

        has = lambda perm: user_has_perm(request.user, perm)  # noqa: E731
        badge('/validation', qs.filter(status=Status.PENDING_VALIDATION).count(), has('dossier.validate'))
        # « Déclarations »: for the agent, corrections requested + own drafts still to finish; for the
        # secretariat, the dossiers it has to treat (the former « File du secrétariat », now the same page)
        to_fill = 0
        if has('declaration.update'):
            to_fill += qs.filter(status=Status.TO_CORRECT_COLLECTION).count() \
                + qs.filter(status=Status.DRAFT, created_by=request.user).count()
        if has('acte.complete') or has('acte.update'):
            to_fill += qs.filter(status__in=Status.SECRETARIAT_DATA_EDITABLE).count()
        badge('/declarations', to_fill, True)
        badge('/actes', qs.filter(status=Status.VALIDATED).count(), has('acte.deliver'))
        # duplicate control: unresolved cases waiting for the people allowed to look at them
        if has('duplicate.view'):
            from duplicates.models import CaseStatus, DuplicateCase
            open_cases = DuplicateCase.objects.exclude(status=CaseStatus.RESOLVED).count()
            if open_cases:
                items.append({'code': 'duplicates', 'label': 'Dossiers suspects (doublons)',
                              'count': open_cases, 'status': 'DUPLICATES'})
                badges['/duplicates'] = open_cases
        return Response({'total': sum(i['count'] for i in items), 'items': items, 'badges': badges})
