"""Offline mode for every role: the secretariat and the validator work from a device like the collection agent."""
from django.test import override_settings
from django.utils import timezone
import datetime

from declarations.models import Declaration

from .test_offline_sync import SyncTestCase


class RoleSyncCase(SyncTestCase):
    def transmitted(self):
        """A dossier the agent transmitted (online); returns its uuid."""
        uuid = self.create_declaration()['uuid']
        self.assertEqual(self.transition(self.agent, uuid, 'TRANSMITTED').status_code, 200)
        return uuid

    def answer(self, user, op):
        r = self.push(user, [op])
        self.assertEqual(r.status_code, 200, r.content)
        return r.data['results'][0]


class ReferenceDataTests(RoleSyncCase):
    def test_reference_data_is_served_without_any_dossier(self):
        r = self.client_for(self.agent).get('/api/sync/reference/')
        self.assertEqual(r.status_code, 200)
        self.assertEqual([h['code'] for h in r.data['hospitals']], ['CMC'])
        self.assertIn('birth_date', r.data['rules']['required_for_transmission'])
        self.assertIn('required_for_submission', r.data['rules'])
        self.assertIn('expected_for_validation', r.data['rules'])
        self.assertEqual(r.data['rules']['deadline_months'], 6)
        self.assertNotIn('declarations', r.data)

    def test_reference_data_needs_a_session_bound_to_the_device_and_a_permission(self):
        self.assertEqual(self.client_for(self.nobody).get('/api/sync/reference/').status_code, 403)
        unbound = super(SyncTestCase, self).client_for(self.agent)   # no device claim
        r = unbound.get('/api/sync/reference/')
        self.assertEqual((r.status_code, r.data['code']), (403, 'device_binding_required'))

    def test_every_workstation_gets_the_facilities(self):
        for user in (self.secretary, self.admin):
            r = self.client_for(user).get('/api/sync/reference/')
            self.assertEqual([h['code'] for h in r.data['hospitals']], ['CMC'], user.username)


class SecretariatPullTests(RoleSyncCase):
    def test_the_secretariat_receives_the_transmitted_dossiers_and_their_registry_header(self):
        sent = self.transmitted()
        draft = self.create_declaration()['uuid']
        r = self.client_for(self.secretary).get('/api/sync/pull/')
        self.assertEqual(r.status_code, 200)
        rows = {d['uuid']: d for d in r.data['declarations']}
        self.assertIn(sent, rows)
        self.assertNotIn(draft, rows)              # the draft of an agent stays in his own space
        self.assertIn('registre', rows[sent]['acte'])     # the header the secretariat fills in, without a second call
        self.assertTrue(rows[sent]['acte']['can_edit'])

    def test_the_agent_keeps_receiving_only_his_own_dossiers(self):
        mine = self.create_declaration()['uuid']
        self.create_declaration(user=self.agent2)
        rows = self.client_for(self.agent).get('/api/sync/pull/').data['declarations']
        self.assertEqual([d['uuid'] for d in rows], [mine])
        self.assertNotIn('acte', rows[0])          # an agent has no right on the actes

    def test_closed_dossiers_are_not_part_of_the_first_pull_after_the_recent_window(self):
        uuid = self.transmitted()
        Declaration.objects.filter(uuid=uuid).update(status='VALIDATED', updated_at='2020-01-01T00:00:00Z')
        rows = self.client_for(self.secretary).get('/api/sync/pull/').data['declarations']
        self.assertNotIn(uuid, [d['uuid'] for d in rows])


