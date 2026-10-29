"""The dossier state machine: who may do what, in which status, with which data."""
import datetime

from django.test import override_settings

from actes.models import Acte
from audit.models import AuditLog
from declarations.models import Declaration, StatusHistory

from .base import WakaraTestCase


class HappyPathTests(WakaraTestCase):
    def test_full_circuit_collection_secretariat_admin_delivery(self):
        d = self.create_declaration()
        uuid = d['uuid']
        self.assertEqual(d['status'], 'DRAFT')
        self.assertRegex(d['reference'], r'^WKR-\d{4}-\d{4}$')
        acte_uuid = self.advance_to_pending(uuid)

        r = self.transition(self.admin, uuid, 'VALIDATED', annee=2026, registre='R1', numero_acte='101')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.data['status'], 'VALIDATED')
        self.assertEqual(r.data['official_number'], '101')
        self.assertEqual(r.data['validated_by_name'], 'Admin Test')

        sec = self.client_for(self.secretary)
        self.assertEqual(sec.post(f'/api/actes/{acte_uuid}/print/').status_code, 201)
        r = sec.post(f'/api/actes/{acte_uuid}/deliver/',
                     {'recipient_name': 'Mamadou Diallo', 'recipient_relationship': 'Père'}, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertFalse(r.data['is_duplicate'])
        self.assertEqual(Declaration.objects.get(uuid=uuid).status, 'DELIVERED')
        # second delivery = duplicate, status unchanged
        r = sec.post(f'/api/actes/{acte_uuid}/deliver/', {'recipient_name': 'Autre'}, format='json')
        self.assertTrue(r.data['is_duplicate'])

        statuses = list(StatusHistory.objects.filter(declaration__uuid=uuid)
                        .order_by('id').values_list('to_status', flat=True))
        self.assertEqual(statuses, ['DRAFT', 'TRANSMITTED', 'IN_COMPLETION', 'PENDING_VALIDATION',
                                    'VALIDATED', 'DELIVERED'])
        h = StatusHistory.objects.get(declaration__uuid=uuid, to_status='VALIDATED')
        self.assertEqual(h.changed_by, self.admin)

    def test_audit_records_each_step(self):
        d = self.create_declaration()
        self.advance_to_pending(d['uuid'])
        self.transition(self.admin, d['uuid'], 'VALIDATED', annee=2026, registre='R1', numero_acte='7')
        actions = set(AuditLog.objects.values_list('action', flat=True))
        self.assertTrue({'create', 'transmit', 'validate', 'number_assigned', 'update'} <= actions)


class AuthorisationTests(WakaraTestCase):
    def test_only_admin_can_validate_or_reject(self):
        d = self.create_declaration()
        self.advance_to_pending(d['uuid'])
        for user in (self.agent, self.secretary):
            r = self.transition(user, d['uuid'], 'VALIDATED', annee=2026, numero_acte='1')
            self.assertEqual(r.status_code, 403, user.username)
            r = self.transition(user, d['uuid'], 'REJECTED', reason='non')
            self.assertEqual(r.status_code, 403, user.username)
        self.assertEqual(Declaration.objects.get(uuid=d['uuid']).status, 'PENDING_VALIDATION')

    def test_agent_cannot_take_charge_or_submit(self):
        d = self.create_declaration()
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        self.assertEqual(self.transition(self.agent, d['uuid'], 'IN_COMPLETION').status_code, 403)

    def test_arbitrary_status_cannot_be_forced_through_the_api(self):
        d = self.create_declaration()
        c = self.client_for(self.admin)
        # PATCH with status is ignored (read-only field)
        c.patch(f'/api/declarations/{d["uuid"]}/', {'status': 'VALIDATED'}, format='json')
        self.assertEqual(Declaration.objects.get(uuid=d['uuid']).status, 'DRAFT')
        # skipping steps is refused even for the admin
        r = self.transition(self.admin, d['uuid'], 'VALIDATED', annee=2026, numero_acte='1')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.data['code'], 'invalid_transition')
        r = self.transition(self.admin, d['uuid'], 'DELIVERED')
        self.assertEqual(r.status_code, 400)

    def test_cannot_create_with_forged_status_or_reference(self):
        r = self.client_for(self.agent).post('/api/declarations/', self.declaration_payload(
            status='VALIDATED', reference='HACK-1', created_by=self.admin.pk), format='json')
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.data['status'], 'DRAFT')
        self.assertTrue(r.data['reference'].startswith('WKR-'))
        self.assertEqual(Declaration.objects.get(uuid=r.data['uuid']).created_by, self.agent)

    def test_agent_only_sees_and_touches_own_declarations(self):
        mine = self.create_declaration(self.agent)
        theirs = self.create_declaration(self.agent2)
        c = self.client_for(self.agent)
        uuids = [x['uuid'] for x in c.get('/api/declarations/').data['results']]
        self.assertIn(mine['uuid'], uuids)
        self.assertNotIn(theirs['uuid'], uuids)
        self.assertEqual(c.get(f'/api/declarations/{theirs["uuid"]}/').status_code, 404)
        self.assertEqual(c.patch(f'/api/declarations/{theirs["uuid"]}/', {'notes': 'x'}, format='json').status_code, 404)
        self.assertEqual(self.transition(self.agent, theirs['uuid'], 'TRANSMITTED').status_code, 404)
        # the secretary sees everything
        self.assertEqual(self.client_for(self.secretary).get('/api/declarations/').data['count'], 2)


