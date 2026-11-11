"""Deliveries page (detail, filters, counters), dashboard links (acte filters) and the Ratoma facilities pre-fill."""
import datetime
from io import StringIO

from django.core.management import call_command

from core.models import SiteSetting
from declarations.models import Declaration
from hospitals.models import Hospital
from hospitals.ratoma import RATOMA_FACILITIES, prefill_ratoma_facilities
from tests.base import WakaraTestCase


class DeliveryPageTests(WakaraTestCase):
    def delivered(self, recipient='Mariam Camara', **extra):
        """A dossier taken to the end: validated, printed once and delivered by the secretary."""
        d = self.create_declaration(**extra)
        acte = self.advance_to_pending(d['uuid'])
        self.assertEqual(self.transition(self.admin, d['uuid'], 'VALIDATED', annee=2026, registre='R1',
                                         numero_acte=str(1000 + Declaration.objects.count()), accept_incomplete=True).status_code, 200)
        c = self.client_for(self.secretary)
        self.assertEqual(c.post(f'/api/actes/{acte}/print/').status_code, 201)
        r = c.post(f'/api/actes/{acte}/deliver/', {'recipient_name': recipient, 'recipient_relationship': 'Mère',
                                                    'recipient_id_type': 'CNI', 'recipient_id_number': 'AB123'}, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        return d, acte, r.data['uuid']

    def test_list_carries_the_extra_columns(self):
        d, acte, delivery = self.delivered()
        row = self.client_for(self.secretary).get('/api/actes/deliveries/').data['results'][0]
        self.assertEqual(row['uuid'], delivery)
        self.assertEqual(row['hospital_name'], 'Clinique Médicale Centrale')
        self.assertEqual(row['validated_by_name'], 'Admin Test')
        self.assertEqual(row['print_count'], 1)
        self.assertEqual(row['declaration_uuid'], d['uuid'])
        self.assertEqual(row['recipient_id_number'], 'AB123')

    def test_detail_explains_what_was_done(self):
        d, acte, delivery = self.delivered()
        det = self.client_for(self.secretary).get(f'/api/actes/deliveries/{delivery}/').data
        self.assertEqual(det['acte']['status'], 'DELIVERED')
        self.assertEqual(det['acte']['numero_assigned_by_name'], 'Admin Test')
        self.assertEqual(det['acte']['registre'], 'R1')
        self.assertEqual([h['to_status'] for h in det['history']][0], 'DELIVERED')   # newest first
        self.assertIn('VALIDATED', [h['to_status'] for h in det['history']])
        self.assertEqual(len(det['prints']), 1)
        self.assertEqual(det['prints'][0]['printed_by_name'], 'Secretary Test')
        self.assertEqual(det['other_deliveries'], [])

    def test_a_second_delivery_is_a_duplicate_and_appears_in_the_other_deliveries(self):
        d, acte, first = self.delivered()
        r = self.client_for(self.secretary).post(f'/api/actes/{acte}/deliver/', {'recipient_name': 'Autre personne'}, format='json')
        self.assertEqual(r.status_code, 201)
        det = self.client_for(self.admin).get(f'/api/actes/deliveries/{r.data["uuid"]}/').data
        self.assertTrue(det['is_duplicate'])
        self.assertEqual([o['uuid'] for o in det['other_deliveries']], [first])

    def test_filters_and_counters(self):
        self.delivered('Premier')
        d, acte, _ = self.delivered('Second')
        self.client_for(self.secretary).post(f'/api/actes/{acte}/deliver/', {'recipient_name': 'Duplicata'}, format='json')
        c = self.client_for(self.secretary)
        self.assertEqual(c.get('/api/actes/deliveries/', {'is_duplicate': 'true'}).data['count'], 1)
        today = datetime.date.today().isoformat()
        self.assertEqual(c.get('/api/actes/deliveries/', {'delivered_from': today, 'delivered_to': today}).data['count'], 3)
        self.assertEqual(c.get('/api/actes/deliveries/', {'delivered_from': '2000-01-01', 'delivered_to': '2000-01-02'}).data['count'], 0)
        self.assertEqual(c.get('/api/actes/deliveries/', {'search': 'Duplicata'}).data['count'], 1)
        s = c.get('/api/actes/deliveries/summary/').data
        self.assertEqual((s['total'], s['first'], s['duplicates'], s['today']), (3, 2, 1, 3))
        only_dups = c.get('/api/actes/deliveries/summary/', {'is_duplicate': 'true'}).data
        self.assertEqual((only_dups['total'], only_dups['duplicates']), (1, 1))

    def test_the_agent_cannot_reach_the_deliveries(self):
        _, _, delivery = self.delivered()
        c = self.client_for(self.agent)
        self.assertEqual(c.get('/api/actes/deliveries/').status_code, 403)
        self.assertEqual(c.get(f'/api/actes/deliveries/{delivery}/').status_code, 403)
        self.assertEqual(c.get('/api/actes/deliveries/summary/').status_code, 403)


class ActeListFilterTests(WakaraTestCase):
    def test_dashboard_filters_apply_to_the_acte_list(self):
        d = self.create_declaration()
        acte = self.advance_to_pending(d['uuid'])
        self.assertEqual(self.transition(self.admin, d['uuid'], 'VALIDATED', annee=2026, registre='R1', numero_acte='1',
                                         accept_incomplete=True).status_code, 200)
        c = self.client_for(self.secretary)
        today = datetime.date.today().isoformat()
        self.assertEqual(c.get('/api/actes/', {'received_from': today, 'received_to': today}).data['count'], 1)
        self.assertEqual(c.get('/api/actes/', {'received_from': '2000-01-01', 'received_to': '2000-12-31'}).data['count'], 0)
        self.assertEqual(c.get('/api/actes/', {'hospital': str(self.hospital.uuid)}).data['count'], 1)
        self.assertEqual(c.get('/api/actes/', {'status': 'DELIVERED'}).data['count'], 0)
        self.assertEqual(c.get('/api/actes/', {'assigned_to': str(self.secretary.uuid)}).data['count'], 1)
        self.assertEqual(acte, c.get('/api/actes/').data['results'][0]['uuid'])


class RatomaHospitalsTests(WakaraTestCase):
    def test_prefill_creates_the_documented_facilities_in_ratoma(self):
        before = Hospital.objects.count()
        created, skipped = prefill_ratoma_facilities()
        self.assertEqual(len(created), len(RATOMA_FACILITIES))
        self.assertEqual(skipped, [])
        self.assertEqual(Hospital.objects.count(), before + len(RATOMA_FACILITIES))
        for h in Hospital.objects.filter(name__in=created):
            self.assertEqual((h.commune, h.region), ('Ratoma', 'Conakry'))
            self.assertRegex(h.code, r'^WH-\d{4}-\d{2}$')
            self.assertEqual((h.phone, h.email, h.contact_name), ('', '', ''))        # nothing invented
            self.assertTrue(h.is_active)
        # no facility known to be elsewhere (Ambroise Paré is in Dixinn, Donka is not in Ratoma)
        self.assertFalse(Hospital.objects.filter(name__icontains='Ambroise').exists())

    def test_prefill_is_idempotent_and_never_recreates_an_archived_facility(self):
        prefill_ratoma_facilities()
        created, skipped = prefill_ratoma_facilities()
        self.assertEqual(created, [])
        self.assertEqual(len(skipped), len(RATOMA_FACILITIES))
        first = Hospital.objects.get(name=RATOMA_FACILITIES[0]['name'])
        first.archive(user=self.admin)
        created, _ = prefill_ratoma_facilities()
        self.assertEqual(created, [])
        self.assertEqual(Hospital.all_objects.filter(name=first.name).count(), 1)

    def test_an_existing_facility_with_the_same_name_is_left_alone(self):
        Hospital.objects.create(name='centre médical communal (cmc) de ratoma', phone='+224 622 00 00 00')
        created, skipped = prefill_ratoma_facilities()
        self.assertEqual(len(skipped), 1)
        self.assertEqual(Hospital.objects.get(name__iexact='Centre Médical Communal (CMC) de Ratoma').phone, '+224 622 00 00 00')

    def test_setup_initial_data_prefills_once_only(self):
        before = Hospital.objects.count()
        call_command('setup_initial_data', skip_admin=True, verbosity=0)
        self.assertEqual(Hospital.objects.count(), before + len(RATOMA_FACILITIES))
        self.assertTrue(SiteSetting.objects.filter(key='bootstrap.ratoma_hospitals').exists())
        Hospital.objects.filter(name=RATOMA_FACILITIES[1]['name']).first().archive(user=self.admin)
        call_command('setup_initial_data', skip_admin=True, verbosity=0)      # next deployment: nothing comes back
        self.assertEqual(Hospital.objects.count(), before + len(RATOMA_FACILITIES) - 1)

    def test_the_seed_command_reports_what_it_did(self):
        out = StringIO()
        call_command('seed_hospitals', stdout=out)
        self.assertIn(f'{len(RATOMA_FACILITIES)} établissement(s) créé(s)', out.getvalue())
        out = StringIO()
        call_command('seed_hospitals', stdout=out)
        self.assertIn('0 établissement(s) créé(s)', out.getvalue())

    def test_the_prefilled_facilities_appear_in_the_secretary_list_and_can_be_managed(self):
        prefill_ratoma_facilities()
        c = self.client_for(self.secretary)
        names = [h['name'] for h in c.get('/api/hospitals/', {'page_size': 100}).data['results']]
        self.assertIn("Hôpital de l'Amitié Sino-Guinéenne", names)
        uuid = next(h['uuid'] for h in c.get('/api/hospitals/', {'search': 'Sino', 'page_size': 100}).data['results'])
        self.assertEqual(c.patch(f'/api/hospitals/{uuid}/', {'phone': '+224 622 11 22 33'}, format='json').status_code, 200)


class MairieFacilityListTests(WakaraTestCase):
    """The list of structures given by the mairie (photographed sheet): names only, no duplicates."""
    NEW_NAMES = [
        'Centre de santé de Koloma Soloprimo', 'Centre de santé Fondis (Kaporo Centre)',
        'Centre de santé Hadja Djene Kaba (Kaporo Centre)', 'Clinique Jean Oury de Hamdallaye II',
        'Clinique de Bomboly', 'Clinique AGVF de Koloma Soloprimo', 'Clinique Mères et Enfants Kipé',
        'Clinique AK Arabic Bambeto', 'Clinique Aide Mère et Enfant Hamdallaye Mosquée',
    ]

    def test_a_database_that_already_ran_the_first_list_receives_only_the_new_names(self):
        # production state: the first pre-fill already happened (marker set), the 7 first facilities exist
        from hospitals.ratoma import FIRST_BATCH
        prefill_ratoma_facilities(FIRST_BATCH)
        SiteSetting.objects.create(key='bootstrap.ratoma_hospitals', value='done', is_public=False)
        before = Hospital.objects.count()
        self.assertFalse(Hospital.objects.filter(name__in=self.NEW_NAMES).exists())
        call_command('setup_initial_data', skip_admin=True, verbosity=0)
        self.assertEqual(Hospital.objects.count(), before + len(self.NEW_NAMES))
        self.assertEqual(Hospital.objects.filter(name__in=self.NEW_NAMES).count(), len(self.NEW_NAMES))
        # the three structures of the sheet that already existed are not duplicated
        for existing in ('Centre Médical Communal (CMC) de Ratoma', 'Hôpital Jean-Paul II', "Hôpital de l'Amitié Sino-Guinéenne"):
            self.assertEqual(Hospital.all_objects.filter(name=existing).count(), 1)
        self.assertEqual(len(FIRST_BATCH), 7)
        call_command('setup_initial_data', skip_admin=True, verbosity=0)   # next deployment: nothing more
        self.assertEqual(Hospital.objects.count(), before + len(self.NEW_NAMES))

    def test_only_names_are_recorded_without_public_or_private_mention(self):
        prefill_ratoma_facilities()
        for h in Hospital.objects.filter(name__in=self.NEW_NAMES):
            self.assertEqual((h.address, h.phone, h.email, h.contact_name), ('', '', '', ''))
            self.assertNotRegex(h.name.lower(), r'public|privé|prive')
            self.assertEqual(h.commune, 'Ratoma')