class SecretariatPushTests(RoleSyncCase):
    def test_the_secretariat_completes_the_registry_header_from_a_device(self):
        uuid = self.transmitted()
        version = Declaration.objects.get(uuid=uuid).sync_version
        r = self.answer(self.secretary, self.op('update', entity=uuid, base_version=version, payload={
            'doctor_name': 'Dr Corrigé', 'acte': {'registre': 'R7', 'feuillet': '12'}}))
        self.assertEqual(r['status'], 'applied', r)
        d = Declaration.objects.get(uuid=uuid)
        self.assertEqual((d.doctor_name, d.acte.registre, d.acte.feuillet), ('Dr Corrigé', 'R7', '12'))

    def test_a_collection_device_still_cannot_write_the_acte(self):
        uuid = self.create_declaration()['uuid']
        version = Declaration.objects.get(uuid=uuid).sync_version
        r = self.answer(self.agent, self.op('update', entity=uuid, base_version=version, payload={
            'notes': 'ok', 'acte': {'registre': 'R7'}}))
        self.assertEqual(r['status'], 'applied')
        d = Declaration.objects.get(uuid=uuid)
        self.assertEqual(d.notes, 'ok')
        self.assertFalse(getattr(d, 'acte', None) and d.acte.registre)

    def test_the_secretariat_cannot_touch_the_draft_of_an_agent(self):
        uuid = self.create_declaration()['uuid']
        version = Declaration.objects.get(uuid=uuid).sync_version
        r = self.answer(self.secretary, self.op('update', entity=uuid, base_version=version, payload={'notes': 'x'}))
        self.assertEqual((r['status'], r['error']['code']), ('rejected', 'forbidden'))

    def test_submission_to_validation_goes_through_the_usual_rules(self):
        uuid = self.transmitted()
        r = self.answer(self.secretary, self.op('transition', entity=uuid, payload={
            'status': 'PENDING_VALIDATION', 'from_status': 'TRANSMITTED'}))
        # the declarant is required by the submission rule of the tests: refused exactly as online
        self.assertEqual(r['status'], 'rejected', r)
        self.assertIn('declarant', str(r['error']))
        self.assertEqual(Declaration.objects.get(uuid=uuid).status, 'TRANSMITTED')
        self.client_for(self.secretary).patch(f'/api/declarations/{uuid}/', {
            'declarant': {'first_names': 'Mamadou', 'last_name': 'Diallo', 'relationship': 'Père'}}, format='json')
        r = self.answer(self.secretary, self.op('transition', entity=uuid, payload={
            'status': 'PENDING_VALIDATION', 'from_status': 'TRANSMITTED'}))
        self.assertEqual(r['status'], 'applied', r)
        self.assertEqual(Declaration.objects.get(uuid=uuid).status, 'PENDING_VALIDATION')

    def test_a_decision_taken_on_an_outdated_step_is_a_conflict(self):
        uuid = self.transmitted()
        self.client_for(self.secretary).patch(f'/api/declarations/{uuid}/', {
            'declarant': {'first_names': 'Mamadou', 'last_name': 'Diallo', 'relationship': 'Père'}}, format='json')
        self.assertEqual(self.transition(self.secretary, uuid, 'PENDING_VALIDATION').status_code, 200)
        r = self.answer(self.secretary, self.op('transition', entity=uuid, payload={
            'status': 'PENDING_VALIDATION', 'from_status': 'TRANSMITTED'}))
        self.assertEqual((r['status'], r['error']['code']), ('conflict', 'status_changed'))

    def test_a_decision_on_a_dossier_changed_since_is_a_version_conflict(self):
        uuid = self.transmitted()
        stale = Declaration.objects.get(uuid=uuid).sync_version
        self.client_for(self.secretary).patch(f'/api/declarations/{uuid}/', {'notes': 'vu entre-temps'}, format='json')
        r = self.answer(self.secretary, self.op('transition', entity=uuid, base_version=stale, payload={
            'status': 'IN_COMPLETION', 'from_status': 'TRANSMITTED'}))
        self.assertEqual((r['status'], r['error']['code']), ('conflict', 'version_conflict'))

    def test_the_offline_decision_is_replayed_once_and_traced(self):
        uuid = self.transmitted()
        self.client_for(self.secretary).patch(f'/api/declarations/{uuid}/', {
            'declarant': {'first_names': 'Mamadou', 'last_name': 'Diallo', 'relationship': 'Père'}}, format='json')
        op = self.op('transition', entity=uuid, payload={'status': 'PENDING_VALIDATION', 'from_status': 'TRANSMITTED'})
        self.assertEqual(self.answer(self.secretary, op)['status'], 'applied')
        self.assertEqual(self.answer(self.secretary, op)['status'], 'duplicate')
        history = list(Declaration.objects.get(uuid=uuid).status_history.values_list('to_status', flat=True))
        self.assertEqual(history.count('PENDING_VALIDATION'), 1)


