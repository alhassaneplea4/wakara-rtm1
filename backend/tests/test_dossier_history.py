"""« Historiques des actes » : the administrator reads who did what on every dossier."""
import datetime
import shutil
import tempfile

from django.core.files.storage import FileSystemStorage
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from documents.models import SupportingDocument
from tests.base import WakaraTestCase

PDF = b'%PDF-1.4\n% dummy\n'


class DossierHistoryTests(WakaraTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._tmp = tempfile.mkdtemp()
        cls._field = SupportingDocument._meta.get_field('file')
        cls._old_storage = cls._field.storage
        cls._field.storage = FileSystemStorage(location=cls._tmp)

    @classmethod
    def tearDownClass(cls):
        cls._field.storage = cls._old_storage
        shutil.rmtree(cls._tmp, ignore_errors=True)
        super().tearDownClass()

    def story(self, number='7001', child='Aminata'):
        """A dossier taken from creation to delivery by three different people, with edits and a document."""
        d = self.create_declaration(child={'first_names': child, 'last_name': 'Diallo', 'gender': 'F'},
                                    mother={'first_names': 'Fatoumata', 'last_name': 'Bah', 'age': 28})
        uuid = d['uuid']
        agent = self.client_for(self.agent)
        self.assertEqual(agent.patch(f'/api/declarations/{uuid}/', {'child': {'first_names': child + ' Marie'}}, format='json').status_code, 200)
        up = agent.post('/api/documents/', {'declaration': uuid, 'kind': 'HOSPITAL_FORM', 'file': SimpleUploadedFile('fiche.pdf', PDF)}, format='multipart')
        self.assertEqual(up.status_code, 201, up.content)
        self.assertEqual(agent.get(f'/api/documents/{up.data["uuid"]}/download/').status_code, 200)
        acte = self.advance_to_pending(uuid)
        self.assertEqual(self.transition(self.admin, uuid, 'VALIDATED', annee=2026, registre='R1', numero_acte=number,
                                         accept_incomplete=True).status_code, 200)
        sec = self.client_for(self.secretary)
        self.assertEqual(sec.post(f'/api/actes/{acte}/print/').status_code, 201)
        r = sec.post(f'/api/actes/{acte}/deliver/', {'recipient_name': 'Mariam Camara'}, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        return uuid, acte

    # ── access ────────────────────────────────────────────
    def test_only_the_administrator_can_read_the_histories(self):
        uuid, _ = self.story()
        for url in ('/api/history/', f'/api/history/{uuid}/', '/api/history/summary/'):
            self.assertEqual(APIClient().get(url).status_code, 401, url)
            for user in (self.secretary, self.agent, self.nobody):
                self.assertEqual(self.client_for(user).get(url).status_code, 403, (url, user.username))
            self.assertEqual(self.client_for(self.admin).get(url).status_code, 200, url)

    def test_unknown_or_malformed_dossier_is_a_404(self):
        c = self.client_for(self.admin)
        self.assertEqual(c.get('/api/history/00000000-0000-0000-0000-000000000000/').status_code, 404)
        self.assertEqual(c.get('/api/history/not-a-uuid/').status_code, 404)

    # ── the story of one dossier ──────────────────────────
    def test_the_timeline_tells_who_did_what_in_plain_french(self):
        uuid, _ = self.story()
        data = self.client_for(self.admin).get(f'/api/history/{uuid}/').data
        events = data['events']
        titles = [e['title'] for e in events]
        for expected in ('Déclaration créée', 'Transmise au secrétariat', 'Prise en charge par le secrétariat',
                         'Envoyée à la validation', "Dossier d'acte ouvert", 'Exemplaire n° 1 imprimé',
                         'Acte remis à Mariam Camara', 'Numéro officiel attribué : 7001',
                         'Pièce ajoutée : fiche.pdf', 'Pièce consultée : fiche.pdf'):
            self.assertIn(expected, titles)
        self.assertTrue(any(t.startswith('Validée définitivement malgré des champs non renseignés') for t in titles))
        times = [e['at'] for e in events]
        self.assertEqual(times, sorted(times))                                   # chronological
        created = next(e for e in events if e['milestone'] == 'created')
        self.assertEqual((created['who'], created['roles']), ('Agent Test', ['Agent de collecte']))
        delivered = next(e for e in events if e['milestone'] == 'delivered')
        self.assertEqual(delivered['who'], 'Secretary Test')
        self.assertEqual(delivered['roles'], ["Secrétaire d'état civil"])
        self.assertEqual(next(e for e in events if e['milestone'] == 'validated')['who'], 'Admin Test')
        self.assertEqual(delivered['ip'], '127.0.0.1')

    def test_every_field_change_shows_before_and_after(self):
        uuid, _ = self.story(child='Aminata')
        data = self.client_for(self.admin).get(f'/api/history/{uuid}/').data
        edit = next(e for e in data['events'] if e['title'].startswith('Informations de la déclaration modifiées'))
        self.assertEqual(edit['who'], 'Agent Test')
        self.assertEqual(edit['details'], [{'label': 'Enfant · Prénoms', 'from': 'Aminata', 'to': 'Aminata Marie'}])
        validated = next(e for e in data['events'] if e['milestone'] == 'validated')
        labels = validated['details'][0]['value']
        self.assertIn('nom du père', labels)                                    # the missing fields are named

    def test_people_summary_counts_each_person_once(self):
        uuid, _ = self.story()
        data = self.client_for(self.admin).get(f'/api/history/{uuid}/').data
        by_name = {p['name']: p for p in data['people']}
        self.assertEqual(set(by_name), {'Agent Test', 'Secretary Test', 'Admin Test'})
        self.assertEqual(sum(p['count'] for p in data['people']), len(data['events']))
        self.assertEqual(data['people'][0]['name'], 'Agent Test')               # in order of first appearance
        self.assertIn('Délivrances', [k['label'] for k in by_name['Secretary Test']['kinds']])
        self.assertEqual(data['dossier']['official_number'], '7001')
        self.assertEqual(data['dossier']['validated_by_name'], 'Admin Test')

    # ── the list ──────────────────────────────────────────
    def test_list_shows_last_activity_and_event_count(self):
        uuid, _ = self.story()
        row = self.client_for(self.admin).get('/api/history/').data['results'][0]
        self.assertEqual(row['uuid'], uuid)
        self.assertEqual(row['official_number'], '7001')
        self.assertEqual(row['status'], 'DELIVERED')
        self.assertEqual(row['last_actor'], 'Secretary Test')
        self.assertEqual(row['last_action'], 'Acte remis à Mariam Camara')
        self.assertGreaterEqual(row['event_count'], 12)

    def test_the_most_recently_active_dossier_comes_first(self):
        first, first_acte = self.story('1', 'Premier')
        second, _ = self.story('2', 'Second')
        c = self.client_for(self.admin)
        self.assertEqual([r['uuid'] for r in c.get('/api/history/').data['results'][:2]], [second, first])
        # the old dossier receives a new event (a second copy is printed): it moves to the top
        self.assertEqual(self.client_for(self.secretary).post(f'/api/actes/{first_acte}/print/').status_code, 201)
        self.assertEqual([r['uuid'] for r in c.get('/api/history/').data['results'][:2]], [first, second])

    def test_search_finds_a_dossier_by_reference_number_child_parent_or_recipient(self):
        uuid, _ = self.story('8123', 'Kadiatou')
        other, _ = self.story('9999', 'Oumar')
        c = self.client_for(self.admin)
        ref = c.get('/api/history/').data['results']
        reference = next(r['reference'] for r in ref if r['uuid'] == uuid)

        def found(term):
            return {r['uuid'] for r in c.get('/api/history/', {'q': term}).data['results']}
        self.assertEqual(found(reference), {uuid})
        self.assertEqual(found('8123'), {uuid})                                  # official number
        self.assertEqual(found('kadiatou'), {uuid})                              # child
        self.assertEqual(found('Kadiatou Diallo'), {uuid})                       # several words
        self.assertEqual(found('Camara'), {uuid, other})                         # recipient of the delivery
        self.assertEqual(found('Fatoumata Bah'), {uuid, other})                  # mother
        self.assertEqual(found('introuvable'), set())

    def test_filters_by_person_kind_status_and_dates(self):
        uuid, _ = self.story()
        pending = self.create_declaration()['uuid']                              # only created by the agent
        c = self.client_for(self.admin)

        def ids(**params):
            return {r['uuid'] for r in c.get('/api/history/', params).data['results']}
        self.assertEqual(ids(user=str(self.secretary.uuid)), {uuid})             # the secretary never touched the other
        self.assertEqual(ids(user=str(self.agent.uuid)), {uuid, pending})
        self.assertEqual(ids(kind='delivrance'), {uuid})
        self.assertEqual(ids(kind='impression'), {uuid})
        self.assertEqual(ids(kind='creation'), {uuid, pending})
        self.assertEqual(ids(status='DELIVERED'), {uuid})
        self.assertEqual(ids(status='DRAFT'), {pending})
        today = datetime.date.today().isoformat()
        self.assertEqual(ids(**{'from': today, 'to': today}), {uuid, pending})
        self.assertEqual(ids(**{'from': '2000-01-01', 'to': '2000-01-02'}), set())
        self.assertEqual(ids(user=str(self.agent.uuid), kind='delivrance'), set())     # combined: the agent delivered nothing
        self.assertEqual(c.get('/api/history/', {'from': 'pas-une-date'}).status_code, 400)

    def test_summary_counts_today(self):
        self.story()
        s = self.client_for(self.admin).get('/api/history/summary/').data
        self.assertEqual(s['dossiers_today'], 1)
        self.assertEqual(s['users_today'], 3)
        self.assertEqual(s['deliveries_today'], 1)
        self.assertGreaterEqual(s['events_today'], 12)
        self.assertGreaterEqual(s['changes_today'], 1)

    def test_archived_dossiers_remain_readable(self):
        d = self.create_declaration()
        self.assertEqual(self.client_for(self.admin).delete(f'/api/declarations/{d["uuid"]}/').status_code, 204)
        row = next(r for r in self.client_for(self.admin).get('/api/history/').data['results'] if r['uuid'] == d['uuid'])
        self.assertTrue(row['is_archived'])
        titles = [e['title'] for e in self.client_for(self.admin).get(f'/api/history/{d["uuid"]}/').data['events']]
        self.assertIn('Déclaration archivée', titles)
