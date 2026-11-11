"""Mandatory data when the collection agent starts a record, status label, removed ID-document fields."""
from core.workflow import Status
from declarations.models import Declarant

from .base import WakaraTestCase


class RequiredFieldsTests(WakaraTestCase):
    def post(self, payload):
        return self.client_for(self.agent).post('/api/declarations/', payload, format='json')

    def minimal(self):
        base = self.declaration_payload()
        return {'birth_date': base['birth_date'], 'birth_time': '08:30', 'birth_place': 'Ratoma',
                'child': {'gender': 'F'}}

    def test_only_date_time_place_and_sex_are_needed_to_start_a_record(self):
        r = self.post(self.minimal())
        self.assertEqual(r.status_code, 201, r.content)
        # names, parents, declarant, hospital… are all optional
        self.assertEqual(r.data['child']['first_names'], '')
        self.assertIsNone(r.data['mother'])

    def test_each_of_the_four_fields_is_required_on_creation(self):
        for field in ('birth_date', 'birth_time', 'birth_place', 'child'):
            payload = self.minimal()
            payload.pop(field)
            r = self.post(payload)
            self.assertEqual(r.status_code, 400, (field, r.content))
        # blank values do not count
        for key, blank in (('birth_place', '  '), ('birth_time', None)):
            r = self.post({**self.minimal(), key: blank})
            self.assertEqual(r.status_code, 400, (key, r.content))
        r = self.post({**self.minimal(), 'child': {'gender': ''}})
        self.assertEqual(r.status_code, 400)
        self.assertIn('gender', r.data['child'])

    def test_a_required_field_cannot_be_emptied_on_update_but_partial_edits_work(self):
        d = self.create_declaration()
        c = self.client_for(self.agent)
        url = f'/api/declarations/{d["uuid"]}/'
        self.assertEqual(c.patch(url, {'notes': 'ok'}, format='json').status_code, 200)
        self.assertEqual(c.patch(url, {'birth_place': ''}, format='json').status_code, 400)
        self.assertEqual(c.patch(url, {'child': {'gender': ''}}, format='json').status_code, 400)

    def test_a_record_with_only_the_four_fields_can_be_transmitted(self):
        d = self.post(self.minimal()).data
        r = self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        self.assertEqual(r.status_code, 200, r.content)


class StatusLabelTests(WakaraTestCase):
    def test_in_completion_is_labelled_acte_incomplet(self):
        d = self.create_declaration()
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        self.transition(self.secretary, d['uuid'], 'IN_COMPLETION')
        det = self.client_for(self.secretary).get(f'/api/declarations/{d["uuid"]}/').data
        self.assertEqual(det['status'], Status.IN_COMPLETION)
        self.assertEqual(det['status_label'], 'Acte incomplet')


class IdDocumentFieldsRemovedTests(WakaraTestCase):
    def test_declarant_and_parents_no_longer_expose_an_identity_document(self):
        d = self.create_declaration(
            mother={'first_names': 'F', 'last_name': 'B', 'id_type': 'CNI', 'id_number': 'X1'},
            declarant={'first_names': 'A', 'last_name': 'B', 'id_type': 'CNI', 'id_number': 'X2'})
        det = self.client_for(self.agent).get(f'/api/declarations/{d["uuid"]}/').data
        for section in ('mother', 'declarant'):
            self.assertNotIn('id_type', det[section])
            self.assertNotIn('id_number', det[section])
        # values sent by an old client are ignored, not stored
        self.assertEqual(Declarant.objects.get(declaration__uuid=d['uuid']).id_number, '')
