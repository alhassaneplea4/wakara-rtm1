"""Shared helpers for the Wakara test-suite (fictional data only)."""
import datetime

from django.core.cache import cache
from django.core.management import call_command
from rest_framework.test import APIClient, APITestCase

from accounts.models import CustomUser, Role, UserRole
from hospitals.models import Hospital

PASSWORD = 'Str0ng-Passw0rd!x'


def make_user(username, role=None, **extra):
    user = CustomUser.objects.create_user(
        username=username, password=PASSWORD, first_name=username.title(), last_name='Test',
        email=f'{username}@example.test', **extra)
    if role:
        UserRole.objects.create(user=user, role=Role.objects.get(codename=role))
    return user


class WakaraTestCase(APITestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('setup_initial_data', skip_admin=True, verbosity=0)
        cls.admin = make_user('admin', 'admin')
        cls.secretary = make_user('secretary', 'secretary')
        cls.agent = make_user('agent', 'collection_agent')
        cls.agent2 = make_user('agent2', 'collection_agent')
        cls.nobody = make_user('nobody')
        cls.hospital = Hospital.objects.create(code='CMC', name='Clinique Médicale Centrale')

    def setUp(self):
        cache.clear()

    def client_for(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def declaration_payload(self, **overrides):
        data = {
            'hospital': str(self.hospital.uuid),
            'hospital_document_ref': 'H-0001',
            'doctor_name': 'Dr Test', 'midwife_name': 'Sage Test',
            'birth_date': (datetime.date.today() - datetime.timedelta(days=3)).isoformat(),
            'birth_time': '08:30', 'birth_place': 'Ratoma',
            'child': {'first_names': 'Aminata', 'last_name': 'Diallo', 'gender': 'F'},
            'mother': {'first_names': 'Fatoumata', 'last_name': 'Bah', 'age': 28},
        }
        data.update(overrides)
        return data

    def create_declaration(self, user=None, **overrides):
        r = self.client_for(user or self.agent).post(
            '/api/declarations/', self.declaration_payload(**overrides), format='json')
        assert r.status_code == 201, r.content
        return r.data

    def transition(self, user, uuid, target, **extra):
        return self.client_for(user).post(
            f'/api/declarations/{uuid}/transition/', {'status': target, **extra}, format='json')

    def advance_to_pending(self, uuid):
        """DRAFT -> PENDING_VALIDATION with the proper actors."""
        assert self.transition(self.agent, uuid, 'TRANSMITTED').status_code == 200
        assert self.transition(self.secretary, uuid, 'IN_COMPLETION').status_code == 200
        det = self.client_for(self.secretary).get(f'/api/declarations/{uuid}/').data
        r = self.client_for(self.secretary).patch(
            f'/api/actes/{det["acte_uuid"]}/', {'declaration_date': datetime.date.today().isoformat(),
                                                'registre': 'R1'}, format='json')
        assert r.status_code == 200, r.content
        r = self.client_for(self.secretary).patch(
            f'/api/declarations/{uuid}/',
            {'declarant': {'first_names': 'Mamadou', 'last_name': 'Diallo', 'relationship': 'Père'}},
            format='json')
        assert r.status_code == 200, r.content
        r = self.transition(self.secretary, uuid, 'PENDING_VALIDATION')
        assert r.status_code == 200, r.content
        return det['acte_uuid']
