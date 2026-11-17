"""Fixes of the offline-mode audit (docs/hors-ligne/audit-mode-hors-ligne.md): stacked operations, separation of duties
on the device, age limit of an entry, and the 'access lost' answer."""
import datetime
import uuid as uuidlib

from django.test import override_settings
from django.utils import timezone

from declarations.models import Declaration

from .test_offline_roles import RoleSyncCase

DECLARANT = {'first_names': 'Mamadou', 'last_name': 'Diallo', 'relationship': 'Père'}


class StackedOperationsTests(RoleSyncCase):
    def batch(self, user, ops):
        r = self.push(user, ops)
        self.assertEqual(r.status_code, 200, r.content)
        return r.data['results']

    def test_edits_stacked_after_a_step_in_the_same_batch_are_not_a_conflict(self):
        d = self.transmitted()
        v = Declaration.objects.get(uuid=d).sync_version
        first = self.op('update', entity=d, base_version=v, payload={'declarant': DECLARANT})
        step = self.op('transition', entity=d, after_op=first['op_id'],
                       payload={'status': 'PENDING_VALIDATION', 'from_status': 'TRANSMITTED'})
        last = self.op('update', entity=d, after_op=step['op_id'], payload={'notes': 'complété après la soumission'})
        res = self.batch(self.secretary, [first, step, last])
        self.assertEqual([r['status'] for r in res], ['applied', 'applied', 'applied'], res)
        self.assertEqual(Declaration.objects.get(uuid=d).notes, 'complété après la soumission')

    def test_a_change_by_somebody_else_in_between_is_still_a_conflict(self):
        d = self.transmitted()
        v = Declaration.objects.get(uuid=d).sync_version
        first = self.op('update', entity=d, base_version=v, payload={'declarant': DECLARANT})
        self.assertEqual(self.batch(self.secretary, [first])[0]['status'], 'applied')
        self.client_for(self.admin).patch(f'/api/declarations/{d}/', {'notes': 'vu par un autre'}, format='json')
        stacked = self.op('update', entity=d, after_op=first['op_id'], payload={'notes': 'moi'})
        res = self.batch(self.secretary, [stacked])
        self.assertEqual((res[0]['status'], res[0]['error']['code']), ('conflict', 'version_conflict'))
        self.assertEqual(Declaration.objects.get(uuid=d).notes, 'vu par un autre')

    def test_an_operation_stacked_on_one_the_server_has_not_applied_waits(self):
        d = self.transmitted()
        stacked = self.op('update', entity=d, after_op=str(uuidlib.uuid4()), payload={'notes': 'x'})
        res = self.batch(self.secretary, [stacked])
        self.assertEqual((res[0]['status'], res[0]['error']['code']), ('conflict', 'blocked'))

    def test_an_operation_cannot_borrow_the_version_of_somebody_elses_operation(self):
        d = self.transmitted()
        v = Declaration.objects.get(uuid=d).sync_version
        mine = self.op('update', entity=d, base_version=v, payload={'notes': 'a'})
        self.batch(self.secretary, [mine])
        stacked = self.op('update', entity=d, after_op=mine['op_id'], payload={'notes': 'b'})
        res = self.batch(self.admin, [stacked])          # another user quoting the secretary's operation
        self.assertEqual(res[0]['status'], 'conflict', res)

    def test_a_missing_reference_is_still_refused(self):
        d = self.transmitted()
        res = self.batch(self.secretary, [self.op('update', entity=d, payload={'notes': 'x'})])
        self.assertEqual((res[0]['status'], res[0]['error']['code']), ('rejected', 'validation'))


