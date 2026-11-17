"""
Applies to the decisions taken BEFORE the rejection became automatic: every resolved case that designates a
redundant entry (confirmed duplicate / data-entry error) gets that dossier rejected, so that it leaves the lists.

    python manage.py reject_confirmed_duplicates            # shows what would be done
    python manage.py reject_confirmed_duplicates --apply    # does it

A validated or delivered dossier, or one that already has an official number, is never touched.
"""
from django.core.management.base import BaseCommand
from django.db import transaction

from declarations.services import reject_as_redundant
from duplicates.models import CaseStatus, Decision, DuplicateCase


class Command(BaseCommand):
    help = "Rejette les saisies redondantes déjà désignées par une décision de doublon."

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true', help="Effectuer les rejets (sinon : simple aperçu)")

    def handle(self, *args, **options):
        cases = (DuplicateCase.objects.filter(status=CaseStatus.RESOLVED,
                                              final_decision__in=Decision.DESIGNATES_DUPLICATE,
                                              duplicate_declaration__isnull=False)
                 .select_related('duplicate_declaration', 'principal_declaration', 'duplicate_declaration__acte'))
        counts = {'rejected': 0, 'already_rejected': 0, 'kept': 0}
        for case in cases:
            dup = case.duplicate_declaration
            decision = case.decisions.exclude(duplicate_declaration=None).order_by('-decided_at').first()
            actor = decision.decided_by if decision else None
            if options['apply']:
                with transaction.atomic():
                    outcome = reject_as_redundant(dup, actor, case.reference, case.principal_declaration.reference)
            else:
                acte = getattr(dup, 'acte', None)
                outcome = ('already_rejected' if dup.status == 'REJECTED' else
                           'kept' if dup.status in ('VALIDATED', 'DELIVERED') or (acte and acte.numero_acte)
                           else 'rejected')
            counts[outcome] += 1
            self.stdout.write(f"{case.reference} : {dup.reference} → {outcome}")
        verb = 'Rejetés' if options['apply'] else 'À rejeter'
        self.stdout.write(self.style.SUCCESS(
            f"{verb} : {counts['rejected']} · déjà rejetés : {counts['already_rejected']} · "
            f"laissés tels quels (validés ou numérotés) : {counts['kept']}"))
