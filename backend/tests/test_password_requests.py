"""« Mot de passe oublié »: the request is left to the administrators (notification), waits, and is handled or dismissed."""
from rest_framework.test import APIClient

from accounts.models import PasswordResetRequest
from audit.models import AuditAction, AuditLog

from .base import WakaraTestCase, make_user

URL = '/api/auth/forgot-password/'


class ForgotPasswordTests(WakaraTestCase):
    def ask(self, identifier, **extra):
        return APIClient().post(URL, {'username': identifier, **extra}, format='json')

    def pending(self, user=None):
        qs = PasswordResetRequest.objects.filter(status=PasswordResetRequest.PENDING)
        return qs.filter(user=user) if user else qs

    def test_a_request_waits_for_the_administrators(self):
        r = self.ask('agent')
        self.assertEqual(r.status_code, 202)
        self.assertIn('en attente', r.data['detail'])
        self.assertEqual(self.pending(self.agent).count(), 1)
        self.assertTrue(AuditLog.objects.filter(action=AuditAction.PASSWORD_RESET_REQUESTED, object_id=str(self.agent.uuid)).exists())

    def test_every_identifier_gets_the_same_answer(self):
        self.agent2.is_active = False
        self.agent2.save()
        answers = [self.ask(x) for x in ('agent', 'AGENT', 'inconnu.total', 'agent2', 'x' * 200)]
        self.assertEqual({a.status_code for a in answers}, {202})
        self.assertEqual({a.data['detail'] for a in answers}, {answers[0].data['detail']})
        self.assertEqual(self.pending().count(), 1)            # only the real, active account left a request

    def test_the_address_is_matched_like_at_sign_in(self):
        self.agent.email = 'agent@example.test'
        self.agent.save()
        self.ask('Agent@Example.test')
        self.assertEqual(self.pending(self.agent).count(), 1)

    def test_asking_again_does_not_pile_requests_up(self):
        for _ in range(3):
            self.ask('agent')
        row = self.pending(self.agent).get()
        self.assertEqual(row.request_count, 3)
        self.assertEqual(AuditLog.objects.filter(action=AuditAction.PASSWORD_RESET_REQUESTED, object_id=str(self.agent.uuid)).count(), 1)

    def test_a_robot_leaves_nothing(self):
        r = self.ask('agent', website='http://spam.example')
        self.assertEqual(r.status_code, 202)
        self.assertEqual(self.pending().count(), 0)

    def test_what_was_typed_is_never_kept_for_an_unknown_identifier(self):
        self.ask('MonMotDePasse-Secret-42')
        text = ' '.join(f'{l.username} {l.reason} {l.changes}' for l in AuditLog.objects.filter(action=AuditAction.PASSWORD_RESET_REQUESTED))
        self.assertNotIn('MonMotDePasse', text)

    def test_the_requests_are_limited_per_address(self):
        codes = [self.ask('agent').status_code for _ in range(12)]
        self.assertEqual(codes[:10], [202] * 10)
        self.assertEqual(codes[10], 429)

    def test_the_identifier_is_required(self):
        self.assertEqual(self.ask('').status_code, 400)
        self.assertEqual(APIClient().post(URL, {}, format='json').status_code, 400)


class HandlingTests(WakaraTestCase):
    def setUp(self):
        super().setUp()
        APIClient().post(URL, {'username': 'agent'}, format='json')

    def test_the_administrator_is_notified_and_sees_the_request(self):
        c = self.client_for(self.admin)
        inbox = c.get('/api/inbox/').data
        self.assertEqual(inbox['badges'].get('/users'), 1)
        item = next(i for i in inbox['items'] if i['code'] == 'password_requests')
        self.assertEqual((item['count'], item['status']), (1, 'PASSWORD'))
        rows = c.get('/api/users/reset-requests/').data
        self.assertEqual([(r['username'], r['can_handle'], r['request_count']) for r in rows], [('agent', True, 1)])

    def test_the_others_are_not_notified_and_cannot_read_the_requests(self):
        for user in (self.agent, self.secretary):
            c = self.client_for(user)
            self.assertNotIn('/users', c.get('/api/inbox/').data['badges'])
            self.assertEqual(c.get('/api/users/reset-requests/').status_code, 403)

    def test_resetting_the_password_closes_the_request(self):
        c = self.client_for(self.admin)
        self.assertEqual(c.post(f'/api/users/{self.agent.uuid}/reset-password/').status_code, 200)
        row = PasswordResetRequest.objects.get(user=self.agent)
        self.assertEqual((row.status, row.handled_by), ('handled', self.admin))
        self.assertEqual(c.get('/api/users/reset-requests/').data, [])
        self.assertNotIn('/users', c.get('/api/inbox/').data['badges'])

    def test_dismissing_a_request(self):
        c = self.client_for(self.admin)
        self.assertEqual(c.post(f'/api/users/{self.agent.uuid}/dismiss-reset-request/').status_code, 200)
        self.assertEqual(PasswordResetRequest.objects.get(user=self.agent).status, 'dismissed')
        self.assertTrue(AuditLog.objects.filter(action=AuditAction.PASSWORD_RESET_DISMISSED, object_id=str(self.agent.uuid)).exists())
        self.assertEqual(c.post(f'/api/users/{self.agent.uuid}/dismiss-reset-request/').status_code, 400)   # nothing left to dismiss

    def test_a_new_request_can_follow_a_handled_one(self):
        c = self.client_for(self.admin)
        c.post(f'/api/users/{self.agent.uuid}/reset-password/')
        APIClient().post(URL, {'username': 'agent'}, format='json')
        self.assertEqual(PasswordResetRequest.objects.filter(user=self.agent).count(), 2)
        self.assertEqual(PasswordResetRequest.objects.filter(user=self.agent, status='pending').count(), 1)

    def test_an_administrator_cannot_handle_his_own_request(self):
        APIClient().post(URL, {'username': 'admin'}, format='json')
        rows = {r['username']: r for r in self.client_for(self.admin).get('/api/users/reset-requests/').data}
        self.assertFalse(rows['admin']['can_handle'])
        self.assertTrue(rows['agent']['can_handle'])
        other = make_user('admin2', 'admin')
        rows = {r['username']: r for r in self.client_for(other).get('/api/users/reset-requests/').data}
        self.assertTrue(rows['admin']['can_handle'])            # another administrator can
