"""
Pre-fill the health facilities of the commune of Ratoma (see ``hospitals/ratoma.py`` for the sources).

    python manage.py seed_hospitals

Idempotent: a facility that already exists (same name, even archived) is left untouched.
"""
from django.core.management.base import BaseCommand
from django.db import transaction

from hospitals.ratoma import prefill_ratoma_facilities


class Command(BaseCommand):
    help = "Pré-remplit les établissements de santé de la commune de Ratoma (liste à valider par la mairie)."

    @transaction.atomic
    def handle(self, *args, **options):
        created, skipped = prefill_ratoma_facilities()
        for name in created:
            self.stdout.write(self.style.SUCCESS(f"Créé : {name}"))
        for name in skipped:
            self.stdout.write(f"Déjà présent : {name}")
        self.stdout.write(f"{len(created)} établissement(s) créé(s), {len(skipped)} déjà présent(s).")