class StateRuleTests(WakaraTestCase):
    def test_incomplete_declaration_cannot_be_transmitted(self):
        d = self.create_declaration(child={'first_names': '', 'last_name': ''}, mother=None)
        r = self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        self.assertEqual(r.status_code, 400)
        self.assertIn('child.name', r.data['missing_fields'])
        self.assertIn('mother.name', r.data['missing_fields'])
        self.assertEqual(Declaration.objects.get(uuid=d['uuid']).status, 'DRAFT')

    def test_secretary_cannot_submit_acte_without_required_data(self):
        d = self.create_declaration()
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        self.transition(self.secretary, d['uuid'], 'IN_COMPLETION')
        r = self.transition(self.secretary, d['uuid'], 'PENDING_VALIDATION')
        self.assertEqual(r.status_code, 400)
        self.assertIn('declarant.name', r.data['missing_fields'])

    def test_rejection_and_corrections_require_a_reason(self):
        d = self.create_declaration()
        self.advance_to_pending(d['uuid'])
        for target in ('REJECTED', 'TO_CORRECT_COLLECTION', 'TO_CORRECT_SECRETARIAT'):
            r = self.transition(self.admin, d['uuid'], target)
            self.assertEqual(r.status_code, 400, target)
            self.assertIn('reason', r.data)
        self.assertEqual(Declaration.objects.get(uuid=d['uuid']).status, 'PENDING_VALIDATION')

    def test_return_to_collection_then_back_through_the_circuit(self):
        d = self.create_declaration()
        uuid = d['uuid']
        self.advance_to_pending(uuid)
        r = self.transition(self.admin, uuid, 'TO_CORRECT_COLLECTION', reason='Date de naissance illisible')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data['last_decision_reason'], 'Date de naissance illisible')
        # agent fixes and re-transmits
        self.assertEqual(self.client_for(self.agent).patch(
            f'/api/declarations/{uuid}/', {'birth_place': 'Kipé'}, format='json').status_code, 200)
        self.assertEqual(self.transition(self.agent, uuid, 'TRANSMITTED').status_code, 200)
        self.assertEqual(self.transition(self.secretary, uuid, 'IN_COMPLETION').status_code, 200)
        self.assertEqual(self.transition(self.secretary, uuid, 'PENDING_VALIDATION').status_code, 200)
        r = self.transition(self.admin, uuid, 'TO_CORRECT_SECRETARIAT', reason='Mention manquante')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.transition(self.secretary, uuid, 'PENDING_VALIDATION').status_code, 200)

    def test_rejected_and_validated_dossiers_are_frozen(self):
        d = self.create_declaration()
        self.advance_to_pending(d['uuid'])
        self.transition(self.admin, d['uuid'], 'VALIDATED', annee=2026, registre='R1', numero_acte='5')
        for user in (self.agent, self.secretary, self.admin):
            r = self.client_for(user).patch(f'/api/declarations/{d["uuid"]}/', {'notes': 'x'}, format='json')
            self.assertIn(r.status_code, (403, 404), user.username)
        acte = Acte.objects.get(declaration__uuid=d['uuid'])
        r = self.client_for(self.secretary).patch(f'/api/actes/{acte.uuid}/', {'mentions': 'x'}, format='json')
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.transition(self.admin, d['uuid'], 'REJECTED', reason='x').status_code, 400)

    def test_data_locked_while_dossier_is_with_other_service(self):
        d = self.create_declaration()
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        # the agent can no longer edit once transmitted
        r = self.client_for(self.agent).patch(f'/api/declarations/{d["uuid"]}/', {'notes': 'x'}, format='json')
        self.assertEqual(r.status_code, 403)
        # the secretary cannot edit before taking charge
        r = self.client_for(self.secretary).patch(f'/api/declarations/{d["uuid"]}/', {'notes': 'x'}, format='json')
        self.assertEqual(r.status_code, 403)

    def test_future_birth_date_rejected(self):
        future = (datetime.date.today() + datetime.timedelta(days=2)).isoformat()
        r = self.client_for(self.agent).post(
            '/api/declarations/', self.declaration_payload(birth_date=future), format='json')
        self.assertEqual(r.status_code, 400)

    def test_inactive_hospital_refused_for_new_declaration(self):
        self.hospital.is_active = False
        self.hospital.save()
        r = self.client_for(self.agent).post('/api/declarations/', self.declaration_payload(), format='json')
        self.assertEqual(r.status_code, 400)

    def test_declaration_without_identified_hospital_is_accepted(self):
        r = self.client_for(self.agent).post(
            '/api/declarations/', self.declaration_payload(hospital=None), format='json')
        self.assertEqual(r.status_code, 201)
        self.assertIsNone(r.data['hospital'])

    def test_available_transitions_follow_the_actor(self):
        d = self.create_declaration()
        self.advance_to_pending(d['uuid'])
        admin_t = self.client_for(self.admin).get(f'/api/declarations/{d["uuid"]}/').data['available_transitions']
        sec_t = self.client_for(self.secretary).get(f'/api/declarations/{d["uuid"]}/').data['available_transitions']
        self.assertEqual({t['target'] for t in admin_t},
                         {'VALIDATED', 'REJECTED', 'TO_CORRECT_COLLECTION', 'TO_CORRECT_SECRETARIAT'})
        self.assertEqual(sec_t, [])


