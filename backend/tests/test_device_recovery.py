"""Recovery code of an offline device: registration by the device, reading by the administrator (fictional data only)."""
from django.test import SimpleTestCase, override_settings

from audit.models import AuditAction, AuditLog
from sync import recovery
from sync.models import Device

from .base import PASSWORD
from .test_offline_sync import DEVICE, SyncTestCase

CODE = 'ABCD-EFGH-JKMN-PQRS-TVWX-0123'
OTHER = 'ZYXW-VTSR-QPNM-KJHG-FEDC-9876'
REASON = "L'agent a oublié son code, identité vérifiée par téléphone."


class CodeFormatTests(SimpleTestCase):
    def test_the_code_is_normalised(self):
        self.assertEqual(recovery.normalize('abcd efgh jkmn pqrs tvwx 0123'), CODE)
        self.assertEqual(recovery.normalize('ABCDEFGHJKMNPQRSTVWX0123'), CODE)

    def test_look_alike_letters_read_as_digits(self):
        self.assertEqual(recovery.normalize('ABCD-EFGH-JKMN-PQRS-TVWX-OIL3'), 'ABCD-EFGH-JKMN-PQRS-TVWX-0113')

    def test_wrong_codes_are_refused(self):
        for bad in ('', 'ABCD', CODE + 'X', 'ABCD-EFGH-JKMN-PQRS-TVWX-012U', 'U' * 24):
            self.assertEqual(recovery.normalize(bad), '', bad)

    def test_the_stored_form_does_not_show_the_code(self):
        blob = recovery.encrypt(CODE)
        self.assertNotIn('ABCD', blob)
        self.assertEqual(recovery.decrypt(blob), CODE)

    def test_a_blob_made_under_another_key_is_unreadable(self):
        blob = recovery.encrypt(CODE)
        with override_settings(FIELD_ENCRYPTION_KEY='another-key'):
            self.assertIsNone(recovery.decrypt(blob))
        self.assertIsNone(recovery.decrypt(''))


class RecoveryCase(SyncTestCase):
    def register(self, user=None, code=CODE, device=DEVICE):
        return self.client_for(user or self.agent, device=device).post(
            '/api/sync/recovery/', {'device_id': device, 'device_label': 'Téléphone de test', 'code': code}, format='json')

    def device(self):
        return Device.objects.get(device_id=DEVICE, user=self.agent)

    def reveal(self, user=None, password=PASSWORD, reason=REASON):
        self.register()
        return self.client_for(user or self.admin).post(
            f'/api/sync/devices/{self.device().pk}/recovery/', {'password': password, 'reason': reason}, format='json')


class RegistrationTests(RecoveryCase):
    def test_a_device_registers_its_code_encrypted(self):
        r = self.register()
        self.assertEqual(r.status_code, 200, r.content)
        device = self.device()
        self.assertNotIn('ABCD', device.recovery_blob)
        self.assertEqual(recovery.decrypt(device.recovery_blob), CODE)
        self.assertIsNotNone(device.recovery_set_at)

    def test_the_audit_log_never_holds_the_code(self):
        self.register()
        event = AuditLog.objects.get(action=AuditAction.DEVICE_RECOVERY_REGISTERED)
        self.assertEqual(event.username, 'agent')
        dump = f'{event.changes}{event.reason}{event.object_repr}{event.object_id}'
        self.assertNotIn('ABCD', dump)
        self.assertNotIn(CODE.replace('-', ''), dump)

    def test_a_malformed_code_is_refused(self):
        r = self.register(code='1234')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.data['code'], 'invalid_recovery_code')
        self.assertEqual(self.device().recovery_blob, '')

    def test_a_session_not_bound_to_the_device_is_refused(self):
        r = self.client_for(self.agent, device=None).post(
            '/api/sync/recovery/', {'device_id': DEVICE, 'code': CODE}, format='json')
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.data['code'], 'device_binding_required')

    def test_a_session_bound_to_another_device_is_refused(self):
        r = self.client_for(self.agent, device='11111111-1111-4111-8111-111111111111').post(
            '/api/sync/recovery/', {'device_id': DEVICE, 'code': CODE}, format='json')
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.data['code'], 'device_mismatch')

    def test_a_new_code_replaces_the_old_one_and_clears_the_reading_mark(self):
        self.reveal()
        self.assertIsNotNone(self.device().recovery_revealed_at)
        self.register(code=OTHER)
        device = self.device()
        self.assertEqual(recovery.decrypt(device.recovery_blob), OTHER)
        self.assertIsNone(device.recovery_revealed_at)

    def test_every_role_that_works_offline_may_register(self):
        r = self.register(user=self.secretary, device='22222222-2222-4222-8222-222222222222')
        self.assertEqual(r.status_code, 200, r.content)

    def test_somebody_without_rights_cannot_register(self):
        self.assertEqual(self.register(user=self.nobody).status_code, 403)