class SeparationOnTheDeviceTests(RoleSyncCase):
    def pending(self):
        d = self.create_declaration()['uuid']
        self.advance_to_pending(d)
        return d

    def test_the_rule_and_the_author_of_each_step_reach_the_device(self):
        d = self.pending()
        rules = self.client_for(self.secretary).get('/api/sync/reference/').data['rules']
        self.assertTrue(rules['separate_submit_and_validate'])
        row = {x['uuid']: x for x in self.client_for(self.secretary).get('/api/sync/pull/').data['declarations']}[d]
        submitted = [h for h in row['status_history'] if h['to_status'] == 'PENDING_VALIDATION']
        self.assertEqual(submitted[0]['changed_by'], str(self.secretary.uuid))
        self.assertNotIn('VALIDATED', [t['target'] for t in row['available_transitions']])

    @override_settings(DOSSIER_SEPARATE_SUBMIT_AND_VALIDATE=False)
    def test_the_rule_can_be_switched_off(self):
        d = self.pending()
        self.assertFalse(self.client_for(self.secretary).get('/api/sync/reference/').data['rules']['separate_submit_and_validate'])
        row = self.client_for(self.secretary).get(f'/api/declarations/{d}/').data
        self.assertIn('VALIDATED', [t['target'] for t in row['available_transitions']])

    def test_somebody_else_still_sees_the_validation(self):
        d = self.pending()
        row = self.client_for(self.admin).get(f'/api/declarations/{d}/').data
        self.assertIn('VALIDATED', [t['target'] for t in row['available_transitions']])


class AgeOfAnEntryTests(RoleSyncCase):
    def entered_days_ago(self, days):
        born = (timezone.localdate() - datetime.timedelta(days=days + 5)).isoformat()
        op = self.create_op(payload=self.declaration_payload(birth_date=born))
        op['device_time'] = (timezone.now() - datetime.timedelta(days=days)).isoformat()
        r = self.push(self.agent, [op])
        self.assertEqual(r.status_code, 200, r.content)
        return r.data['results'][0], Declaration.objects.get(uuid=op['entity_uuid'])

    def test_an_entry_of_two_months_keeps_its_date_and_is_flagged(self):
        result, declaration = self.entered_days_ago(60)
        self.assertEqual(result['date_anomaly'], 'late_entry')
        self.assertLess(declaration.device_created_at, timezone.now() - datetime.timedelta(days=59))

    def test_an_entry_older_than_the_limit_gets_the_date_of_the_server(self):
        result, declaration = self.entered_days_ago(150)
        self.assertEqual(result['date_anomaly'], 'too_old')


class AccessLostTests(RoleSyncCase):
    def test_a_user_who_lost_his_rights_gets_a_clear_code(self):
        from accounts.models import UserRole
        UserRole.objects.filter(user=self.secretary).update(is_active=False)
        for url in ('/api/sync/pull/', '/api/sync/reference/'):
            r = self.client_for(self.secretary).get(url)
            self.assertEqual((r.status_code, r.data['code']), (403, 'access_lost'), url)
        r = self.push(self.secretary, [self.op('update', entity=str(uuidlib.uuid4()), base_version=1, payload={})])
        self.assertEqual((r.status_code, r.data['code']), (403, 'access_lost'))


class PullSettleWindowTests(RoleSyncCase):
    """A dossier written a moment ago waits for the next pull: a late commit can never be skipped by the cursor."""

    @override_settings(SYNC_PULL_SETTLE_SECONDS=30)
    def test_a_dossier_changed_a_moment_ago_comes_with_the_next_pull(self):
        old = self.create_declaration()['uuid']
        Declaration.objects.filter(uuid=old).update(updated_at=timezone.now() - datetime.timedelta(minutes=5))
        fresh = self.create_declaration()['uuid']
        rows = {d['uuid'] for d in self.client_for(self.agent).get('/api/sync/pull/').data['declarations']}
        self.assertIn(old, rows)
        self.assertNotIn(fresh, rows)
        Declaration.objects.filter(uuid=fresh).update(updated_at=timezone.now() - datetime.timedelta(minutes=1))
        rows = {d['uuid'] for d in self.client_for(self.agent).get('/api/sync/pull/').data['declarations']}
        self.assertIn(fresh, rows)

    def test_without_the_window_everything_is_returned_at_once(self):
        fresh = self.create_declaration()['uuid']
        rows = {d['uuid'] for d in self.client_for(self.agent).get('/api/sync/pull/').data['declarations']}
        self.assertIn(fresh, rows)
