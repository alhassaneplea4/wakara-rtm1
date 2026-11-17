"""Remaining points of the global audit (docs/audit-securite-global.md): sessions, identifiers, separation of duties,
withdrawal of the pages already sent."""
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from rest_framework.test import APIClient

from .base import PASSWORD, WakaraTestCase, make_user

JPEG = b'\xff\xd8\xff\xe0' + b'x' * 200


def sign_in(username, password=PASSWORD, ip='198.51.100.7'):
    """A client really authenticated with the access token of a sign-in (not forced), as a browser would be."""
    r = APIClient().post('/api/auth/login/', {'username': username, 'password': password}, format='json', REMOTE_ADDR=ip)
    assert r.status_code == 200, r.content
    c = APIClient()
    c.credentials(HTTP_AUTHORIZATION='Bearer ' + r.data['access'])
    return c, r.data


class SessionsTests(WakaraTestCase):
    def test_the_access_token_stops_working_at_sign_out(self):
        c, tokens = sign_in('agent')
        self.assertEqual(c.get('/api/auth/me/').status_code, 200)
        self.assertEqual(c.post('/api/auth/logout/', {'refresh': tokens['refresh']}, format='json').status_code, 204)
        self.assertEqual(c.get('/api/auth/me/').status_code, 401)
        # another session of the same account is not touched
        other, _ = sign_in('agent')
        self.assertEqual(other.get('/api/auth/me/').status_code, 200)

    def test_every_session_ends_when_the_password_is_reset(self):
        c, _ = sign_in('agent')
        self.assertEqual(self.client_for(self.admin).post(f'/api/users/{self.agent.uuid}/reset-password/').status_code, 200)
        self.assertEqual(c.get('/api/auth/me/').status_code, 401)

    def test_every_session_ends_when_the_account_is_deactivated(self):
        c, _ = sign_in('agent')
        self.assertEqual(self.client_for(self.admin).post(f'/api/users/{self.agent.uuid}/deactivate/').status_code, 200)
        self.assertEqual(c.get('/api/auth/me/').status_code, 401)

    def test_changing_the_password_keeps_the_current_session_and_ends_the_others(self):
        c, _ = sign_in('agent')
        other, _ = sign_in('agent')
        r = c.post('/api/auth/change-password/', {'old_password': PASSWORD, 'new_password': 'Another-Passw0rd!y'}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        fresh = APIClient()
        fresh.credentials(HTTP_AUTHORIZATION='Bearer ' + r.data['access'])
        self.assertEqual(fresh.get('/api/auth/me/').status_code, 200)
        self.assertEqual(other.get('/api/auth/me/').status_code, 401)

    def test_the_new_password_must_differ_from_the_old_one(self):
        c, _ = sign_in('agent')
        r = c.post('/api/auth/change-password/', {'old_password': PASSWORD, 'new_password': PASSWORD}, format='json')
        self.assertEqual(r.status_code, 400)
        self.assertIn('différent', r.data['detail'])

    def test_a_short_password_is_refused(self):
        c, _ = sign_in('agent')
        r = c.post('/api/auth/change-password/', {'old_password': PASSWORD, 'new_password': 'Abcd-1234'}, format='json')
        self.assertEqual(r.status_code, 400)


@override_settings(LOGIN_MAX_FAILED_ATTEMPTS=3, LOGIN_LOCKOUT_MINUTES=15)
class AccountEnumerationTests(WakaraTestCase):
    def login(self, username, password='wrong', ip='203.0.113.9'):
        r = APIClient().post('/api/auth/login/', {'username': username, 'password': password}, format='json', REMOTE_ADDR=ip)
        return r.status_code, r.data.get('detail')

    def test_a_known_and_an_unknown_identifier_answer_the_same_way_all_along(self):
        known = [self.login('agent') for _ in range(6)]
        unknown = [self.login('nobody-at-all') for _ in range(6)]
        self.assertEqual(known, unknown)
        self.assertEqual(known[0][0], 401)
        self.assertEqual(known[-1][0], 403)  # both end locked, with the same message

    def test_the_audit_log_keeps_no_text_typed_in_the_identifier_field(self):
        from audit.models import AuditLog
        self.login('My-Secret-Passw0rd!')
        rows = list(AuditLog.objects.filter(action='login_failed').values_list('username', flat=True))
        self.assertTrue(rows and all(u.startswith('inconnu:') for u in rows))
        self.assertFalse([u for u in rows if 'Secret' in u])


class SeparationOfDutiesTests(WakaraTestCase):
    def test_nobody_validates_the_dossier_he_submitted(self):
        uuid = self.create_declaration()['uuid']
        self.advance_to_pending(uuid)            # the secretary submitted it
        r = self.transition(self.secretary, uuid, 'VALIDATED', annee=2026, registre='R1', numero_acte='5', accept_incomplete=True)
        self.assertEqual(r.status_code, 403)
        self.assertIn('Séparation des tâches', r.data['detail'])
        # somebody else validates it
        r = self.transition(self.admin, uuid, 'VALIDATED', annee=2026, registre='R1', numero_acte='5', accept_incomplete=True)
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_second_secretary_validates(self):
        second = make_user('secretary2', 'secretary')
        uuid = self.create_declaration()['uuid']
        self.advance_to_pending(uuid)
        r = self.transition(second, uuid, 'VALIDATED', annee=2026, registre='R1', numero_acte='6', accept_incomplete=True)
        self.assertEqual(r.status_code, 200, r.content)

    @override_settings(DOSSIER_SEPARATE_SUBMIT_AND_VALIDATE=False)
    def test_a_small_office_may_switch_the_rule_off(self):
        uuid = self.create_declaration()['uuid']
        self.advance_to_pending(uuid)
        r = self.transition(self.secretary, uuid, 'VALIDATED', annee=2026, registre='R1', numero_acte='7', accept_incomplete=True)
        self.assertEqual(r.status_code, 200, r.content)


class DocumentArchiveRightTests(WakaraTestCase):
    def upload(self, user, uuid):
        return self.client_for(user).post('/api/documents/', {
            'declaration': uuid, 'kind': 'OTHER', 'file': SimpleUploadedFile('piece.jpg', JPEG)}, format='multipart')

    def test_the_agent_withdraws_his_own_picture_only_while_the_dossier_is_his_draft(self):
        uuid = self.create_declaration()['uuid']
        mistaken = self.upload(self.agent, uuid).data['uuid']
        kept = self.upload(self.agent, uuid).data['uuid']
        self.assertEqual(self.client_for(self.agent).delete(f'/api/documents/{mistaken}/').status_code, 204)
        self.assertEqual(self.transition(self.agent, uuid, 'TRANSMITTED').status_code, 200)
        r = self.client_for(self.agent).delete(f'/api/documents/{kept}/')
        self.assertEqual(r.status_code, 403)
        self.assertIn('secrétariat', r.data['detail'])

    def test_the_secretariat_withdraws_a_page_already_sent(self):
        uuid = self.create_declaration()['uuid']
        doc = self.upload(self.agent, uuid).data['uuid']
        self.transition(self.agent, uuid, 'TRANSMITTED')
        self.assertEqual(self.client_for(self.secretary).delete(f'/api/documents/{doc}/').status_code, 204)

    def test_the_agent_never_withdraws_a_page_of_somebody_else(self):
        uuid = self.create_declaration()['uuid']
        doc = self.upload(self.agent, uuid).data['uuid']
        self.assertEqual(self.client_for(self.agent2).delete(f'/api/documents/{doc}/').status_code, 404)


class ProductionReadinessCommandTests(WakaraTestCase):
    def test_the_report_runs_and_flags_a_preview_account(self):
        from django.core.management import call_command
        from io import StringIO
        make_user('chef.apercu', 'secretary')
        out = StringIO()
        call_command('check_production', '--warn', stdout=out)
        text = out.getvalue()
        self.assertIn('chef.apercu', text)
        self.assertIn('bloquant(s)', text)

    def test_the_command_fails_when_a_blocking_point_fails(self):
        from django.core.management import call_command
        from io import StringIO
        with self.assertRaises(SystemExit):
            call_command('check_production', stdout=StringIO())   # tests run with SQLite and no Redis: not production