class OfficialNumberTests(WakaraTestCase):
    def _pending(self, **kw):
        d = self.create_declaration(**kw)
        self.advance_to_pending(d['uuid'])
        return d['uuid']

    def test_manual_number_required_when_auto_numbering_is_off(self):
        uuid = self._pending()
        r = self.transition(self.admin, uuid, 'VALIDATED', annee=2026, registre='R1')
        self.assertEqual(r.status_code, 400)
        self.assertIn('numero_acte', r.data)
        self.assertEqual(Declaration.objects.get(uuid=uuid).status, 'PENDING_VALIDATION')  # rolled back

    def test_duplicate_number_in_same_registry_refused(self):
        a, b = self._pending(), self._pending()
        self.assertEqual(self.transition(self.admin, a, 'VALIDATED', annee=2026, registre='R1', numero_acte='42').status_code, 200)
        r = self.transition(self.admin, b, 'VALIDATED', annee=2026, registre='R1', numero_acte='42')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(Declaration.objects.get(uuid=b).status, 'PENDING_VALIDATION')
        # same number in another registry is fine
        self.assertEqual(self.transition(self.admin, b, 'VALIDATED', annee=2026, registre='R2', numero_acte='42').status_code, 200)

    @override_settings(ACTE_AUTO_NUMBERING=True)
    def test_optional_auto_numbering_is_sequential_per_registry(self):
        a, b = self._pending(), self._pending()
        ra = self.transition(self.admin, a, 'VALIDATED', annee=2026, registre='R1')
        rb = self.transition(self.admin, b, 'VALIDATED', annee=2026, registre='R1')
        self.assertEqual((ra.data['official_number'], rb.data['official_number']), ('1', '2'))

    def test_number_never_overwritten_once_attributed(self):
        uuid = self._pending()
        self.transition(self.admin, uuid, 'VALIDATED', annee=2026, registre='R1', numero_acte='9')
        acte = Acte.objects.get(declaration__uuid=uuid)
        from actes.services import assign_official_number
        assign_official_number(acte, self.admin, numero_acte='10')
        self.assertEqual(Acte.objects.get(pk=acte.pk).numero_acte, '9')

    def test_official_number_not_editable_through_acte_patch(self):
        d = self.create_declaration()
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        self.transition(self.secretary, d['uuid'], 'IN_COMPLETION')
        acte = Acte.objects.get(declaration__uuid=d['uuid'])
        self.client_for(self.secretary).patch(f'/api/actes/{acte.uuid}/', {'numero_acte': '77'}, format='json')
        self.assertIsNone(Acte.objects.get(pk=acte.pk).numero_acte)


class DocumentOutputTests(WakaraTestCase):
    def test_preview_flagged_unofficial_and_print_refused_before_validation(self):
        d = self.create_declaration()
        acte_uuid = self.advance_to_pending(d['uuid'])
        sec = self.client_for(self.secretary)
        doc = sec.get(f'/api/actes/{acte_uuid}/document/').data
        self.assertFalse(doc['is_official'])
        self.assertEqual(sec.post(f'/api/actes/{acte_uuid}/print/').status_code, 400)
        self.assertEqual(sec.post(f'/api/actes/{acte_uuid}/deliver/', {'recipient_name': 'X'}, format='json').status_code, 400)
        self.transition(self.admin, d['uuid'], 'VALIDATED', annee=2026, registre='R1', numero_acte='3')
        self.assertTrue(sec.get(f'/api/actes/{acte_uuid}/document/').data['is_official'])

    def test_agent_cannot_print_or_deliver(self):
        d = self.create_declaration()
        acte_uuid = self.advance_to_pending(d['uuid'])
        self.transition(self.admin, d['uuid'], 'VALIDATED', annee=2026, registre='R1', numero_acte='3')
        c = self.client_for(self.agent)
        self.assertEqual(c.post(f'/api/actes/{acte_uuid}/print/').status_code, 403)
        self.assertEqual(c.post(f'/api/actes/{acte_uuid}/deliver/', {'recipient_name': 'X'}, format='json').status_code, 403)
