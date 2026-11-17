"""
REST API of the Centre de contrôle des doublons (all under /api/duplicates/).

Three distinct permissions: ``duplicate.view`` (consult), ``duplicate.investigate`` (take, comment, request
verifications, attach documents), ``duplicate.decide`` (decide, reopen, assign), ``duplicate.configure`` (calibrate the engine).
Declarations are visible here whatever their owner: detection must see the whole mairie.
"""
import json

from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404
from django_filters import rest_framework as filters
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from accounts.models import CustomUser
from audit import service as audit
from audit.models import AuditAction
from core.models import SiteSetting, get_setting
from core.permissions import HasWakaraPermission, user_has_perm
from declarations.models import Declaration
from duplicates.config import CONFIG_KEY, default_config, get_config, validate_config
from duplicates.models import (
    AnomalyType, CaseStatus, Decision, DuplicateCase, DuplicateEvidence, DuplicateMatch,
    RiskLevel,
)
from duplicates.serializers import (
    AssignSerializer, AttachDocumentSerializer, CaseDetailSerializer, CaseListSerializer, DecideSerializer,
    HistorySerializer, MatchSerializer, NoteSerializer, ReasonSerializer, VerificationSerializer,
)
from duplicates.services.audit import DuplicateAuditService
from duplicates.services.cases import DuplicateCaseService
from duplicates.services.detection import DuplicateDetectionService
from duplicates.services.review import DuplicateReviewService
from duplicates.services.scoring import DuplicateScoringService
from duplicates.services.identity import BirthIdentityService
from duplicates.models import BirthIdentity


def _declaration_by_uuid(value):
    return get_object_or_404(Declaration.all_objects.select_related('hospital', 'child', 'created_by'),
                             uuid=value)


# ── cases ───────────────────────────────────────

class CaseFilter(filters.FilterSet):
    status = filters.MultipleChoiceFilter(choices=CaseStatus.CHOICES)
    risk_level = filters.MultipleChoiceFilter(choices=RiskLevel.CHOICES)
    anomaly_type = filters.MultipleChoiceFilter(choices=AnomalyType.CHOICES)
    decision = filters.ChoiceFilter(field_name='final_decision', choices=Decision.CHOICES)
    state = filters.CharFilter(method='filter_state')      # unresolved | resolved | all
    agent = filters.UUIDFilter(method='filter_agent')
    hospital = filters.UUIDFilter(method='filter_hospital')
    detected_from = filters.DateFilter(field_name='detected_at', lookup_expr='date__gte')
    detected_to = filters.DateFilter(field_name='detected_at', lookup_expr='date__lte')
    assigned_to_me = filters.BooleanFilter(method='filter_mine')

    class Meta:
        model = DuplicateCase
        fields = ['status', 'risk_level', 'anomaly_type']

    def filter_state(self, qs, name, value):
        if value == 'unresolved':
            return qs.exclude(status=CaseStatus.RESOLVED)
        if value == 'resolved':
            return qs.filter(status=CaseStatus.RESOLVED)
        return qs

    def filter_agent(self, qs, name, value):
        return qs.filter(Q(declaration__created_by__uuid=value) | Q(other_declaration__created_by__uuid=value))

    def filter_hospital(self, qs, name, value):
        return qs.filter(Q(declaration__hospital__uuid=value) | Q(other_declaration__hospital__uuid=value))

    def filter_mine(self, qs, name, value):
        return qs.filter(assigned_to=self.request.user) if value else qs


class CaseViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    queryset = DuplicateCase.objects.select_related(
        'declaration__child', 'declaration__hospital', 'declaration__created_by', 'declaration__acte',
        'other_declaration__child', 'other_declaration__hospital', 'other_declaration__created_by',
        'other_declaration__acte', 'match', 'assigned_to', 'principal_declaration', 'duplicate_declaration',
    ).prefetch_related('declaration__parents', 'other_declaration__parents')
    permission_classes = [HasWakaraPermission]
    lookup_field = 'uuid'
    filterset_class = CaseFilter
    http_method_names = ['get', 'post', 'head', 'options']
    search_fields = ['reference', 'declaration__reference', 'other_declaration__reference',
                     'declaration__child__last_name', 'declaration__child__first_names',
                     'other_declaration__child__last_name', 'other_declaration__child__first_names',
                     'declaration__parents__last_name', 'declaration__parents__first_names']
    ordering_fields = ['detected_at', 'score', 'risk_level', 'status', 'resolved_at', 'reference']
    ordering = ['-detected_at']
    permission_map = {
        'list': 'duplicate.view', 'retrieve': 'duplicate.view', 'summary': 'duplicate.view',
        'filter_options': 'duplicate.view', 'compare': 'duplicate.view', 'history': 'duplicate.view',
        'take': 'duplicate.investigate', 'note': 'duplicate.investigate',
        'request_verification': 'duplicate.investigate', 'attach_document': 'duplicate.investigate',
        'assign': 'duplicate.decide', 'decide': 'duplicate.decide', 'reopen': 'duplicate.decide',
    }

    def get_serializer_class(self):
        return CaseDetailSerializer if self.action == 'retrieve' else CaseListSerializer

    def retrieve(self, request, *args, **kwargs):
        case = self.get_object()
        audit.log(AuditAction.DUPLICATE_VIEWED, user=request.user, obj=case, changes={'action': 'case_opened'})
        return Response(CaseDetailSerializer(case, context=self.get_serializer_context()).data)

    def _detail(self, case):
        case = self.get_queryset().get(pk=case.pk)
        return CaseDetailSerializer(case, context=self.get_serializer_context()).data

    # dashboard ------------------------------------

    @action(detail=False, methods=['get'], url_path='summary')
    def summary(self, request):
        qs = self.filter_queryset(self.get_queryset()).order_by()
        by = lambda **kw: qs.filter(**kw).count()  # noqa: E731
        unresolved = qs.exclude(status=CaseStatus.RESOLVED)
        data = {
            'total': qs.count(),
            'high': by(risk_level=RiskLevel.HIGH), 'medium': by(risk_level=RiskLevel.MEDIUM),
            'low': by(risk_level=RiskLevel.LOW),
            'in_review': by(status=CaseStatus.IN_REVIEW),
            'awaiting_decision': by(status=CaseStatus.OPEN) + by(status=CaseStatus.AWAITING_INFO),
            'resolved': by(status=CaseStatus.RESOLVED),
            'confirmed_duplicates': by(final_decision=Decision.CONFIRMED_DUPLICATE),
            'distinct': by(final_decision=Decision.DISTINCT_CHILDREN),
            'multiple_birth': by(final_decision=Decision.MULTIPLE_BIRTH),
            'data_entry_error': by(final_decision=Decision.DATA_ENTRY_ERROR),
            'unresolved': unresolved.count(),
            'by_anomaly': {row['anomaly_type']: row['n'] for row in
                           qs.values('anomaly_type').annotate(n=Count('id'))},
        }
        return Response(data)

    @action(detail=False, methods=['get'], url_path='filter-options', pagination_class=None)
    def filter_options(self, request):
        agents = {}
        for prefix in ('declaration', 'other_declaration'):
            rows = (DuplicateCase.objects.order_by().values(
                f'{prefix}__created_by__uuid', f'{prefix}__created_by__first_name',
                f'{prefix}__created_by__last_name', f'{prefix}__created_by__username').distinct())
            for r in rows:
                if r[f'{prefix}__created_by__uuid']:
                    name = (f"{r[f'{prefix}__created_by__first_name']} "
                            f"{r[f'{prefix}__created_by__last_name']}".strip()
                            or r[f'{prefix}__created_by__username'])
                    agents[str(r[f'{prefix}__created_by__uuid'])] = name
        # one permission lookup per active user: kept for a minute instead of being redone at every call
        investigators = cache.get('dup-investigators')
        if investigators is None:
            investigators = [
                {'uuid': str(u.uuid), 'name': u.get_full_name() or u.username}
                for u in CustomUser.objects.filter(is_active=True) if user_has_perm(u, 'duplicate.investigate')]
            cache.set('dup-investigators', investigators, 60)
        return Response({
            'agents': sorted(({'uuid': k, 'name': v} for k, v in agents.items()), key=lambda a: a['name'].lower()),
            'investigators': investigators,
            'risk_levels': [{'value': v, 'label': l} for v, l in RiskLevel.CHOICES],
            'statuses': [{'value': v, 'label': l} for v, l in CaseStatus.CHOICES],
            'anomaly_types': [{'value': v, 'label': l} for v, l in AnomalyType.CHOICES],
            'decisions': [{'value': v, 'label': l, 'final': v in Decision.FINAL,
                           'designates_duplicate': v in Decision.DESIGNATES_DUPLICATE}
                          for v, l in Decision.CHOICES],
        })

    # comparison and history -----------------------

    @action(detail=True, methods=['get'], url_path='compare')
    def compare(self, request, uuid=None):
        case = self.get_object()
        data = DuplicateReviewService.view_comparison(case, request.user)
        data['criteria'] = case.match.criteria
        data['score'] = case.match.score
        data['risk_level'] = case.risk_level
        data['flags'] = case.match.flags
        data['data_quality'] = case.match.data_quality
        return Response(data)

    @action(detail=True, methods=['get'], url_path='history', pagination_class=None)
    def history(self, request, uuid=None):
        case = self.get_object()
        return Response(HistorySerializer(case.history.all(), many=True).data)

    # investigation --------------------------------

    @action(detail=True, methods=['post'], url_path='take')
    def take(self, request, uuid=None):
        case = DuplicateReviewService.take(self.get_object(), request.user)
        return Response(self._detail(case))

    @action(detail=True, methods=['post'], url_path='assign')
    def assign(self, request, uuid=None):
        s = AssignSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        assignee = get_object_or_404(CustomUser, uuid=s.validated_data['assignee'], is_active=True)
        case = DuplicateReviewService.assign(self.get_object(), request.user, assignee)
        return Response(self._detail(case))

    @action(detail=True, methods=['post'], url_path='note')
    def note(self, request, uuid=None):
        s = NoteSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        case = self.get_object()
        decl = _declaration_by_uuid(s.validated_data['declaration']) if s.validated_data.get('declaration') else None
        DuplicateReviewService.add_note(case, request.user, s.validated_data['content'],
                                        kind=s.validated_data['kind'], declaration=decl)
        return Response(self._detail(case), status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'], url_path='request-verification')
    def request_verification(self, request, uuid=None):
        s = VerificationSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        case = self.get_object()
        decl = _declaration_by_uuid(s.validated_data['declaration']) if s.validated_data.get('declaration') else None
        DuplicateReviewService.request_verification(case, request.user, s.validated_data['content'],
                                                    declaration=decl)
        return Response(self._detail(case), status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'], url_path='attach-document')
    def attach_document(self, request, uuid=None):
        s = AttachDocumentSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        case = self.get_object()
        DuplicateReviewService.attach_document(case, request.user, s.validated_data['document'],
                                               s.validated_data['note'])
        return Response(self._detail(case), status=status.HTTP_201_CREATED)

    # decisions ------------------------------------

    @action(detail=True, methods=['post'], url_path='decide')
    def decide(self, request, uuid=None):
        s = DecideSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        case = self.get_object()
        dup_uuid = s.validated_data.get('duplicate_declaration')
        duplicate = _declaration_by_uuid(dup_uuid) if dup_uuid else None
        case, _row, warnings = DuplicateReviewService.decide(
            case, request.user, s.validated_data['decision'], s.validated_data['reason'], duplicate)
        data = self._detail(case)
        data['warnings'] = warnings
        data['redundant_outcome'] = getattr(case, 'redundant_outcome', '')
        return Response(data)

    @action(detail=True, methods=['post'], url_path='reopen')
    def reopen(self, request, uuid=None):
        s = ReasonSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        case = DuplicateReviewService.reopen(self.get_object(), request.user, s.validated_data['reason'])
        return Response(self._detail(case))


# ── matches (alerts) ────────────────────────────

class MatchFilter(filters.FilterSet):
    risk_level = filters.MultipleChoiceFilter(choices=RiskLevel.CHOICES)
    min_score = filters.NumberFilter(field_name='score', lookup_expr='gte')
    has_case = filters.BooleanFilter(method='filter_has_case')
    detected_from = filters.DateFilter(field_name='detected_at', lookup_expr='date__gte')
    detected_to = filters.DateFilter(field_name='detected_at', lookup_expr='date__lte')

    class Meta:
        model = DuplicateMatch
        fields = ['risk_level']

    def filter_has_case(self, qs, name, value):
        return qs.filter(cases__isnull=not value).distinct() if value is not None else qs


class MatchViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    queryset = DuplicateMatch.objects.select_related(
        'declaration__child', 'declaration__hospital', 'declaration__created_by', 'declaration__acte',
        'candidate__child', 'candidate__hospital', 'candidate__created_by', 'candidate__acte',
    ).prefetch_related('declaration__parents', 'candidate__parents', 'cases')
    serializer_class = MatchSerializer
    permission_classes = [HasWakaraPermission]
    lookup_field = 'uuid'
    filterset_class = MatchFilter
    http_method_names = ['get', 'post', 'head', 'options']
    search_fields = ['declaration__reference', 'candidate__reference', 'declaration__child__last_name',
                     'candidate__child__last_name', 'declaration__child__first_names',
                     'candidate__child__first_names']
    ordering_fields = ['score', 'detected_at', 'risk_level']
    ordering = ['-score', '-detected_at']
    permission_map = {'list': 'duplicate.view', 'retrieve': 'duplicate.view',
                      'open_case': 'duplicate.investigate'}

    @action(detail=True, methods=['post'], url_path='open-case')
    def open_case(self, request, uuid=None):
        """Open an investigation case by hand for a correspondence (e.g. a low-risk one worth checking)."""
        match = self.get_object()
        case = DuplicateCaseService.open_case(match, user=request.user, system=False)
        audit.log(AuditAction.DUPLICATE_CHECK, user=request.user, obj=case, changes={'manual_case': True})
        return Response(CaseListSerializer(case, context=self.get_serializer_context()).data,
                        status=status.HTTP_201_CREATED)


# ── analysis, comparison, configuration, synchronisation ──

class HeavyRateThrottle(UserRateThrottle):
    """An analysis takes the global detection lock and a comparison scans identities: both are rate limited."""
    scope = 'duplicates_heavy'


class AnalyzeView(APIView):
    """POST {declaration: uuid} — run (or re-run) the analysis of one declaration."""
    permission_classes = [HasWakaraPermission]
    required_permission = 'duplicate.investigate'
    throttle_classes = [HeavyRateThrottle]

    def post(self, request):
        value = request.data.get('declaration')
        if not value:
            return Response({'declaration': "UUID de la déclaration requis."}, status=400)
        try:
            declaration = _declaration_by_uuid(value)
        except ValidationError:
            return Response({'declaration': "UUID invalide."}, status=400)
        check = DuplicateDetectionService.analyze(declaration, trigger='MANUAL', user=request.user, force=True,
                                                  exhaustive=True)
        matches = (DuplicateMatch.objects.filter(Q(declaration=declaration) | Q(candidate=declaration))
                   .select_related('declaration__child', 'declaration__hospital', 'declaration__created_by',
                                   'declaration__acte', 'candidate__child', 'candidate__hospital',
                                   'candidate__created_by', 'candidate__acte')
                   .prefetch_related('declaration__parents', 'candidate__parents', 'cases')
                   .order_by('-score'))
        return Response({
            'check': {'uuid': str(check.uuid), 'performed_at': check.performed_at,
                      'candidates_examined': check.candidates_examined, 'matches_found': check.matches_found,
                      'highest_score': check.highest_score, 'data_quality': check.data_quality,
                      'truncated': check.candidates_truncated},
            'matches': MatchSerializer(matches, many=True, context={'request': request}).data,
            'cases': [str(c.uuid) for c in getattr(check, 'cases', [])],
        })


class CompareView(APIView):
    """GET ?a=<uuid>&b=<uuid> — compare two declarations on the fly (score computed, nothing stored)."""
    permission_classes = [HasWakaraPermission]
    required_permission = 'duplicate.view'
    throttle_classes = [HeavyRateThrottle]

    def get(self, request):
        try:
            a = _declaration_by_uuid(request.query_params.get('a'))
            b = _declaration_by_uuid(request.query_params.get('b'))
        except ValidationError:
            return Response({'detail': "UUID invalide."}, status=400)
        if a.pk == b.pk:
            return Response({'detail': "Choisissez deux déclarations différentes."}, status=400)
        data = DuplicateReviewService.compare_declarations(a, b, request.user)
        ia, _ = BirthIdentityService.refresh(a)
        ib, _ = BirthIdentityService.refresh(b)
        scored = DuplicateScoringService.score(ia, ib, get_config())
        data.update({'score': scored['score'], 'risk_level': scored['risk_level'],
                     'criteria': scored['criteria'], 'flags': scored['flags'],
                     'data_quality': scored['data_quality']})
        audit.log(AuditAction.DUPLICATE_VIEWED, user=request.user, obj=a,
                  changes={'action': 'compare', 'with': b.reference})
        return Response(data)


class ConfigView(APIView):
    """
    GET weights and thresholds · PATCH to calibrate them. Changing the rules of the control is a sensitive act:
    it needs its own permission (``duplicate.configure``, not the general ``settings.manage``), a written reason,
    stays inside the limits fixed in the code (duplicates.config.GUARDS) and is audited with the previous values.
    """
    permission_classes = [HasWakaraPermission]

    def get_permissions(self):
        self.required_permission = 'duplicate.view' if self.request.method == 'GET' else 'duplicate.configure'
        return super().get_permissions()

    def get(self, request):
        from duplicates.config import GUARDS, MANDATORY_BLOCKING_LEVELS, MIN_REASON_LENGTH, config_meta
        return Response({'config': get_config(), 'defaults': default_config(), 'meta': config_meta(),
                         'limits': {'high_threshold': GUARDS['high_threshold'], 'medium_threshold': GUARDS['medium_threshold'],
                                    'min_weight': GUARDS['min_weight'], 'mandatory_blocking_levels': MANDATORY_BLOCKING_LEVELS,
                                    'min_reason_length': MIN_REASON_LENGTH}})

    def patch(self, request):
        from duplicates.config import MIN_REASON_LENGTH
        if not isinstance(request.data, dict):
            return Response({'detail': "Corps de requête invalide."}, status=status.HTTP_400_BAD_REQUEST)
        body = dict(request.data)
        reason = str(body.pop('reason', '') or '').strip()
        if len(reason) < MIN_REASON_LENGTH:
            return Response({'reason': f"Indiquez le motif de la modification ({MIN_REASON_LENGTH} caractères au moins)."},
                            status=status.HTTP_400_BAD_REQUEST)
        current = get_config()
        clean = validate_config({**current, **body})
        SiteSetting.objects.update_or_create(
            key=CONFIG_KEY, defaults={'value': json.dumps(clean), 'description': f"Modifié : {reason}"[:255],
                                      'is_public': False, 'updated_by': request.user})
        audit.log(AuditAction.UPDATE, user=request.user, object_type='SiteSetting', object_id=CONFIG_KEY,
                  changes={'from': current, 'to': clean}, reason=reason)
        return self.get(request)
