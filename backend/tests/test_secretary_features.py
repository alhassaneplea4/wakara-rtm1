"""Tests of the secretary-facing changes: NPI, validation warning, validated-only acts, hospital management."""
import datetime

from rest_framework.test import APIClient

from declarations.models import Declaration, StatusHistory
from tests.base import WakaraTestCase


class NpiTests(WakaraTestCase):
    def test_npi_is_free_text_for_the_child_the_parents_and_the_declarant(self):
        d = self.create_declaration(
            child={'first_names': 'Aminata', 'last_name': 'Diallo', 'gender': 'F', 'npi': 'NPI-ENFANT-1'},
            mother={'first_names': 'Fatoumata', 'last_name': 'Bah', 'npi': 'm 123/45'},
            father={'first_names': 'Mamadou', 'last_name': 'Diallo', 'npi': '99'},
            declarant={'first_names': 'Oumar', 'last_name': 'Barry', 'relationship': 'Oncle', 'npi': 'abc-7'})
        det = self.client_for(self.agent).get(f'/api/declarations/{d["uuid"]}/').data
        self.assertEqual(det['child']['npi'], 'NPI-ENFANT-1')
        self.assertEqual(det['mother']['npi'], 'm 123/45')
        self.assertEqual(det['father']['npi'], '99')
        self.assertEqual(det['declarant']['npi'], 'abc-7')

    def test_npi_is_optional_and_editable(self):
        d = self.create_declaration()
        r = self.client_for(self.agent).patch(
            f'/api/declarations/{d["uuid"]}/', {'child': {'npi': 'X1'}}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.data['child']['npi'], 'X1')

    def test_npi_is_in_the_acte_document(self):
        d = self.create_declaration(mother={'first_names': 'Fatoumata', 'last_name': 'Bah', 'npi': 'M-1'})
        acte_uuid = self.advance_to_pending(d['uuid'])
        doc = self.client_for(self.secretary).get(f'/api/actes/{acte_uuid}/document/').data
        self.assertEqual(doc['mother']['npi'], 'M-1')
        self.assertIn('npi', doc['child'])


class IncompleteValidationTests(WakaraTestCase):
    def validate(self, uuid, **extra):
        return self.transition(self.admin, uuid, 'VALIDATED', annee=2026, registre='R1', numero_acte='500', **extra)

    def test_validation_warns_about_empty_fields_and_writes_nothing_until_confirmed(self):
        d = self.create_declaration()
        self.advance_to_pending(d['uuid'])
        r = self.validate(d['uuid'])
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.data['code'], 'incomplete_confirmation_required')
        self.assertIn('nom du père', r.data['missing_labels'])
        self.assertIn('feuillet', r.data['missing_labels'])
        dec = Declaration.objects.get(uuid=d['uuid'])
        self.assertEqual(dec.status, 'PENDING_VALIDATION')          # nothing was validated...
        self.assertFalse(dec.acte.numero_acte)                     # ...and no number was consumed

    def test_confirmed_validation_goes_through_and_records_the_missing_fields(self):
        d = self.create_declaration()
        self.advance_to_pending(d['uuid'])
        r = self.validate(d['uuid'], accept_incomplete=True)
        self.assertEqual(r.status_code, 200, r.content)
        h = StatusHistory.objects.get(declaration__uuid=d['uuid'], to_status='VALIDATED')
        self.assertIn('Validé malgré des champs non renseignés', h.reason)
        self.assertIn('nom du père', h.reason)

    def test_a_complete_dossier_validates_without_any_confirmation(self):
        d = self.create_declaration(
            birth_time='08:30',
            child={'first_names': 'Aminata', 'last_name': 'Diallo', 'gender': 'F', 'nationality': 'Guinéenne'},
            mother={'first_names': 'Fatoumata', 'last_name': 'Bah', 'date_of_birth': '1995-04-02',
                    'birth_place': 'Conakry', 'nationality': 'Guinéenne', 'profession': 'Commerçante',
                    'address': 'Ratoma'},
            father={'first_names': 'Mamadou', 'last_name': 'Diallo', 'date_of_birth': '1990-01-10',
                    'birth_place': 'Kindia', 'nationality': 'Guinéenne', 'profession': 'Enseignant',
                    'address': 'Ratoma'})
        acte_uuid = self.advance_to_pending(d['uuid'])
        # the validator completes the registry reference while the dossier waits for the decision
        r = self.client_for(self.admin).patch(
            f'/api/actes/{acte_uuid}/', {'feuillet': '12', 'declaration_date': datetime.date.today().isoformat()},
            format='json')
        self.assertEqual(r.status_code, 200, r.content)
        r = self.validate(d['uuid'])
        self.assertEqual(r.status_code, 200, r.content)
        h = StatusHistory.objects.get(declaration__uuid=d['uuid'], to_status='VALIDATED')
        self.assertNotIn('malgré', h.reason)


class ActesListTests(WakaraTestCase):
    def test_the_list_only_shows_definitively_validated_and_delivered_acts(self):
        a, b = self.create_declaration()['uuid'], self.create_declaration()['uuid']
        acte_a = self.advance_to_pending(a)
        self.advance_to_pending(b)
        c = self.client_for(self.secretary)
        self.assertEqual(c.get('/api/actes/').data['count'], 0)       # pending dossiers are not listed
        self.assertEqual(self.transition(self.admin, a, 'VALIDATED', annee=2026, registre='R1', numero_acte='1',
                                         accept_incomplete=True).status_code, 200)
        listed = c.get('/api/actes/').data
        self.assertEqual([x['uuid'] for x in listed['results']], [acte_a])
        # an acte still being completed stays reachable by the secretariat that works on it
        self.assertEqual(c.get(f'/api/actes/{acte_a}/').status_code, 200)


class SecretaryHospitalTests(WakaraTestCase):
    def test_the_secretary_manages_the_health_facilities(self):
        c = self.client_for(self.secretary)
        r = c.post('/api/hospitals/', {'name': 'Clinique du Port', 'facility_type': 'CLINIC'}, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        uuid = r.data['uuid']
        self.assertEqual(c.get(f'/api/hospitals/{uuid}/').status_code, 200)
        self.assertEqual(c.patch(f'/api/hospitals/{uuid}/', {'commune': 'Matam'}, format='json').status_code, 200)
        self.assertEqual(c.post(f'/api/hospitals/{uuid}/deactivate/').status_code, 200)
        self.assertEqual(c.delete(f'/api/hospitals/{uuid}/').status_code, 204)          # logical archive
        self.assertEqual(c.post(f'/api/hospitals/{uuid}/restore/').status_code, 200)

    def test_the_agent_still_cannot_manage_them(self):
        c = self.client_for(self.agent)
        self.assertEqual(c.post('/api/hospitals/', {'name': 'X', 'facility_type': 'CLINIC'}, format='json').status_code, 403)


class DashboardParamsTests(WakaraTestCase):
    def test_out_of_range_year_does_not_crash(self):
        c = self.client_for(self.secretary)
        for year in ('0', '99999', '-5', 'abc'):
            self.assertEqual(c.get('/api/stats/dashboard/', {'year': year}).status_code, 200, year)

    def test_today_period_is_accepted(self):
        today = datetime.date.today().isoformat()
        r = self.client_for(self.secretary).get('/api/stats/dashboard/', {'date_from': today, 'date_to': today})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(str(r.data['period']['date_from']), today)
