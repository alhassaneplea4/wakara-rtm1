"""Shared helpers for the Wakara test-suite (fictional data only)."""
import datetime

from django.core.cache import cache
from django.core.management import call_command
from django.test import override_settings
from django.utils import timezone
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


# Workflow tests move many small dossiers through the circuit: they use the minimal submission rule. The real
# rule (every field but the NPI) is exercised in tests/test_secretariat_form.py.
MINIMAL_SUBMISSION = ['acte.declaration_date', 'declarant.name']


@override_settings(ACTE_REQUIRED_FOR_SUBMISSION=MINIMAL_SUBMISSION)
class WakaraTestCase(APITestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('setup_initial_data', skip_admin=True, no_hospitals=True, verbosity=0)
        cls.admin = make_user('admin', 'admin')
        cls.secretary = make_user('secretary', 'secretary')
        cls.agent = make_user('agent', 'collection_agent')
        cls.agent2 = make_user('agent2', 'collection_agent')
        cls.nobody = make_user('nobody')
        cls.hospital = Hospital.objects.create(code='CMC', name='Clinique Médicale Centrale')

    def setUp(self):
        cache.clear()

    def client_for(self, user, device=None):
        """A client authenticated as ``user``; ``device`` binds the session to a device (claim ``did`` of the token)."""
        c = APIClient()
        c.force_authenticate(user, token={'did': str(device)} if device else None)
        return c

    # Distinct, unrelated people: the fixtures must not look like the same birth entered twice, otherwise
    # the duplicate control (rightly) holds the official validation back.
    _PEOPLE = [
        ('Aminata', 'Diallo', 'Fatoumata', 'Bah'), ('Ibrahima', 'Sylla', 'Kadiatou', 'Soumah'),
        ('Moussa', 'Camara', 'Hawa', 'Touré'), ('Mariama', 'Keita', 'Nanténin', 'Condé'),
        ('Sekou', 'Bangoura', 'Djénabou', 'Barry'), ('Alpha', 'Sow', 'Aïssatou', 'Baldé'),
        ('Mohamed', 'Traoré', 'Salimatou', 'Kourouma'), ('Fanta', 'Cissé', 'Binta', 'Doumbouya'),
        ('Lansana', 'Fofana', 'Mamata', 'Sidibé'), ('Kadiatou', 'Yansané', 'Oumou', 'Magassouba'),
    ]
    def declaration_payload(self, **overrides):
        # the first payload of a test is the historical one (Aminata Diallo…); the next ones are unrelated people
        self._payload_n = getattr(self, '_payload_n', 0) + 1
        n = self._payload_n
        first, last, m_first, m_last = self._PEOPLE[(n - 1) % len(self._PEOPLE)]
        data = {
            'hospital': str(self.hospital.uuid),
            'hospital_document_ref': f'H-{n:04d}',
            'doctor_name': 'Dr Test', 'midwife_name': 'Sage Test',
            # the day as the server lives it (the system clock of the machine may be in another time zone)
            'birth_date': (timezone.localdate() - datetime.timedelta(days=3 + ((n - 1) * 37) % 300)).isoformat(),
            'birth_time': '08:30' if n == 1 else f'{(n * 7) % 24:02d}:{(n * 13) % 60:02d}', 'birth_place': 'Ratoma',
            'child': {'first_names': first, 'last_name': last, 'gender': 'F' if n % 2 else 'M'},
            'mother': {'first_names': m_first, 'last_name': m_last, 'age': 28},
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
            f'/api/actes/{det["acte_uuid"]}/', {'declaration_date': timezone.localdate().isoformat(),
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
