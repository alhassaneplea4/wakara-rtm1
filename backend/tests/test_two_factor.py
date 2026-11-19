"""Second factor (TOTP application): set-up, sign-in, one-time codes, backup codes, requirement per role, resets."""
from io import StringIO
from unittest import mock

from django.conf import settings
from django.core.management import call_command
from django.core.management.base import CommandError
from rest_framework.test import APIClient

from accounts import two_factor
from accounts.models import CustomUser, TwoFactorBackupCode
from audit.models import AuditAction, AuditLog
from core.models import SiteSetting

from .base import PASSWORD, WakaraTestCase, make_user

T0 = 1_800_000_000          # a fixed instant: the codes of the application are then predictable


def at(t):
    return mock.patch('accounts.two_factor._now', return_value=t)


class TwoFactorCase(WakaraTestCase):
    def api(self, user=None):
        c = APIClient()
        if user:
            c.force_authenticate(user)
        return c

    def login(self, username='secretary', code=None, password=PASSWORD):
        body = {'username': username, 'password': password}
        if code is not None:
            body['code'] = code
        return APIClient().post('/api/auth/login/', body, format='json')

    def enable(self, user, t=T0):
        """Sets the second factor up like the user would; returns (secret, backup codes)."""
        c = self.api(user)
        r = c.post('/api/auth/two-factor/setup/', {'password': PASSWORD}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        secret = r.data['secret'].replace(' ', '')
        with at(t):
            r = c.post('/api/auth/two-factor/enable/', {'code': two_factor.code_at(secret, t)}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        return secret, r.data['backup_codes']


class CodeTests(TwoFactorCase):
    def test_the_rfc_6238_reference_values(self):
        # RFC 6238 appendix B (SHA-1, secret "12345678901234567890"), last six digits of the published 8-digit codes
        import base64
        secret = base64.b32encode(b'12345678901234567890').decode().rstrip('=')
        for t, expected in ((59, '287082'), (1111111109, '081804'), (1234567890, '005924'), (2000000000, '279037')):
            self.assertEqual(two_factor.code_at(secret, t), expected, t)

    def test_the_secret_is_kept_encrypted(self):
        make_user('someone', 'secretary')
        user = CustomUser.objects.get(username='someone')
        secret = two_factor.begin_setup(user)
        stored = CustomUser.objects.get(pk=user.pk).totp_secret
        self.assertNotIn(secret, stored)
        self.assertEqual(two_factor.pending_secret(CustomUser.objects.get(pk=user.pk)), secret)

    def test_a_code_works_once(self):
        user = make_user('once', 'secretary')
        secret = two_factor.begin_setup(user)
        code = two_factor.code_at(secret, T0)
        with at(T0):
            self.assertTrue(two_factor.verify_totp(user, code))
            self.assertFalse(two_factor.verify_totp(user, code))                       # replay
            fresh = CustomUser.objects.get(pk=user.pk)
            self.assertFalse(two_factor.verify_totp(fresh, code))                      # replay from another request

    def test_a_clock_a_few_seconds_off_still_works_but_not_minutes(self):
        user = make_user('drift', 'secretary')
        secret = two_factor.begin_setup(user)
        with at(T0):
            self.assertTrue(two_factor.verify_totp(user, two_factor.code_at(secret, T0 + 30)))      # one step ahead
        with at(T0 + 120):
            self.assertFalse(two_factor.verify_totp(user, two_factor.code_at(secret, T0 + 30 - 30)))  # four steps behind

    def test_codes_with_spaces_and_a_wrong_length_are_handled(self):
        user = make_user('fmt', 'secretary')
        secret = two_factor.begin_setup(user)
        code = two_factor.code_at(secret, T0)
        with at(T0):
            self.assertFalse(two_factor.verify_totp(user, '12345'))
            self.assertFalse(two_factor.verify_totp(user, ''))
            self.assertTrue(two_factor.verify_totp(user, f'{code[:3]} {code[3:]}'))


class SetUpTests(TwoFactorCase):
    def test_setting_up_needs_the_password(self):
        r = self.api(self.secretary).post('/api/auth/two-factor/setup/', {'password': 'nope'}, format='json')
        self.assertEqual(r.status_code, 403)
        self.assertFalse(CustomUser.objects.get(pk=self.secretary.pk).totp_secret)

    def test_it_only_turns_on_with_a_code_from_the_application(self):
        c = self.api(self.secretary)
        c.post('/api/auth/two-factor/setup/', {'password': PASSWORD}, format='json')
        r = c.post('/api/auth/two-factor/enable/', {'code': '000000'}, format='json')
        self.assertEqual(r.status_code, 400)
        self.assertFalse(CustomUser.objects.get(pk=self.secretary.pk).two_factor_enabled)
        self.assertTrue(AuditLog.objects.filter(action=AuditAction.TWO_FACTOR_FAILED, username='secretary').exists())

    def test_enabling_gives_eight_backup_codes_once_and_is_audited(self):
        secret, codes = self.enable(self.secretary)
        self.assertEqual(len(codes), 8)
        self.assertEqual(len(set(codes)), 8)
        self.assertTrue(CustomUser.objects.get(pk=self.secretary.pk).two_factor_enabled)
        self.assertEqual(TwoFactorBackupCode.objects.filter(user=self.secretary).count(), 8)
        stored = ''.join(TwoFactorBackupCode.objects.values_list('code_hash', flat=True))
        for code in codes:
            self.assertNotIn(code.replace('-', ''), stored)                          # only hashes are kept
        self.assertTrue(AuditLog.objects.filter(action=AuditAction.TWO_FACTOR_ENABLED, username='secretary').exists())
        status = self.api(self.secretary).get('/api/auth/two-factor/').data
        self.assertEqual((status['enabled'], status['backup_codes_left']), (True, 8))

    def test_setting_up_again_is_refused_once_enabled(self):
        self.enable(self.secretary)
        r = self.api(self.secretary).post('/api/auth/two-factor/setup/', {'password': PASSWORD}, format='json')
        self.assertEqual(r.status_code, 400)

    def test_the_profile_tells_whether_it_is_on(self):
        self.assertFalse(self.api(self.secretary).get('/api/auth/me/').data['two_factor_enabled'])
        self.enable(self.secretary)
        self.assertTrue(self.api(self.secretary).get('/api/auth/me/').data['two_factor_enabled'])


class SignInTests(TwoFactorCase):
    def test_without_the_second_factor_nothing_changes(self):
        r = self.login()
        self.assertEqual(r.status_code, 200)
        self.assertNotIn('two_factor_required', str(r.data))

    def test_the_code_is_asked_after_the_right_password(self):
        secret, _ = self.enable(self.secretary)
        r = self.login()
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.data['code'], 'two_factor_required')
        self.assertNotIn('access', r.data)
        self.assertEqual(CustomUser.objects.get(pk=self.secretary.pk).failed_login_count, 0)    # not a failure

    def test_a_wrong_password_never_reaches_the_second_factor(self):
        self.enable(self.secretary)
        r = self.login(password='wrong-password')
        self.assertEqual(r.status_code, 401)
        self.assertNotEqual(r.data.get('code'), 'two_factor_required')

    def test_the_right_code_signs_in(self):
        secret, _ = self.enable(self.secretary)
        with at(T0 + 60):
            r = self.login(code=two_factor.code_at(secret, T0 + 60))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn('access', r.data)

    def test_a_code_cannot_be_used_twice(self):
        secret, _ = self.enable(self.secretary)
        with at(T0 + 60):
            code = two_factor.code_at(secret, T0 + 60)
            self.assertEqual(self.login(code=code).status_code, 200)
            again = self.login(code=code)
        self.assertEqual(again.status_code, 401)
        self.assertEqual(again.data['code'], 'two_factor_invalid')

    def test_wrong_codes_count_towards_the_lockout(self):
        self.enable(self.secretary)
        for _ in range(settings.LOGIN_MAX_FAILED_ATTEMPTS):
            r = self.login(code='000000')
            self.assertEqual(r.status_code, 401)
        self.assertEqual(self.login(code='000000').status_code, 403)               # locked
        self.assertTrue(AuditLog.objects.filter(action=AuditAction.TWO_FACTOR_FAILED, username='secretary').exists())

    def test_a_backup_code_works_once(self):
        _, codes = self.enable(self.secretary)
        self.assertEqual(self.login(code=codes[0]).status_code, 200)
        r = self.login(code=codes[0])
        self.assertEqual(r.status_code, 401)
        self.assertEqual(self.login(code=codes[1].lower()).status_code, 200)       # case does not matter
        self.assertEqual(self.api(self.secretary).get('/api/auth/two-factor/').data['backup_codes_left'], 6)

    def test_a_garbage_code_is_refused(self):
        self.enable(self.secretary)
        for code in ('abc', '1', 'ZZZZZ-ZZZZZ', '   '):
            self.assertIn(self.login(code=code).status_code, (401, 403), code)


class ManagementTests(TwoFactorCase):
    def test_new_backup_codes_replace_the_old_ones(self):
        secret, old = self.enable(self.secretary)
        c = self.api(self.secretary)
        with at(T0 + 60):
            r = c.post('/api/auth/two-factor/backup-codes/', {'password': PASSWORD, 'code': two_factor.code_at(secret, T0 + 60)}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(r.data['backup_codes']), 8)
        self.assertEqual(self.login(code=old[0]).status_code, 401)
        self.assertEqual(self.login(code=r.data['backup_codes'][0]).status_code, 200)

    def test_changing_it_needs_the_password_and_a_code(self):
        secret, _ = self.enable(self.secretary)
        c = self.api(self.secretary)
        self.assertEqual(c.post('/api/auth/two-factor/disable/', {'password': 'x', 'code': '1'}, format='json').status_code, 403)
        self.assertEqual(c.post('/api/auth/two-factor/disable/', {'password': PASSWORD, 'code': '000000'}, format='json').status_code, 400)
        self.assertTrue(CustomUser.objects.get(pk=self.secretary.pk).two_factor_enabled)

    def test_the_user_can_switch_it_off_when_it_is_not_required(self):
        secret, _ = self.enable(self.secretary)
        with at(T0 + 60):
            r = self.api(self.secretary).post('/api/auth/two-factor/disable/', {'password': PASSWORD, 'code': two_factor.code_at(secret, T0 + 60)}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        user = CustomUser.objects.get(pk=self.secretary.pk)
        self.assertFalse(user.two_factor_enabled)
        self.assertEqual((user.totp_secret, TwoFactorBackupCode.objects.filter(user=user).count()), ('', 0))
        self.assertEqual(self.login().status_code, 200)
        self.assertTrue(AuditLog.objects.filter(action=AuditAction.TWO_FACTOR_DISABLED).exists())

    def reset(self, by, target, reason='Téléphone perdu, identité vérifiée.'):
        return self.api(by).post(f'/api/users/{target.uuid}/reset-two-factor/', {'reason': reason}, format='json')

    def test_an_administrator_resets_the_factor_of_a_lost_phone(self):
        _, codes = self.enable(self.secretary)
        self.assertEqual(self.login(code=codes[0]).status_code, 200)               # a session is open
        r = self.reset(self.admin, self.secretary)
        self.assertEqual(r.status_code, 200, r.content)
        user = CustomUser.objects.get(pk=self.secretary.pk)
        self.assertFalse(user.two_factor_enabled)
        self.assertGreater(user.session_version, 0)                                   # the sessions end
        event = AuditLog.objects.get(action=AuditAction.TWO_FACTOR_RESET)
        self.assertEqual((event.username, event.reason), ('admin', 'Téléphone perdu, identité vérifiée.'))
        self.assertEqual(self.login().status_code, 200)                               # signs in with the password alone, then sets it up again

    def test_nobody_resets_his_own_factor(self):
        self.enable(self.admin)
        r = self.reset(self.admin, self.admin)
        self.assertEqual(r.status_code, 403)
        self.assertTrue(CustomUser.objects.get(pk=self.admin.pk).two_factor_enabled)

    def test_a_reason_and_the_right_are_required(self):
        self.enable(self.secretary)
        self.assertEqual(self.reset(self.admin, self.secretary, reason='court').status_code, 400)
        self.assertEqual(self.reset(self.secretary, self.agent).status_code, 403)
        self.assertEqual(self.reset(self.agent, self.secretary).status_code, 403)
        self.assertTrue(CustomUser.objects.get(pk=self.secretary.pk).two_factor_enabled)

    def test_the_command_resets_a_single_administrator(self):
        self.enable(self.admin)
        out = StringIO()
        call_command('reset_two_factor', 'admin', reason='Seul administrateur, téléphone perdu', stdout=out)
        self.assertFalse(CustomUser.objects.get(pk=self.admin.pk).two_factor_enabled)
        self.assertIn('réinitialisée', out.getvalue())
        with self.assertRaises(CommandError):
            call_command('reset_two_factor', 'admin', reason='court')
        with self.assertRaises(CommandError):
            call_command('reset_two_factor', 'ghost', reason='Un motif assez long')


class RequirementTests(TwoFactorCase):
    def require(self, value):
        SiteSetting.objects.update_or_create(key='security.two_factor_roles', defaults={'value': value})

    def test_nothing_is_required_by_default(self):
        self.assertFalse(self.api(self.secretary).get('/api/auth/me/').data['must_set_up_two_factor'])
        self.assertEqual(self.api(self.secretary).get('/api/declarations/').status_code, 200)

    def test_a_required_role_can_only_reach_its_profile_until_it_has_set_it_up(self):
        self.require('secretary')
        c = self.api(self.secretary)
        self.assertTrue(c.get('/api/auth/me/').data['must_set_up_two_factor'])
        self.assertEqual(c.get('/api/declarations/').status_code, 403)
        self.assertEqual(c.get('/api/auth/two-factor/').status_code, 200)             # the way to set it up stays open
        self.assertEqual(self.api(self.agent).get('/api/declarations/').status_code, 200)   # other roles are not concerned
        self.enable(self.secretary)
        self.assertEqual(self.api(self.secretary).get('/api/declarations/').status_code, 200)

    def test_all_and_several_roles(self):
        self.require('admin, secretary')
        self.assertTrue(self.api(self.admin).get('/api/auth/me/').data['must_set_up_two_factor'])
        self.assertFalse(self.api(self.agent).get('/api/auth/me/').data['must_set_up_two_factor'])
        self.require('all')
        self.assertTrue(self.api(self.agent).get('/api/auth/me/').data['must_set_up_two_factor'])

    def test_a_required_role_cannot_switch_it_off(self):
        secret, _ = self.enable(self.secretary)
        self.require('secretary')
        with at(T0 + 60):
            r = self.api(self.secretary).post('/api/auth/two-factor/disable/', {'password': PASSWORD, 'code': two_factor.code_at(secret, T0 + 60)}, format='json')
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.data['code'], 'two_factor_required')
        self.assertTrue(CustomUser.objects.get(pk=self.secretary.pk).two_factor_enabled)

    def test_the_offline_synchronisation_does_not_wipe_a_device_for_it(self):
        self.require('collection_agent')
        r = self.api(self.agent).get('/api/sync/reference/')
        self.assertEqual(r.status_code, 403)
        self.assertNotEqual(r.data.get('code'), 'access_lost')                         # no « access_lost »: the copies stay on the device
