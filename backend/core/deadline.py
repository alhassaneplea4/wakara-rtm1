"""
Six-month rule of the civil registry.

A birth declaration made at the mairie can be treated by the mairie for ``DOSSIER_DEADLINE_MONTHS`` months (6) from
the date of the declaration. A dossier still not treated after that is blocked for any modification — data, acte
references, documents, status changes — except for whoever holds ``dossier.override_deadline`` (the administrator
by default): it must be treated by the courts (tribunaux).

Date of the declaration at the mairie: the earliest of the date the dossier was received and the « date de
déclaration » written on the acte (a later date typed afterwards never gives a dossier a second life). Dossiers
already treated (validated, delivered, rejected) are not concerned: they are frozen anyway.
"""
import calendar
import datetime

from django.conf import settings
from django.core.exceptions import PermissionDenied
from django.utils import timezone

from core.permissions import user_has_perm
from core.workflow import Status

OVERRIDE_PERMISSION = 'dossier.override_deadline'
DEADLINE_CODE = 'deadline_exceeded'


def months() -> int:
    return int(getattr(settings, 'DOSSIER_DEADLINE_MONTHS', 6))


def add_months(day: datetime.date, n: int) -> datetime.date:
    """``day`` shifted by ``n`` calendar months (end of month kept inside the target month)."""
    index = day.year * 12 + (day.month - 1) + n
    year, month = divmod(index, 12)
    month += 1
    return datetime.date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def cutoff(today: datetime.date | None = None) -> datetime.date:
    """Declarations dated strictly before this day are past the deadline."""
    return add_months(today or timezone.localdate(), -months())


def reference_date(declaration) -> datetime.date | None:
    acte = getattr(declaration, 'acte', None)
    dates = [d for d in (declaration.received_at, getattr(acte, 'declaration_date', None)) if d]
    return min(dates) if dates else None


def deadline_info(declaration, today: datetime.date | None = None) -> dict:
    """What the screens need: the date counted from, the deadline, whether it is exceeded and by how many days."""
    today = today or timezone.localdate()
    ref = reference_date(declaration)
    limit = add_months(ref, months()) if ref else None
    applies = declaration.status not in Status.FROZEN
    overdue = bool(applies and limit and today > limit)
    return {
        'months': months(), 'reference_date': ref, 'deadline_date': limit, 'applies': applies, 'overdue': overdue,
        'days_over': (today - limit).days if overdue else 0,
        'message': (f"Ce dossier date de plus de {months()} mois (déclaré le {ref:%d/%m/%Y}) : il doit être traité "
                    "aux tribunaux. Il est bloqué à toute modification au niveau de la mairie."
                    if overdue else ''),
    }


def is_overdue(declaration, today=None) -> bool:
    return deadline_info(declaration, today)['overdue']


def is_locked_for(user, declaration) -> bool:
    """Overdue and the user may not override the deadline."""
    return is_overdue(declaration) and not user_has_perm(user, OVERRIDE_PERMISSION)


def assert_not_locked(user, declaration):
    if is_locked_for(user, declaration):
        error = PermissionDenied(deadline_info(declaration)['message'])
        error.code = DEADLINE_CODE
        raise error


def overdue_filter(today=None):
    """Q object selecting the dossiers past the deadline (still to be treated)."""
    from django.db.models import Q
    day = cutoff(today)
    return ~Q(status__in=Status.FROZEN) & (Q(received_at__lt=day) | Q(acte__declaration_date__lt=day))
