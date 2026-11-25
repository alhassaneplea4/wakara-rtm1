"""Wording of a transmitted dossier: it depends on who is looking."""
from django.urls import reverse

from tests.base import WakaraTestCase


class TransmittedWordingTests(WakaraTestCase):
    def test_agent_and_secretariat_read_their_own_wording(self):
        agent = self.client_for(self.agent)
        created = agent.post('/api/declarations/', self.declaration_payload(), format='json')
        self.assertEqual(created.status_code, 201, created.data)
        url = f"/api/declarations/{created.data['uuid']}/"
        sent = agent.post(url + 'transition/', {'status': 'TRANSMITTED'}, format='json')
        self.assertEqual(sent.status_code, 200, sent.data)

        for user, expected in ((self.agent, "Transmis à l'état civil"),
                               (self.secretary, 'Traitement en cours'),
                               (self.admin, 'Traitement en cours')):
            with self.subTest(user=user.username):
                self.assertEqual(self.client_for(user).get(url).data['status_label'], expected)

        dashboard = self.client_for(self.secretary).get(reverse('stats-dashboard')).data
        labels = {row['status']: row['label'] for row in dashboard['by_status']}
        self.assertEqual(labels['TRANSMITTED'], 'Traitement en cours')
