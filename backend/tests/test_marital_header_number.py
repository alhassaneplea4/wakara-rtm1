"""Marital status, commune / centre types of the acte header, free official number, aperçu content."""
import datetime

from actes.models import Acte

from .base import WakaraTestCase


class MaritalStatusTests(WakaraTestCase):
    def test_father_mother_and_declarant_have_a_marital_status(self):
        d = self.create_declaration(
            mother={'first_names': 'Fatoumata', 'last_name': 'Bah', 'marital_status': 'MARIE'},
            father={'first_names': 'Oumar', 'last_name': 'Diallo', 'marital_status': 'CELIBATAIRE'},
            declarant={'first_names': 'Aïcha', 'last_name': 'Bah', 'relationship': 'Tante', 'marital_status': 'VEUF'})
        det = self.client_for(self.agent).get(f'/api/declarations/{d["uuid"]}/').data
        self.assertEqual(det['mother']['marital_status'], 'MARIE')
        self.assertEqual(det['father']['marital_status'], 'CELIBATAIRE')
        self.assertEqual(det['declarant']['marital_status'], 'VEUF')

    def test_it_is_optional_for_the_agent_and_only_known_values_are_accepted(self):
        d = self.create_declaration(mother={'first_names': 'F', 'last_name': 'B'})
        self.assertEqual(self.client_for(self.agent).get(f'/api/declarations/{d["uuid"]}/').data['mother']['marital_status'], '')
        r = self.client_for(self.agent).patch(
            f'/api/declarations/{d["uuid"]}/', {'mother': {'marital_status': 'COMPLIQUE'}}, format='json')
        self.assertEqual(r.status_code, 400, r.content)

    def test_it_is_in_the_acte_document_for_the_parents_and_the_declarant(self):
        d = self.create_declaration(
            mother={'first_names': 'Fatoumata', 'last_name': 'Bah', 'birth_place': 'Kindia', 'address': 'Ratoma, Kipé',
                    'marital_status': 'MARIE'},
            declarant={'first_names': 'Aïcha', 'last_name': 'Bah', 'relationship': 'Tante', 'marital_status': 'VEUF'})
        acte_uuid = self.advance_to_pending(d['uuid'])
        doc = self.client_for(self.secretary).get(f'/api/actes/{acte_uuid}/document/').data
        self.assertEqual(doc['mother']['marital_status'], 'MARIE')
        self.assertEqual(doc['declarant']['marital_status'], 'VEUF')
        # every identity line of the mother reaches the preview, birth place and home included
        self.assertEqual((doc['mother']['birth_place'], doc['mother']['address']), ('Kindia', 'Ratoma, Kipé'))


class CommuneAndCentreTypeTests(WakaraTestCase):
    def test_the_header_has_urban_or_rural_commune_and_principal_or_secondary_centre(self):
        d = self.create_declaration()
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        acte = Acte.objects.get(declaration__uuid=d['uuid'])
        self.assertEqual((acte.commune_type, acte.centre_type), ('URBAINE', 'PRINCIPAL'))   # pre-filled, editable
        r = self.client_for(self.secretary).patch(f'/api/declarations/{d["uuid"]}/', {
            'acte': {'region': 'Kindia', 'prefecture': 'Kindia', 'commune_type': 'RURALE', 'commune': 'Mambia',
                     'centre_type': 'SECONDAIRE', 'centre': 'Annexe de Mambia'}}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        acte.refresh_from_db()
        self.assertEqual((acte.commune_type, acte.commune, acte.centre_type, acte.centre),
                         ('RURALE', 'Mambia', 'SECONDAIRE', 'Annexe de Mambia'))
        doc = self.client_for(self.secretary).get(f'/api/actes/{acte.uuid}/document/').data
        self.assertEqual((doc['commune_type'], doc['centre_type']), ('RURALE', 'SECONDAIRE'))

    def test_other_values_are_refused(self):
        d = self.create_declaration()
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        r = self.client_for(self.secretary).patch(
            f'/api/declarations/{d["uuid"]}/', {'acte': {'commune_type': 'MIXTE'}}, format='json')
        self.assertEqual(r.status_code, 400, r.content)


class FreeOfficialNumberTests(WakaraTestCase):
    def transmitted(self):
        d = self.create_declaration()
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        return d['uuid']

    def set_number(self, uuid, number, registre='R1'):
        return self.client_for(self.secretary).patch(
            f'/api/declarations/{uuid}/',
            {'acte': {'annee': 2026, 'registre': registre, 'numero_acte': number}}, format='json')

    def test_the_secretariat_types_it_together_with_the_header(self):
        uuid = self.transmitted()
        r = self.set_number(uuid, '  A-0042/26 ')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(Acte.objects.get(declaration__uuid=uuid).numero_acte, 'A-0042/26')   # free text, trimmed

    def test_an_empty_number_stays_empty_and_never_collides(self):
        a, b = self.transmitted(), self.transmitted()
        self.assertEqual(self.set_number(a, '').status_code, 200)
        self.assertEqual(self.set_number(b, '').status_code, 200)
        self.assertIsNone(Acte.objects.get(declaration__uuid=a).numero_acte)

    def test_a_number_already_used_in_the_same_registry_is_refused_clearly(self):
        a, b = self.transmitted(), self.transmitted()
        self.assertEqual(self.set_number(a, '15').status_code, 200)
        r = self.set_number(b, '15')
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn('numero_acte', r.data)
        self.assertEqual(self.set_number(b, '15', registre='R2').status_code, 200)   # another registry: fine

    def test_validation_keeps_the_typed_number_and_the_validator_may_correct_it(self):
        keep, fix = self.transmitted(), self.transmitted()
        for uuid, number in ((keep, '31'), (fix, '32')):
            self.set_number(uuid, number)
            self.client_for(self.secretary).patch(
                f'/api/declarations/{uuid}/', {'declarant': {'first_names': 'A', 'last_name': 'B'},
                                               'acte': {'declaration_date': datetime.date.today().isoformat()}},
                format='json')
            self.assertEqual(self.transition(self.secretary, uuid, 'PENDING_VALIDATION').status_code, 200)
        r = self.transition(self.admin, keep, 'VALIDATED', accept_incomplete=True)       # nothing typed: confirmed
        self.assertEqual(r.status_code, 200, r.content)
        acte = Acte.objects.get(declaration__uuid=keep)
        self.assertEqual(acte.numero_acte, '31')
        self.assertIsNotNone(acte.numero_assigned_at)
        self.assertEqual(acte.numero_assigned_by, self.admin)
        r = self.transition(self.admin, fix, 'VALIDATED', numero_acte='320', accept_incomplete=True)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(Acte.objects.get(declaration__uuid=fix).numero_acte, '320')      # the validator's value wins

    def test_the_agent_cannot_type_it(self):
        d = self.create_declaration()
        r = self.client_for(self.agent).patch(
            f'/api/declarations/{d["uuid"]}/', {'acte': {'numero_acte': '1'}}, format='json')
        self.assertEqual(r.status_code, 403)
