"""Phone / e-mail validation and nationality of the parents and the declarant (fictional data only)."""
import datetime

from rest_framework import serializers

from core.validators import normalize_phone, validate_email_address
from hospitals.models import Hospital

from .base import WakaraTestCase


class PhoneNormalizationTests(WakaraTestCase):
    def test_guinean_numbers_get_the_canonical_format(self):
        for raw in ('+224 624 62 94 77', '+224624629477', '00224 624-62-94-77', '624 62 94 77', '(+224) 624.62.94.77'):
            self.assertEqual(normalize_phone(raw), '+224 624 62 94 77', raw)

    def test_foreign_numbers_are_kept_in_international_form(self):
        self.assertEqual(normalize_phone('+33 6 12 34 56 78'), '+33612345678')

    def test_empty_stays_empty(self):
        self.assertEqual(normalize_phone(''), '')
        self.assertEqual(normalize_phone('   '), '')

    def test_malformed_numbers_are_refused(self):
        for raw in ('abc', '+224 624 62 94', '+224 624 62 94 77 1', '62462', '+224 024 62 94 77', '624-62-94-7x',
                    '+33 12', '+1234567890123456', '٦٢٤٦٢٩٤٧٧'):
            with self.assertRaises(serializers.ValidationError, msg=raw):
                normalize_phone(raw)


class EmailValidationTests(WakaraTestCase):
    def test_valid_and_empty_addresses_pass(self):
        self.assertEqual(validate_email_address(' agent@example.test '), 'agent@example.test')
        self.assertEqual(validate_email_address(''), '')

    def test_malformed_addresses_are_refused(self):
        for raw in ('agent', 'agent@', '@example.test', 'agent@example', 'a b@example.test', 'agent@@example.test'):
            with self.assertRaises(serializers.ValidationError, msg=raw):
                validate_email_address(raw)

    def test_api_refuses_a_malformed_email_on_a_hospital(self):
        c = self.client_for(self.admin)
        base = {'name': 'Clinique Fictive', 'facility_type': 'CLINIC', 'region': 'Conakry', 'commune': 'Ratoma'}
        bad = c.post('/api/hospitals/', {**base, 'email': 'pas-un-email'}, format='json')
        self.assertEqual(bad.status_code, 400, bad.content)
        self.assertIn('email', bad.data)
        ok = c.post('/api/hospitals/', {**base, 'email': 'contact@example.test'}, format='json')
        self.assertEqual(ok.status_code, 201, ok.content)

    def test_api_refuses_a_malformed_email_on_the_profile(self):
        r = self.client_for(self.agent).patch('/api/auth/me/', {'email': 'pas-un-email'}, format='json')
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn('email', r.data)


class PhoneOnDeclarationsTests(WakaraTestCase):
    def post(self, **sections):
        return self.client_for(self.agent).post(
            '/api/declarations/', self.declaration_payload(**sections), format='json')

    def test_a_malformed_parent_phone_is_refused(self):
        r = self.post(mother={'first_names': 'Fatoumata', 'last_name': 'Bah', 'phone': '12ab'})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn('phone', str(r.data))

    def test_a_malformed_declarant_phone_is_refused(self):
        r = self.post(declarant={'first_names': 'Oumar', 'last_name': 'Bah', 'phone': '+224 624'})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn('phone', str(r.data))

    def test_valid_phones_are_stored_in_the_canonical_format(self):
        r = self.post(mother={'first_names': 'Fatoumata', 'last_name': 'Bah', 'phone': '624629477'},
                      father={'first_names': 'Oumar', 'last_name': 'Bah', 'phone': '+224 622 11 22 33'},
                      declarant={'first_names': 'Oumar', 'last_name': 'Bah', 'phone': '622-11-22-33'})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.data['mother']['phone'], '+224 624 62 94 77')
        self.assertEqual(r.data['father']['phone'], '+224 622 11 22 33')
        self.assertEqual(r.data['declarant']['phone'], '+224 622 11 22 33')

    def test_an_empty_phone_is_accepted_and_the_update_path_validates_too(self):
        d = self.create_declaration(mother={'first_names': 'Fatoumata', 'last_name': 'Bah', 'phone': ''})
        c = self.client_for(self.agent)
        bad = c.patch(f'/api/declarations/{d["uuid"]}/', {'mother': {'phone': 'xx'}}, format='json')
        self.assertEqual(bad.status_code, 400, bad.content)

    def test_age_rank_and_parent_birth_date_are_bounded(self):
        future = (datetime.date.today() + datetime.timedelta(days=2)).isoformat()
        for section, payload in (
                ('mother', {'first_names': 'F', 'age': 200}),
                ('mother', {'first_names': 'F', 'age': -1}),
                ('mother', {'first_names': 'F', 'date_of_birth': future}),
                ('child', {'first_names': 'A', 'birth_rank': 0}),
                ('child', {'first_names': 'A', 'birth_rank': 31})):
            r = self.post(**{section: payload})
            self.assertEqual(r.status_code, 400, (section, payload, r.content))


