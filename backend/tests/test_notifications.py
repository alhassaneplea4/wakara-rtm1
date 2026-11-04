"""Side-menu badges, the secretariat/validator editing rules and the agent's fields."""
from .base import WakaraTestCase


class MenuBadgeTests(WakaraTestCase):
    def badges(self, user):
        return self.client_for(user).get('/api/inbox/').data['badges']

    def test_badges_follow_the_work_waiting_for_each_profile(self):
        # agent: one draft to finish
        draft = self.create_declaration()
        self.assertEqual(self.badges(self.agent), {'/declarations': 1})
        # transmitted: the secretariat has work, the agent has nothing left to fill
        self.transition(self.agent, draft['uuid'], 'TRANSMITTED')
        self.assertEqual(self.badges(self.secretary).get('/secretariat'), 1)
        self.assertNotIn('/declarations', self.badges(self.agent))
        self.assertNotIn('/validation', self.badges(self.secretary))
        # pending validation: only the validator sees it in his queue; the secretary's badge goes away
        self.advance_to_pending(self.create_declaration()['uuid'])
        self.assertEqual(self.badges(self.admin).get('/validation'), 1)
        self.assertNotIn('/validation', self.badges(self.agent))
        self.assertEqual(self.badges(self.secretary).get('/secretariat'), 1)  # the first, still transmitted dossier

    def test_returned_to_the_agent_shows_up_in_his_badge(self):
        d = self.create_declaration()
        self.advance_to_pending(d['uuid'])
        r = self.transition(self.admin, d['uuid'], 'TO_CORRECT_COLLECTION', reason='Date à vérifier')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.badges(self.agent), {'/declarations': 1})

    def test_validated_dossiers_wait_for_delivery_in_the_actes_menu(self):
        d = self.create_declaration()
        self.advance_to_pending(d['uuid'])
        self.transition(self.admin, d['uuid'], 'VALIDATED', numero_acte='8001', annee=2026, registre='R1')
        self.assertEqual(self.badges(self.secretary).get('/actes'), 1)
        self.assertNotIn('/actes', self.badges(self.agent))


class AgentFieldsTests(WakaraTestCase):
    def child_of(self, uuid, user):
        return self.client_for(user).get(f'/api/declarations/{uuid}/').data['child']

    def test_weight_and_length_are_ignored_for_the_agent_and_kept_for_the_secretariat(self):
        d = self.create_declaration(child={'first_names': 'A', 'last_name': 'B', 'gender': 'F',
                                           'birth_weight': '3.2', 'birth_length': '50'})
        child = self.child_of(d['uuid'], self.agent)
        self.assertIsNone(child['birth_weight'])
        self.assertIsNone(child['birth_length'])
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        r = self.client_for(self.secretary).patch(
            f'/api/declarations/{d["uuid"]}/', {'child': {'birth_weight': '3.4', 'birth_length': '51'}}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(str(self.child_of(d['uuid'], self.secretary)['birth_weight']), '3.40')

    def test_admin_can_edit_acte_data_while_the_dossier_stays_in_the_validation_queue(self):
        d = self.create_declaration()
        self.advance_to_pending(d['uuid'])
        det = self.client_for(self.admin).get(f'/api/actes/{self.client_for(self.admin).get(f"/api/declarations/{d["uuid"]}/").data["acte_uuid"]}/')
        self.assertTrue(det.data['can_edit'])
        r = self.client_for(self.admin).patch(f'/api/actes/{det.data["uuid"]}/', {'feuillet': '12'}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.client_for(self.admin).get(f'/api/declarations/{d["uuid"]}/').data['status'], 'PENDING_VALIDATION')
        # the secretary, whose work is done, no longer can
        self.assertFalse(self.client_for(self.secretary).get(f'/api/actes/{det.data["uuid"]}/').data['can_edit'])