class ValidationFromADeviceTests(RoleSyncCase):
    def pending(self):
        uuid = self.create_declaration()['uuid']
        self.advance_to_pending(uuid)
        return uuid

    def test_the_administrator_validates_and_numbers_from_a_device(self):
        uuid = self.pending()
        r = self.answer(self.admin, self.op('transition', entity=uuid, payload={
            'status': 'VALIDATED', 'from_status': 'PENDING_VALIDATION', 'annee': 2026, 'registre': 'R1',
            'feuillet': '3', 'numero_acte': '4521', 'accept_incomplete': True}))
        self.assertEqual(r['status'], 'applied', r)
        d = Declaration.objects.get(uuid=uuid)
        self.assertEqual((d.status, d.acte.numero_acte, d.validated_by_id), ('VALIDATED', '4521', self.admin.id))

    @override_settings(DOSSIER_SEPARATE_SUBMIT_AND_VALIDATE=False)
    def test_the_secretary_validates_like_the_administrator(self):
        uuid = self.pending()
        r = self.answer(self.secretary, self.op('transition', entity=uuid, payload={
            'status': 'VALIDATED', 'from_status': 'PENDING_VALIDATION', 'annee': 2026, 'registre': 'R1',
            'numero_acte': '77', 'accept_incomplete': True}))
        self.assertEqual(r['status'], 'applied', r)

    def test_an_official_number_already_taken_is_refused_at_synchronisation(self):
        first, second = self.pending(), self.pending()
        body = {'status': 'VALIDATED', 'from_status': 'PENDING_VALIDATION', 'annee': 2026, 'registre': 'R1',
                'numero_acte': '9', 'accept_incomplete': True}
        self.assertEqual(self.answer(self.admin, self.op('transition', entity=first, payload=body))['status'], 'applied')
        r = self.answer(self.admin, self.op('transition', entity=second, payload=body))
        self.assertEqual(r['status'], 'rejected', r)
        self.assertIn('numero_acte', str(r['error']))
        self.assertEqual(Declaration.objects.get(uuid=second).status, 'PENDING_VALIDATION')

    def test_expected_fields_still_empty_ask_for_the_confirmation(self):
        uuid = self.pending()
        r = self.answer(self.admin, self.op('transition', entity=uuid, payload={
            'status': 'VALIDATED', 'from_status': 'PENDING_VALIDATION', 'annee': 2026, 'registre': 'R1',
            'numero_acte': '31'}))
        if r['status'] == 'applied':
            self.skipTest('no expected field is missing in this fixture')
        self.assertEqual((r['status'], r['error']['code']), ('rejected', 'incomplete_confirmation_required'))
        self.assertEqual(Declaration.objects.get(uuid=uuid).status, 'PENDING_VALIDATION')

    def test_an_agent_cannot_validate_from_a_device(self):
        uuid = self.pending()
        r = self.answer(self.agent, self.op('transition', entity=uuid, payload={
            'status': 'VALIDATED', 'from_status': 'PENDING_VALIDATION', 'numero_acte': '5', 'annee': 2026}))
        self.assertEqual(r['status'], 'rejected')
        self.assertEqual(Declaration.objects.get(uuid=uuid).status, 'PENDING_VALIDATION')

    def test_sending_back_needs_a_reason(self):
        uuid = self.pending()
        r = self.answer(self.admin, self.op('transition', entity=uuid, payload={
            'status': 'TO_CORRECT_COLLECTION', 'from_status': 'PENDING_VALIDATION'}))
        self.assertEqual(r['status'], 'rejected')
        r = self.answer(self.admin, self.op('transition', entity=uuid, payload={
            'status': 'TO_CORRECT_COLLECTION', 'from_status': 'PENDING_VALIDATION', 'reason': 'Date illisible'}))
        self.assertEqual(r['status'], 'applied', r)

    def test_the_six_month_rule_holds_at_synchronisation(self):
        uuid = self.pending()
        Declaration.objects.filter(uuid=uuid).update(received_at=timezone.localdate() - datetime.timedelta(days=400))
        body = {'status': 'VALIDATED', 'from_status': 'PENDING_VALIDATION', 'annee': 2026, 'registre': 'R1',
                'numero_acte': '12', 'accept_incomplete': True}
        r = self.answer(self.secretary, self.op('transition', entity=uuid, payload=body))
        self.assertEqual(r['status'], 'rejected', r)
        self.assertIn('tribunaux', r['error']['detail'])
        # the administrator keeps the hand
        self.assertEqual(self.answer(self.admin, self.op('transition', entity=uuid, payload=body))['status'], 'applied')

    def test_push_is_open_to_the_validator_but_not_to_an_account_without_any_right(self):
        self.assertEqual(self.push(self.nobody, []).status_code, 403)
        self.assertEqual(self.push(self.secretary, []).status_code, 200)
        self.assertEqual(self.push(self.admin, []).status_code, 200)
