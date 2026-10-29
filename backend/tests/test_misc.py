"""Responsible-agent filter, public settings and the per-dossier audit trail."""
from rest_framework.test import APIClient

from audit.models import AuditLog

from .base import WakaraTestCase


class AgentsFilterTests(WakaraTestCase):
    def test_agents_endpoint_lists_responsibles_for_privileged_roles_only(self):
        d = self.create_declaration(self.agent)
        self.create_declaration(self.agent)  # same responsible twice: must be listed once
        self.create_declaration(self.agent2)
        r = self.client_for(self.secretary).get('/api/declarations/agents/')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.data), 2)
        self.assertEqual({a['name'] for a in r.data}, {'Agent Test', 'Agent2 Test'})
        self.assertEqual(self.client_for(self.agent).get('/api/declarations/agents/').status_code, 403)
        # and the list can be filtered with it
        uuid = next(a['uuid'] for a in r.data if a['name'] == 'Agent Test')
        res = self.client_for(self.secretary).get(f'/api/declarations/?assigned_to={uuid}')
        self.assertEqual(res.data['count'], 2)
        self.assertIn(d['uuid'], [x['uuid'] for x in res.data['results']])


class PublicSettingsTests(WakaraTestCase):
    def test_login_texts_are_public_and_only_those(self):
        r = APIClient().get('/api/public/settings/')
        self.assertEqual(r.status_code, 200)
        self.assertIn('login.headline', r.data)
        self.assertNotIn('acte.default_commune', r.data)  # internal defaults are not exposed

    def test_settings_edit_requires_permission_and_is_audited(self):
        self.assertEqual(self.client_for(self.secretary).patch('/api/settings/', {}, format='json').status_code, 403)
        r = self.client_for(self.admin).patch('/api/settings/', {'login.tag': 'MAIRIE'}, format='json')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(APIClient().get('/api/public/settings/').data['login.tag'], 'MAIRIE')
        self.assertTrue(AuditLog.objects.filter(object_type='SiteSetting').exists())
        bad = self.client_for(self.admin).patch('/api/settings/', {'nope': 'x'}, format='json')
        self.assertEqual(bad.status_code, 400)


class DossierAuditTrailTests(WakaraTestCase):
    def test_journal_of_a_dossier_can_be_filtered_by_object_id(self):
        d = self.create_declaration()
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        r = self.client_for(self.admin).get(f'/api/audit/?object_id={d["uuid"]}')
        actions = {e['action'] for e in r.data['results']}
        self.assertTrue({'create', 'transmit'} <= actions)
        self.assertEqual(self.client_for(self.agent).get(f'/api/audit/?object_id={d["uuid"]}').status_code, 403)