class RevealTests(RecoveryCase):
    def test_the_administrator_reads_the_code_with_his_password_and_a_reason(self):
        r = self.reveal()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.data['code'], CODE)
        device = self.device()
        self.assertEqual(device.recovery_revealed_by, self.admin)
        self.assertIsNotNone(device.recovery_revealed_at)

    def test_the_reading_is_audited_with_its_reason_and_without_the_code(self):
        self.reveal()
        event = AuditLog.objects.get(action=AuditAction.DEVICE_RECOVERY_REVEALED)
        self.assertEqual(event.username, 'admin')
        self.assertEqual(event.reason, REASON)
        self.assertNotIn('ABCD', f'{event.changes}{event.object_repr}{event.reason}')

    def test_a_wrong_password_gives_nothing_and_is_audited(self):
        r = self.reveal(password='not-the-password')
        self.assertEqual(r.status_code, 403)
        self.assertNotIn('code', {k for k in r.data if k == 'code' and r.data[k] == CODE})
        self.assertNotIn('ABCD', str(r.data))
        self.assertTrue(AuditLog.objects.filter(action=AuditAction.DEVICE_RECOVERY_DENIED, username='admin').exists())
        self.assertFalse(AuditLog.objects.filter(action=AuditAction.DEVICE_RECOVERY_REVEALED).exists())

    def test_a_missing_or_short_reason_is_refused(self):
        for reason in ('', 'court', None):
            r = self.reveal(reason=reason)
            self.assertEqual(r.status_code, 400, reason)
            self.assertEqual(r.data['code'], 'reason_required')
        self.assertFalse(AuditLog.objects.filter(action=AuditAction.DEVICE_RECOVERY_REVEALED).exists())

    def test_only_the_right_to_recover_opens_the_code(self):
        for user in (self.secretary, self.agent, self.nobody):
            self.assertEqual(self.reveal(user=user).status_code, 403, user.username)
        self.assertFalse(AuditLog.objects.filter(action=AuditAction.DEVICE_RECOVERY_REVEALED).exists())

    def test_a_device_without_code_says_so(self):
        # the device exists (it synchronised) but never registered a code
        self.client_for(self.agent).get('/api/sync/reference/')
        self.client_for(self.agent).post('/api/sync/push/', {
            'device': {'id': DEVICE, 'label': 'x'}, 'user': str(self.agent.uuid),
            'sent_at': '2026-11-18T10:00:00Z', 'operations': []}, format='json')
        r = self.client_for(self.admin).post(
            f'/api/sync/devices/{self.device().pk}/recovery/', {'password': PASSWORD, 'reason': REASON}, format='json')
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.data['code'], 'no_recovery')

    def test_a_code_that_can_no_longer_be_read_says_so(self):
        self.register()
        with override_settings(FIELD_ENCRYPTION_KEY='rotated'):
            r = self.client_for(self.admin).post(
                f'/api/sync/devices/{self.device().pk}/recovery/', {'password': PASSWORD, 'reason': REASON}, format='json')
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.data['code'], 'recovery_unreadable')


class ListingTests(RecoveryCase):
    def test_the_device_list_tells_whether_a_code_exists_but_never_shows_it(self):
        self.register()
        r = self.client_for(self.admin).get('/api/sync/devices/')
        self.assertEqual(r.status_code, 200)
        row = r.data['results'][0]
        self.assertTrue(row['has_recovery'])
        self.assertNotIn('ABCD', r.content.decode())
        self.assertNotIn('recovery_blob', row)

    def test_the_list_shows_who_read_the_code_and_when(self):
        self.reveal()
        row = self.client_for(self.admin).get('/api/sync/devices/').data['results'][0]
        self.assertTrue(row['recovery_revealed_at'])
        self.assertEqual(row['recovery_revealed_by_name'], 'Admin Test')


class RegisteredFlagTests(RecoveryCase):
    def flag(self):
        return self.client_for(self.agent).get('/api/sync/reference/').data['recovery_registered']

    def test_the_device_learns_whether_the_server_holds_a_readable_code(self):
        self.assertFalse(self.flag())
        self.register()
        self.assertTrue(self.flag())

    def test_a_code_made_unreadable_is_reported_as_missing(self):
        self.register()
        with override_settings(FIELD_ENCRYPTION_KEY='rotated'):
            self.assertFalse(self.flag())

    def test_the_pull_carries_the_flag_too(self):
        self.register()
        self.assertTrue(self.client_for(self.agent).get('/api/sync/pull/').data['recovery_registered'])
