"""Automatic facility codes: WH-0001-26 (WH = Wakara Hôpital, running number, year on two digits)."""
from django.db import transaction
from django.utils import timezone


@transaction.atomic
def generate_hospital_code() -> str:
    """Next code of the current year. The numbering restarts at 0001 each January.

    The counter row is locked (SELECT ... FOR UPDATE), so concurrent creations never get the same code.
    """
    from declarations.models import ReferenceCounter  # lazy: declarations.models points back to hospitals

    year = timezone.localdate().year
    counter, _ = ReferenceCounter.objects.select_for_update().get_or_create(key=f'hospital-{year}')
    counter.value += 1
    counter.save(update_fields=['value'])
    return f"WH-{counter.value:04d}-{year % 100:02d}"