class NationalityTests(WakaraTestCase):
    def test_the_declarant_has_an_optional_nationality_field(self):
        from declarations.models import Declarant
        field = Declarant._meta.get_field('nationality')
        self.assertTrue(field.blank)
        self.assertEqual(field.get_default(), '')  # no default value: empty unless filled in

    def test_parents_and_declarant_nationality_roundtrip_through_the_api(self):
        r = self.client_for(self.agent).post('/api/declarations/', self.declaration_payload(
            mother={'first_names': 'Fatoumata', 'last_name': 'Bah', 'nationality': 'Guinéenne'},
            father={'first_names': 'Oumar', 'last_name': 'Bah', 'nationality': 'Sénégalaise'},
            declarant={'first_names': 'Aïcha', 'last_name': 'Bah', 'relationship': 'Tante',
                       'nationality': 'Malienne'}), format='json')
        self.assertEqual(r.status_code, 201, r.content)
        det = self.client_for(self.agent).get(f'/api/declarations/{r.data["uuid"]}/').data
        self.assertEqual(det['mother']['nationality'], 'Guinéenne')
        self.assertEqual(det['father']['nationality'], 'Sénégalaise')
        self.assertEqual(det['declarant']['nationality'], 'Malienne')

    def test_nationality_is_blank_when_not_given(self):
        d = self.create_declaration(declarant={'first_names': 'A', 'last_name': 'B'})
        det = self.client_for(self.agent).get(f'/api/declarations/{d["uuid"]}/').data
        self.assertEqual(det['declarant']['nationality'], '')
        self.assertEqual(det['mother']['nationality'], '')

    def test_nationality_changes_are_audited(self):
        d = self.create_declaration(declarant={'first_names': 'A', 'last_name': 'B'})
        r = self.client_for(self.agent).patch(
            f'/api/declarations/{d["uuid"]}/', {'declarant': {'nationality': 'Ivoirienne'}}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        from audit.models import AuditLog
        self.assertTrue(any('declarant.nationality' in (log.changes or {}) for log in AuditLog.objects.all()))

    def test_the_acte_document_carries_the_nationality_of_parents_and_declarant(self):
        d = self.create_declaration(
            mother={'first_names': 'Fatoumata', 'last_name': 'Bah', 'nationality': 'Guinéenne'},
            father={'first_names': 'Oumar', 'last_name': 'Bah', 'nationality': 'Sénégalaise'},
            declarant={'first_names': 'Oumar', 'last_name': 'Bah', 'relationship': 'Père',
                       'nationality': 'Sénégalaise'})
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        self.transition(self.secretary, d['uuid'], 'IN_COMPLETION')
        det = self.client_for(self.secretary).get(f'/api/declarations/{d["uuid"]}/').data
        doc = self.client_for(self.secretary).get(f'/api/actes/{det["acte_uuid"]}/document/').data
        self.assertEqual(doc['mother']['nationality'], 'Guinéenne')
        self.assertEqual(doc['father']['nationality'], 'Sénégalaise')
        self.assertEqual(doc['declarant']['nationality'], 'Sénégalaise')
        self.assertEqual(doc['declarant']['relationship'], 'Père')
