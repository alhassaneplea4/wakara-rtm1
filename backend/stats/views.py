"""
Dashboard statistics, computed from the database only (no fictional figures).

Definitions (to be confirmed, see docs/business-decisions.md):
  births_declared       declarations registered in the period, drafts included (1 declaration = 1 child)
  declarations_received declarations transmitted to the secretariat (any status except DRAFT)
  in_progress           transmitted / in completion / to correct
  pending_validation    waiting for the final decision
  validated             validated definitively (VALIDATED + DELIVERED)
  rejected              closed as rejected
  delivered             acts handed over
The period filters on the reception date of the declaration.
"""
import datetime

from django.conf import settings
from django.db.models import Avg, Count, DurationField, ExpressionWrapper, F, Q
from django.db.models.functions import ExtractMonth
from django.utils import timezone
from rest_framework.response import Response
from rest_framework.views import APIView

from core.permissions import HasWakaraPermission
from core.workflow import Status
from declarations.models import Declaration
from declarations.services import visible_declarations

MONTHS = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc']


def _parse_date(value):
    try:
        return datetime.date.fromisoformat(value) if value else None
    except ValueError:
        return None


class DashboardView(APIView):
    permission_classes = [HasWakaraPermission]
    required_permission = 'stats.view'

    def get(self, request):
        params = request.query_params
        today = timezone.localdate()
        try:
            year = int(params.get('year') or today.year)
        except ValueError:
            year = today.year
        date_from = _parse_date(params.get('date_from')) or datetime.date(year, 1, 1)
        date_to = _parse_date(params.get('date_to')) or datetime.date(year, 12, 31)

        qs = visible_declarations(request.user, Declaration.objects.all()).filter(
            received_at__gte=date_from, received_at__lte=date_to)
        if params.get('hospital'):
            qs = qs.filter(hospital__uuid=params['hospital'])
        if params.get('status'):
            qs = qs.filter(status__in=params['status'].split(','))
        if params.get('agent'):
            qs = qs.filter(assigned_to__uuid=params['agent'])

        received = qs.exclude(status=Status.DRAFT)
        validated_statuses = (Status.VALIDATED, Status.DELIVERED)
        kpis = {
            'births_declared': qs.count(),
            'declarations_received': received.count(),
            'in_progress': qs.filter(status__in=Status.IN_PROGRESS).count(),
            'pending_validation': qs.filter(status=Status.PENDING_VALIDATION).count(),
            'validated': qs.filter(status__in=validated_statuses).count(),
            'rejected': qs.filter(status=Status.REJECTED).count(),
            'delivered': qs.filter(status=Status.DELIVERED).count(),
        }

        # Monthly evolution of the selected year: received vs validated
        base = visible_declarations(request.user, Declaration.objects.all())
        if params.get('hospital'):
            base = base.filter(hospital__uuid=params['hospital'])
        received_by_month = dict(
            base.exclude(status=Status.DRAFT).filter(received_at__year=year)
            .annotate(m=ExtractMonth('received_at')).values_list('m').annotate(n=Count('id')))
        validated_by_month = dict(
            base.filter(validated_at__year=year, status__in=validated_statuses)
            .annotate(m=ExtractMonth('validated_at')).values_list('m').annotate(n=Count('id')))
        monthly = [
            {'month': MONTHS[i], 'received': received_by_month.get(i + 1, 0),
             'validated': validated_by_month.get(i + 1, 0)}
            for i in range(12)
        ]

        by_hospital = [
            {'name': row['hospital__name'] or 'Non renseigné', 'count': row['n']}
            for row in qs.values('hospital__name').annotate(n=Count('id')).order_by('-n')
        ]
        status_labels = dict(Status.CHOICES)
        by_status = [
            {'status': row['status'], 'label': status_labels[row['status']], 'count': row['n']}
            for row in qs.values('status').annotate(n=Count('id')).order_by('-n')
        ]
        by_gender = None
        if settings.STATS_SHOW_GENDER:
            gender = dict(qs.values_list('child__gender').annotate(n=Count('id')))
            by_gender = {'M': gender.get('M', 0), 'F': gender.get('F', 0),
                         'unknown': gender.get('', 0) + gender.get(None, 0)}

        delay = qs.filter(validated_at__isnull=False, transmitted_at__isnull=False).aggregate(
            avg=Avg(ExpressionWrapper(F('validated_at') - F('transmitted_at'), output_field=DurationField())))
        avg_days = round(delay['avg'].total_seconds() / 86400, 1) if delay['avg'] else None

        return Response({
            'period': {'year': year, 'date_from': date_from, 'date_to': date_to},
            'kpis': kpis,
            'monthly': monthly,
            'by_hospital': by_hospital,
            'by_status': by_status,
            'by_gender': by_gender,
            'delays': {'avg_days_transmission_to_validation': avg_days},
        })
