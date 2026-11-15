"""
Initial (or repeated) duplicate analysis of the declarations already in the database.

    python manage.py analyze_duplicates [--identities-only]

Run it ONCE after installing the duplicate control: declarations created before it have no normalised
identity yet and could not be found as candidates. It only reads declarations and writes analysis rows:
nothing is changed, merged or blocked on a declaration. Safe to run again (unchanged data is skipped).
"""
from django.core.management.base import BaseCommand

from declarations.models import Declaration
from duplicates.models import DuplicateCase
from duplicates.services.detection import DuplicateDetectionService
from duplicates.services.identity import BirthIdentityService


class Command(BaseCommand):
    help = "Construit les identités normalisées et lance l'analyse de doublons sur toutes les déclarations existantes."

    def add_arguments(self, parser):
        parser.add_argument('--identities-only', action='store_true',
                            help="Ne construit que les identités normalisées (aucune analyse, aucun dossier ouvert).")

    def handle(self, *args, **options):
        total = Declaration.all_objects.count()
        for d in Declaration.all_objects.select_related('child').iterator():
            BirthIdentityService.refresh(d)
        self.stdout.write(f"Identités normalisées : {total}")
        if options['identities_only']:
            return
        for d in Declaration.all_objects.order_by('id').iterator():
            DuplicateDetectionService.analyze(d, trigger='MANUAL', force=False)
        self.stdout.write(self.style.SUCCESS(
            f"Analyse terminée : {total} déclarations, {DuplicateCase.objects.count()} dossier(s) de contrôle ouvert(s)."))
