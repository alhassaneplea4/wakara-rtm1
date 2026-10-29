"""
DEVELOPMENT ONLY: fictional demo users and dossiers so the screens can be exercised.
Refused when DEBUG is False. Everything goes through the real services (workflow,
audit, history), so the demo data is as consistent as production data.

    python manage.py seed_demo [--count 40]
"""
import datetime
import random

from decouple import config
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from accounts.models import Role, UserRole
from actes.services import assign_official_number
from core.workflow import Status
from declarations import services
from declarations.models import Declaration
from hospitals.models import Hospital

User = get_user_model()

HOSPITALS = [
    ('CMC', 'Clinique Médicale Centrale', 'CLINIC'),
    ('HDK', 'Hôpital Donka', 'HOSPITAL'),
    ('CAM', 'Clinique Ambroise', 'CLINIC'),
    ('CPS', 'Clinique Pasteur', 'CLINIC'),
    ('MRT', 'Maternité de Ratoma', 'MATERNITY'),
]
FIRST = ['Fatoumata', 'Mohamed', 'Mariama', 'Ibrahima', 'Aissatou', 'Mamadou', 'Kadiatou', 'Oumar', 'Aminata', 'Sékou']
LAST = ['Bah', 'Diallo', 'Camara', 'Fofana', 'Sylla', 'Barry', 'Soumah', 'Keïta', 'Condé', 'Touré']


class Command(BaseCommand):
    help = "Données de démonstration FICTIVES (développement uniquement)."

    def add_arguments(self, parser):
        parser.add_argument('--count', type=int, default=40)

    def handle(self, *args, **options):
        if not settings.DEBUG:
            raise CommandError("seed_demo est interdit hors développement (DEBUG=False).")
        password = config('DEMO_USER_PASSWORD', default='')
        if not password:
            raise CommandError("Définissez DEMO_USER_PASSWORD dans backend/.env.")
        call_command('setup_initial_data', verbosity=0)
        random.seed(7)

        users = {}
        for username, role, first, last in [
            ('secretaire', 'secretary', 'Mariam', 'Sylla'),
            ('agent.collecte', 'collection_agent', 'Alpha', 'Barry'),
        ]:
            user, created = User.objects.get_or_create(
                username=username, defaults={'first_name': first, 'last_name': last,
                                             'email': f'{username}@wakara.local'})
            if created:
                user.set_password(password)
                user.save()
            UserRole.objects.get_or_create(user=user, role=Role.objects.get(codename=role))
            users[role] = user
        admin = User.objects.get(username=config('WAKARA_ADMIN_USERNAME'))

        hospitals = []
        for code, name, kind in HOSPITALS:
            h, _ = Hospital.objects.get_or_create(
                code=code, defaults={'name': name, 'facility_type': kind, 'created_by': admin})
            hospitals.append(h)

        agent, secretary = users['collection_agent'], users['secretary']
        today = timezone.localdate()
        weights = [Status.DRAFT] * 3 + [Status.TRANSMITTED] * 4 + [Status.IN_COMPLETION] * 3 \
            + [Status.PENDING_VALIDATION] * 4 + [Status.VALIDATED] * 14 + [Status.DELIVERED] * 8 \
            + [Status.REJECTED] * 2 + [Status.TO_CORRECT_COLLECTION] * 2
        number = 0
        for i in range(options['count']):
            target = random.choice(weights)
            birth = today - datetime.timedelta(days=random.randint(1, 240))
            d = services.create_declaration(agent, {
                'hospital': random.choice(hospitals), 'birth_date': birth,
                'hospital_document_ref': f'DEMO-{i + 1:04d}',
                'doctor_name': 'Dr Démo', 'midwife_name': 'Sage-femme Démo',
                'birth_place': 'Ratoma',
                'child': {'first_names': random.choice(FIRST), 'last_name': random.choice(LAST),
                          'gender': random.choice('MF')},
                'mother': {'first_names': random.choice(FIRST), 'last_name': random.choice(LAST),
                           'age': random.randint(18, 40), 'address': 'Ratoma, Conakry'},
            })
            Declaration.objects.filter(pk=d.pk).update(
                received_at=min(today, birth + datetime.timedelta(days=random.randint(0, 5))))
            if target == Status.DRAFT:
                continue
            services.transition_status(d.pk, Status.TRANSMITTED, agent)
            if target == Status.TRANSMITTED:
                continue
            if target == Status.TO_CORRECT_COLLECTION:
                services.transition_status(d.pk, Status.IN_COMPLETION, secretary)
                services.update_declaration(secretary, Declaration.objects.get(pk=d.pk), {
                    'declarant': {'first_names': 'Démo', 'last_name': 'Déclarant'}})
                acte = Declaration.objects.get(pk=d.pk).acte
                acte.declaration_date = today
                acte.save()
                services.transition_status(d.pk, Status.PENDING_VALIDATION, secretary)
                services.transition_status(d.pk, Status.TO_CORRECT_COLLECTION, admin, 'Information illisible (démo)')
                continue
            services.transition_status(d.pk, Status.IN_COMPLETION, secretary)
            if target == Status.IN_COMPLETION:
                continue
            services.update_declaration(secretary, Declaration.objects.get(pk=d.pk), {
                'declarant': {'first_names': 'Démo', 'last_name': 'Déclarant', 'relationship': 'Père'}})
            acte = Declaration.objects.get(pk=d.pk).acte
            acte.declaration_date = today
            acte.registre = 'DEMO'
            acte.save()
            services.transition_status(d.pk, Status.PENDING_VALIDATION, secretary)
            if target == Status.PENDING_VALIDATION:
                continue
            if target == Status.REJECTED:
                services.transition_status(d.pk, Status.REJECTED, admin, 'Doublon (démo)')
                continue
            number += 1
            services.transition_status(d.pk, Status.VALIDATED, admin, payload={
                'annee': today.year, 'registre': 'DEMO', 'numero_acte': str(number)})
            if target == Status.DELIVERED:
                from actes.services import record_delivery
                record_delivery(Declaration.objects.get(pk=d.pk).acte, secretary, {
                    'recipient_name': 'Démo Parent', 'recipient_relationship': 'Parent'})
        self.stdout.write(self.style.SUCCESS(
            f"{options['count']} dossiers fictifs créés. Comptes : secretaire / agent.collecte "
            "(mot de passe = DEMO_USER_PASSWORD du .env)."))
