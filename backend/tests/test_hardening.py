"""Regression tests for the findings of the security audit (fictional data only)."""
import csv
import io

from django.test import RequestFactory, SimpleTestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import CustomUser
from audit.middleware import client_ip
from audit.models import AuditLog
from core.csv_safe import safe_cell
from tests.base import PASSWORD, WakaraTestCase, make_user


class ClientIpTests(SimpleTestCase):
    def request(self, forwarded=None, remote='10.0.0.9'):
        extra = {'REMOTE_ADDR': remote}
        if forwarded is not None:
            extra['HTTP_X_FORWARDED_FOR'] = forwarded
        return RequestFactory().get('/', **extra)

    @override_settings(NUM_PROXIES=0)
    def test_forwarded_header_is_ignored_without_trusted_proxy(self):
        self.assertEqual(client_ip(self.request('1.2.3.4')), '10.0.0.9')

    @override_settings(NUM_PROXIES=1)
    def test_client_controlled_left_side_cannot_forge_the_address(self):
        self.assertEqual(client_ip(self.request('6.6.6.6, 203.0.113.7')), '203.0.113.7')

    @override_settings(NUM_PROXIES=2)
    def test_two_proxies_take_the_second_entry_from_the_right(self):
        self.assertEqual(client_ip(self.request('6.6.6.6, 203.0.113.7, 10.1.1.1')), '203.0.113.7')

    @override_settings(NUM_PROXIES=1)
    def test_invalid_value_is_dropped_and_falls_back_to_the_socket_address(self):
        self.assertEqual(client_ip(self.request('not-an-ip')), '10.0.0.9')
        self.assertEqual(client_ip(self.request('1.2.3.4:80')), '10.0.0.9')

    @override_settings(NUM_PROXIES=1)
    def test_ipv6_is_normalised(self):
        self.assertEqual(client_ip(self.request('2001:DB8::1')), '2001:db8::1')


class CsvFormulaTests(WakaraTestCase):
    def test_cells_that_look_like_formulas_are_neutralised(self):
        for bad in ('=1+1', '+SUM(1)', '-2+3', '@A1', '\tcmd', '\rcmd'):
            self.assertEqual(safe_cell(bad), "'" + bad)
        self.assertEqual(safe_cell('Aminata'), 'Aminata')
        self.assertEqual(safe_cell(42), 42)

    def test_audit_export_neutralises_an_anonymous_login_identifier(self):
        APIClient().post('/api/auth/login/', {'username': '=HYPERLINK("http://x","x")', 'password': 'x'},
                         format='json')
        r = self.client_for(self.admin).get('/api/audit/export/')
        self.assertEqual(r.status_code, 200)
        rows = list(csv.reader(io.StringIO(r.content.decode('utf-8-sig')), delimiter=';'))
        usernames = [row[1] for row in rows[1:]]
        self.assertIn("'=HYPERLINK(\"http://x\",\"x\")", usernames)
        self.assertFalse([u for u in usernames if u.startswith('=')])

    def test_declaration_export_neutralises_child_names(self):
        self.create_declaration(child={'first_names': '=1+1', 'last_name': 'Diallo', 'gender': 'F'})
        r = self.client_for(self.admin).get('/api/declarations/export/')
        self.assertEqual(r.status_code, 200)
        rows = list(csv.reader(io.StringIO(r.content.decode('utf-8-sig')), delimiter=';'))
        children = [row[3] for row in rows[1:]]
        self.assertTrue(all(not c.startswith('=') for c in children))
        self.assertTrue(any(c.startswith("'=1+1") for c in children))


class AuditAddressTests(WakaraTestCase):
    @override_settings(NUM_PROXIES=0)
    def test_garbage_forwarded_header_does_not_break_or_forge_the_audit_row(self):
        c = self.client_for(self.admin)
        r = c.post('/api/hospitals/', {'name': 'Clinique Test', 'facility_type': 'CLINIC'}, format='json',
                   HTTP_X_FORWARDED_FOR='not-an-ip')
        self.assertEqual(r.status_code, 201, r.content)
        entry = AuditLog.objects.filter(action='create', object_type='Hospital').latest('id')
        self.assertEqual(entry.ip_address, '127.0.0.1')


class TokenRevocationTests(WakaraTestCase):
    def login(self, username, password=PASSWORD):
        return APIClient().post('/api/auth/login/', {'username': username, 'password': password}, format='json')

    def refresh(self, token):
        return APIClient().post('/api/auth/refresh/', {'refresh': token}, format='json')

    def test_password_change_revokes_old_refresh_tokens_and_returns_a_fresh_pair(self):
        old = self.login('agent').data
        c = APIClient()
        c.credentials(HTTP_AUTHORIZATION=f"Bearer {old['access']}")
        r = c.post('/api/auth/change-password/',
                   {'old_password': PASSWORD, 'new_password': 'An0ther-Str0ng-One!'}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.refresh(old['refresh']).status_code, 401)  # stolen/old token is dead
        self.assertEqual(self.refresh(r.data['refresh']).status_code, 200)  # the current session survives

    def test_admin_password_reset_revokes_the_victims_refresh_tokens(self):
        victim = self.login('agent2').data
        r = self.client_for(self.admin).post(f'/api/users/{self.agent2.uuid}/reset-password/')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.refresh(victim['refresh']).status_code, 401)

    def test_deactivation_revokes_refresh_tokens(self):
        victim = self.login('agent2').data
        r = self.client_for(self.admin).post(f'/api/users/{self.agent2.uuid}/deactivate/')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.refresh(victim['refresh']).status_code, 401)


class LockoutCounterTests(WakaraTestCase):
    @override_settings(LOGIN_MAX_FAILED_ATTEMPTS=3, LOGIN_LOCKOUT_MINUTES=15)
    def test_counter_increments_once_per_failure_and_resets_on_lock(self):
        c = APIClient()
        for expected in (1, 2):
            c.post('/api/auth/login/', {'username': 'agent', 'password': 'bad'}, format='json')
            self.assertEqual(CustomUser.objects.get(username='agent').failed_login_count, expected)
        c.post('/api/auth/login/', {'username': 'agent', 'password': 'bad'}, format='json')
        u = CustomUser.objects.get(username='agent')
        self.assertEqual(u.failed_login_count, 0)
        self.assertTrue(u.is_locked)
