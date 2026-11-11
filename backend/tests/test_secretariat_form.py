"""One edit form for the secretariat: registry header, officer, every field but the NPI before validation."""
import datetime

from django.conf import settings
from django.test import override_settings

from actes.models import Acte
from declarations.models import Declaration

from .base import WakaraTestCase

FULL_RULE = settings.DEFAULT_ACTE_REQUIRED_FOR_SUBMISSION.split(',')


def person(first='Fatoumata', last='Bah', **extra):
    return {'first_names': first, 'last_name': last, 'date_of_birth': '1990-05-04', 'birth_place': 'Conakry',
            'age': 36, 'nationality': 'Guinéenne', 'profession': 'Commerçante', 'address': 'Ratoma',
            'phone': '+224 624 62 94 77', **extra}


def complete():
    return {
        'hospital_document_ref': 'H-1',
        'child': {'first_names': 'Aminata', 'last_name': 'Diallo', 'gender': 'F', 'nationality': 'Guinéenne',
                  'birth_rank': 1},
        'mother': person(),
        'father': person('Oumar', 'Diallo', profession='Enseignant'),
        'declarant': {'first_names': 'Oumar', 'last_name': 'Diallo', 'relationship': 'Père',
                      'nationality': 'Guinéenne', 'profession': 'Enseignant', 'address': 'Ratoma',
                      'phone': '+224 622 11 22 33'},
        'acte': {'annee': 2026, 'registre': 'R1', 'feuillet': '12',
                 'declaration_date': datetime.date.today().isoformat(), 'officer_name': 'AMADOU KONIA CAMARA'},
    }


class SecretariatEditsTheTransmittedDossier(WakaraTestCase):
    def transmitted(self):
        d = self.create_declaration()
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        return d['uuid']

    def test_the_acte_dossier_exists_from_the_transmission_with_the_officer_prefilled(self):
        uuid = self.transmitted()
        det = self.client_for(self.secretary).get(f'/api/declarations/{uuid}/').data
        self.assertTrue(det['acte_uuid'])
        acte = self.client_for(self.secretary).get(f'/api/actes/{det["acte_uuid"]}/').data
        self.assertEqual(acte['officer_name'], 'AMADOU KONIA CAMARA')
        self.assertTrue(acte['can_edit'])                      # the secretariat can fill the header right away

    def test_take_charge_is_no_longer_offered_to_the_secretariat(self):
        uuid = self.transmitted()
        det = self.client_for(self.secretary).get(f'/api/declarations/{uuid}/').data
        targets = [t['target'] for t in det['available_transitions']]
        self.assertNotIn('IN_COMPLETION', targets)
        self.assertIn('PENDING_VALIDATION', targets)           # still reachable, from the edit form

    def test_the_header_is_saved_with_the_dossier_in_one_request(self):
        uuid = self.transmitted()
        r = self.client_for(self.secretary).patch(f'/api/declarations/{uuid}/', {
            'notes': 'ok', 'acte': {'annee': 2026, 'registre': 'R7', 'feuillet': '3',
                                     'declaration_date': '2026-11-02', 'officer_name': 'Mr X', 'numero_acte': '99'}},
            format='json')
        self.assertEqual(r.status_code, 200, r.content)
        acte = Acte.objects.get(declaration__uuid=uuid)
        self.assertEqual((acte.annee, acte.registre, acte.feuillet, acte.officer_name), (2026, 'R7', '3', 'Mr X'))
        self.assertEqual(acte.declaration_date, datetime.date(2026, 11, 2))
        self.assertFalse(acte.numero_acte)                     # the official number is only attributed at validation

    def test_the_agent_cannot_write_the_header(self):
        d = self.create_declaration()                          # still a draft, owned by the agent
        r = self.client_for(self.agent).patch(
            f'/api/declarations/{d["uuid"]}/', {'acte': {'registre': 'R1'}}, format='json')
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(Acte.objects.filter(declaration__uuid=d['uuid']).exists())

    def test_the_header_cannot_be_changed_once_validated(self):
        uuid = self.transmitted()
        c = self.client_for(self.secretary)
        r = c.patch(f'/api/declarations/{uuid}/', {'declarant': {'first_names': 'A', 'last_name': 'B'},
                                                   'acte': {'declaration_date': datetime.date.today().isoformat()}},
                    format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.transition(self.secretary, uuid, 'PENDING_VALIDATION').status_code, 200)
        self.transition(self.admin, uuid, 'VALIDATED', annee=2026, registre='R1', numero_acte='5',
                        accept_incomplete=True)
        r = self.client_for(self.admin).patch(f'/api/declarations/{uuid}/', {'acte': {'registre': 'R9'}}, format='json')
        self.assertEqual(r.status_code, 403, r.content)


@override_settings(ACTE_REQUIRED_FOR_SUBMISSION=FULL_RULE)
class EveryFieldButTheNpiBeforeValidation(WakaraTestCase):
    def transmitted(self):
        d = self.create_declaration(birth_time='08:30')
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        return d['uuid']

    def submit(self, uuid):
        return self.transition(self.secretary, uuid, 'PENDING_VALIDATION')

    def test_the_rule_never_asks_for_the_npi(self):
        self.assertFalse([f for f in FULL_RULE if f.endswith('npi')])
        self.assertIn('father.first_names', FULL_RULE)          # the father is mandatory at the secretariat

    def test_an_agent_dossier_alone_cannot_be_submitted_and_the_answer_names_what_is_missing(self):
        uuid = self.transmitted()
        r = self.submit(uuid)
        self.assertEqual(r.status_code, 400, r.content)
        missing = r.data['missing_fields']
        for needed in ('father.first_names', 'father.profession', 'declarant.first_names', 'acte.registre',
                       'acte.feuillet', 'mother.nationality', 'child.nationality'):
            self.assertIn(needed, missing)
        self.assertEqual(Declaration.objects.get(uuid=uuid).status, 'TRANSMITTED')

    def test_the_father_is_mandatory(self):
        uuid = self.transmitted()
        body = complete()
        body.pop('father')
        r = self.client_for(self.secretary).patch(f'/api/declarations/{uuid}/', body, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        r = self.submit(uuid)
        self.assertEqual(r.status_code, 400)
        self.assertIn('father.first_names', r.data['missing_fields'])
        self.assertIn('père', str(r.data['detail']))

    def test_a_complete_dossier_without_any_npi_is_submitted(self):
        uuid = self.transmitted()
        r = self.client_for(self.secretary).patch(f'/api/declarations/{uuid}/', complete(), format='json')
        self.assertEqual(r.status_code, 200, r.content)
        r = self.submit(uuid)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(Declaration.objects.get(uuid=uuid).status, 'PENDING_VALIDATION')

    def test_one_missing_field_blocks_the_submission(self):
        uuid = self.transmitted()
        body = {**complete(), 'mother': person(profession='')}
        self.client_for(self.secretary).patch(f'/api/declarations/{uuid}/', body, format='json')
        r = self.submit(uuid)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.data['missing_fields'], ['mother.profession'])
