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
        self.assertEqual(self.badges(self.secretary).get('/declarations'), 1)
        self.assertNotIn('/declarations', self.badges(self.agent))
        self.assertNotIn('/validation', self.badges(self.secretary))
        # pending validation: only the validator sees it in his queue; the secretary's badge goes away
        self.advance_to_pending(self.create_declaration()['uuid'])
        self.assertEqual(self.badges(self.admin).get('/validation'), 1)
        self.assertNotIn('/validation', self.badges(self.agent))
        self.assertEqual(self.badges(self.secretary).get('/declarations'), 1)  # the first, still transmitted dossier

    def test_returned_to_the_agent_shows_up_in_his_badge(self):
        d = self.create_declaration()
        self.advance_to_pending(d['uuid'])
        r = self.transition(self.admin, d['uuid'], 'TO_CORRECT_COLLECTION', reason='Date à vérifier')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.badges(self.agent), {'/declarations': 1})

    def test_validated_dossiers_wait_for_delivery_in_the_actes_menu(self):
        d = self.create_declaration()
        self.advance_to_pending(d['uuid'])
        self.transition(self.admin, d['uuid'], 'VALIDATED', numero_acte='8001', annee=2026, registre='R1', accept_incomplete=True)
        self.assertEqual(self.badges(self.secretary).get('/actes'), 1)
        self.assertNotIn('/actes', self.badges(self.agent))


class ChildFieldsTests(WakaraTestCase):
    def child_of(self, uuid, user):
        return self.client_for(user).get(f'/api/declarations/{uuid}/').data['child']

    def test_weight_and_length_no_longer_exist(self):
        d = self.create_declaration(child={'first_names': 'A', 'last_name': 'B', 'gender': 'F',
                                           'birth_weight': '3.2', 'birth_length': '50'})
        child = self.child_of(d['uuid'], self.agent)
        self.assertEqual(set(child), {'first_names', 'last_name', 'gender', 'nationality', 'npi', 'birth_rank'})
        # sending them again (old client) is harmless: unknown keys are ignored
        r = self.client_for(self.agent).patch(
            f'/api/declarations/{d["uuid"]}/', {'child': {'birth_weight': '3.4', 'last_name': 'Camara'}}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.child_of(d['uuid'], self.agent)['last_name'], 'Camara')

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


class SecretariatTreatmentTests(WakaraTestCase):
    """The secretariat treats a transmitted dossier and sends it straight to the administrator's queue."""

    def test_treated_dossier_goes_to_the_validation_queue_in_one_step(self):
        d = self.create_declaration()
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        c = self.client_for(self.secretary)
        # not ready: the declarant is missing
        r = self.transition(self.secretary, d['uuid'], 'PENDING_VALIDATION')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(c.get(f'/api/declarations/{d["uuid"]}/').data['status'], 'TRANSMITTED')
        # the secretariat completes the dossier (child nationality / rank, declarant = the mother) and sends it
        r = c.patch(f'/api/declarations/{d["uuid"]}/', {
            'child': {'nationality': 'Guinéenne', 'birth_rank': 2},
            'declarant': {'first_names': 'Fatoumata', 'last_name': 'Bah', 'relationship': 'Mère'}}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.data['child']['birth_rank'], 2)
        self.assertEqual(self.transition(self.secretary, d['uuid'], 'PENDING_VALIDATION').status_code, 200)
        det = c.get(f'/api/declarations/{d["uuid"]}/').data
        self.assertEqual(det['status'], 'PENDING_VALIDATION')
        acte = c.get(f'/api/actes/{det["acte_uuid"]}/').data
        self.assertTrue(acte['declaration_date'])  # defaulted: the validator can still correct it
        queue = self.client_for(self.admin).get('/api/declarations/?status=PENDING_VALIDATION').data['results']
        self.assertIn(d['uuid'], [x['uuid'] for x in queue])
        # the secretariat's badge is gone, the validator's appears
        self.assertNotIn('/declarations', self.client_for(self.secretary).get('/api/inbox/').data['badges'])
        self.assertEqual(self.client_for(self.admin).get('/api/inbox/').data['badges'].get('/validation'), 1)

    def test_the_agent_cannot_skip_the_secretariat(self):
        d = self.create_declaration()
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        self.assertEqual(self.transition(self.agent, d['uuid'], 'PENDING_VALIDATION').status_code, 403)

    def test_the_child_data_is_in_the_acte_document(self):
        d = self.create_declaration(child={'first_names': 'A', 'last_name': 'B', 'gender': 'F',
                                           'nationality': 'Guinéenne', 'birth_rank': 3})
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        self.transition(self.secretary, d['uuid'], 'IN_COMPLETION')
        det = self.client_for(self.secretary).get(f'/api/declarations/{d["uuid"]}/').data
        doc = self.client_for(self.secretary).get(f'/api/actes/{det["acte_uuid"]}/document/').data
        self.assertEqual(doc['child']['nationality'], 'Guinéenne')
        self.assertEqual(doc['child']['birth_rank'], 3)
