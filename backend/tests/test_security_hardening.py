"""Security hardening of the offline mode and the duplicate control (fictional data only)."""
import datetime
import uuid

from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken

from sync.models import Device

from .base import PASSWORD
from .test_offline_sync import DEVICE, SyncTestCase, iso

OTHER_DEVICE = '0d3f6c52-9a43-4b2a-8f46-7d1c6f0a9e11'


class RealSessionCase(SyncTestCase):
    """Sessions obtained by the real sign-in (signed tokens), not forced."""

    def login(self, username='agent', device=DEVICE, password=PASSWORD):
        body = {'username': username, 'password': password}
        if device:
            body['device_id'] = device
        return APIClient().post('/api/auth/login/', body, format='json')

    def bearer(self, access):
        c = APIClient()
        c.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')
        return c

    def push_with(self, client, operations, device=DEVICE, user=None):
        body = {'device': {'id': device, 'label': 'Téléphone'}, 'user': str((user or self.agent).uuid),
                'sent_at': iso(timezone.now()), 'operations': operations}
        return client.post('/api/sync/push/', body, format='json')


class DeviceBindingTests(RealSessionCase):
    def test_the_session_is_bound_to_the_device_given_at_sign_in(self):
        r = self.login()
        self.assertEqual(r.status_code, 200)
        r = self.push_with(self.bearer(r.data['access']), [self.create_op()])
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_session_without_device_cannot_synchronise(self):
        access = self.login(device=None).data['access']
        r = self.push_with(self.bearer(access), [self.create_op()])
        self.assertEqual((r.status_code, r.data['code']), (403, 'device_binding_required'))
        self.assertEqual(self.bearer(access).get('/api/sync/pull/').data['code'], 'device_binding_required')
        # ... but it still works for the online application
        self.assertEqual(self.bearer(access).get('/api/auth/me/').status_code, 200)

    def test_a_session_cannot_synchronise_under_another_device_identifier(self):
        access = self.login(device=DEVICE).data['access']
        r = self.push_with(self.bearer(access), [self.create_op()], device=OTHER_DEVICE)
        self.assertEqual((r.status_code, r.data['code']), (403, 'device_mismatch'))
        self.assertFalse(Device.objects.filter(device_id=OTHER_DEVICE).exists())

    def test_the_documents_endpoint_is_bound_too(self):
        access = self.login(device=DEVICE).data['access']
        body, r = None, None
        decl = self.create_declaration(self.agent)
        from django.core.files.uploadedfile import SimpleUploadedFile
        import hashlib
        content = b'\xff\xd8\xff\xe0' + b'photo' * 30
        form = {'op_id': str(uuid.uuid4()), 'device_id': OTHER_DEVICE, 'user': str(self.agent.uuid),
                'sent_at': iso(timezone.now()), 'device_time': iso(timezone.now()), 'uuid': str(uuid.uuid4()),
                'declaration': decl['uuid'], 'kind': 'PAPER_FORM', 'sha256': hashlib.sha256(content).hexdigest(),
                'file': SimpleUploadedFile('f.jpg', content)}
        r = self.bearer(access).post('/api/sync/documents/', form, format='multipart')
        self.assertEqual((r.status_code, r.data['code']), (403, 'device_mismatch'))

    def test_the_device_binding_survives_a_refresh_and_a_password_change(self):
        r = self.login()
        refreshed = APIClient().post('/api/auth/refresh/', {'refresh': r.data['refresh']}, format='json')
        self.assertEqual(refreshed.status_code, 200)
        r2 = self.push_with(self.bearer(refreshed.data['access']), [self.create_op()])
        self.assertEqual(r2.status_code, 200, r2.content)
        changed = self.bearer(refreshed.data['access']).post(
            '/api/auth/change-password/', {'old_password': PASSWORD, 'new_password': 'N0uveau-Passw0rd!z',
                                           'confirm_password': 'N0uveau-Passw0rd!z'}, format='json')
        self.assertEqual(changed.status_code, 200, changed.content)
        r3 = self.push_with(self.bearer(changed.data['access']), [self.create_op()])
        self.assertEqual(r3.status_code, 200, r3.content)
        r4 = self.push_with(self.bearer(changed.data['access']), [self.create_op()], device=OTHER_DEVICE)
        self.assertEqual(r4.data['code'], 'device_mismatch')


class DeviceRevocationTests(RealSessionCase):
    def setUp(self):
        super().setUp()
        self.session = self.login().data
        self.assertEqual(self.push_with(self.bearer(self.session['access']), [self.create_op()]).status_code, 200)
        self.device = Device.objects.get(device_id=DEVICE, user=self.agent)

    def revoke(self):
        r = self.client_for(self.admin).post(f'/api/sync/devices/{self.device.pk}/revoke/')
        self.assertEqual(r.status_code, 200, r.content)

    def test_revoking_cuts_the_sessions_of_the_device_at_once(self):
        self.revoke()
        r = self.bearer(self.session['access']).get('/api/auth/me/')
        self.assertEqual(r.status_code, 401)
        self.assertEqual(self.push_with(self.bearer(self.session['access']), [self.create_op()]).status_code, 401)
        refreshed = APIClient().post('/api/auth/refresh/', {'refresh': self.session['refresh']}, format='json')
        self.assertEqual(refreshed.status_code, 401)

    def test_a_revoked_device_cannot_come_back_with_a_new_identifier(self):
        """The stolen tokens stay bound to the revoked identifier: no other identifier can be used with them."""
        self.revoke()
        access = self.session['access']
        for device in (DEVICE, OTHER_DEVICE, str(uuid.uuid4())):
            r = self.push_with(self.bearer(access), [self.create_op()], device=device)
            self.assertEqual(r.status_code, 401, device)
        self.assertEqual(Device.objects.filter(user=self.agent).count(), 1)

    def test_the_refresh_token_is_blacklisted(self):
        self.revoke()
        self.assertTrue(BlacklistedToken.objects.filter(token__user=self.agent).exists())

    def test_signing_in_on_a_revoked_device_is_refused(self):
        self.revoke()
        r = self.login()
        self.assertEqual((r.status_code, r.data['code']), (403, 'device_revoked'))

    def test_the_other_devices_of_the_user_are_not_cut(self):
        other = self.login(device=OTHER_DEVICE).data
        self.assertEqual(self.push_with(self.bearer(other['access']), [self.create_op()], device=OTHER_DEVICE).status_code, 200)
        self.revoke()
        self.assertEqual(self.push_with(self.bearer(other['access']), [self.create_op()], device=OTHER_DEVICE).status_code, 200)
        self.assertEqual(APIClient().post('/api/auth/refresh/', {'refresh': other['refresh']}, format='json').status_code, 200)

    def test_old_unbound_sessions_are_closed_too(self):
        """A session opened before the binding existed could be on the stolen device: it is closed."""
        legacy = self.login(device=None).data
        self.revoke()
        self.assertEqual(APIClient().post('/api/auth/refresh/', {'refresh': legacy['refresh']}, format='json').status_code, 401)

    def test_restoring_the_device_lets_the_agent_sign_in_again(self):
        self.revoke()
        self.client_for(self.admin).post(f'/api/sync/devices/{self.device.pk}/restore/')
        r = self.login()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.push_with(self.bearer(r.data['access']), [self.create_op()]).status_code, 200)

    def test_by_default_an_account_may_use_three_devices_at_most(self):
        from django.conf import settings
        self.assertEqual(settings.SYNC_MAX_DEVICES_PER_USER, 3)
        ids = [DEVICE, OTHER_DEVICE, str(uuid.uuid4())]
        for device_id in ids:                              # three devices are accepted
            session = self.login(device=device_id).data
            self.assertEqual(self.push_with(self.bearer(session['access']), [self.create_op()], device=device_id).status_code, 200)
        fourth_id = str(uuid.uuid4())
        fourth = self.login(device=fourth_id).data
        r = self.push_with(self.bearer(fourth['access']), [self.create_op()], device=fourth_id)
        self.assertEqual((r.status_code, r.data['code']), (403, 'device_limit'))
        self.assertIn('maximum', r.data['detail'])
        # the three others keep working
        again = self.login(device=ids[0]).data
        self.assertEqual(self.push_with(self.bearer(again['access']), [self.create_op()], device=ids[0]).status_code, 200)

    def test_the_number_of_devices_of_a_user_is_limited(self):
        from django.test import override_settings
        with override_settings(SYNC_MAX_DEVICES_PER_USER=2):
            second = self.login(device=OTHER_DEVICE).data
            self.assertEqual(self.push_with(self.bearer(second['access']), [self.create_op()], device=OTHER_DEVICE).status_code, 200)
            third_id = str(uuid.uuid4())
            third = self.login(device=third_id).data
            r = self.push_with(self.bearer(third['access']), [self.create_op()], device=third_id)
            self.assertEqual((r.status_code, r.data['code']), (403, 'device_limit'))
            # a revoked device frees a place
            self.revoke()
            self.assertEqual(self.push_with(self.bearer(third['access']), [self.create_op()], device=third_id).status_code, 200)


# ── configuration of the duplicate control cannot switch it off ──

import json

from accounts.models import Permission, UserPermission
from audit.models import AuditLog
from core.models import SiteSetting
from duplicates.config import CONFIG_KEY, default_config, get_config
from duplicates.models import CaseStatus, DuplicateCase

from .base import make_user
from .test_duplicates import DuplicateBase

CFG = '/api/duplicates/config/'
REASON = 'Calibrage décidé en comité avec la mairie'


class ConfigGuardTests(DuplicateBase):
    def patch(self, user=None, reason=REASON, **changes):
        body = {**default_config(), **changes}
        if reason is not None:
            body['reason'] = reason
        return self.client_for(user or self.admin).patch(CFG, body, format='json')

    def test_the_right_to_calibrate_is_its_own_permission(self):
        self.assertEqual(self.patch(user=self.secretary).status_code, 403)
        manager = make_user('manager')
        UserPermission.objects.create(user=manager, permission=Permission.objects.get(codename='settings.manage'), granted=True)
        # general settings management does not give the right to touch the duplicate control
        self.assertEqual(self.patch(user=manager).status_code, 403)
        self.assertEqual(self.patch().status_code, 200)

    def test_the_generic_settings_endpoint_does_not_reach_the_configuration(self):
        r = self.client_for(self.admin).patch('/api/settings/', {CONFIG_KEY: '{"blocking_levels": []}'}, format='json')
        self.assertEqual(r.status_code, 400)

    def test_a_written_reason_is_required_and_kept_with_the_previous_values(self):
        self.assertEqual(self.patch(reason=None).status_code, 400)
        self.assertEqual(self.patch(reason='ok').status_code, 400)
        r = self.patch(thresholds={'high': 90, 'medium': 70})
        self.assertEqual(r.status_code, 200, r.content)
        row = AuditLog.objects.filter(object_id=CONFIG_KEY).latest('pk')
        self.assertEqual(row.reason, REASON)
        self.assertEqual(row.changes['from']['thresholds']['high'], 85)
        self.assertEqual(row.changes['to']['thresholds']['high'], 90)
        meta = self.client_for(self.secretary).get(CFG).data['meta']
        self.assertEqual((meta['customized'], meta['reason']), (True, f'Modifié : {REASON}'))

    def test_high_risk_can_never_stop_blocking(self):
        for levels in ([], ['MEDIUM'], ['LOW'], 'HIGH', None):
            self.assertEqual(self.patch(blocking_levels=levels).status_code, 400, levels)
        self.assertEqual(self.patch(blocking_levels=['HIGH']).status_code, 200)
        self.assertEqual(get_config()['blocking_levels'], ['HIGH'])

    def test_thresholds_cannot_be_pushed_out_of_reach(self):
        for th in ({'high': 100, 'medium': 99}, {'high': 99, 'medium': 60}, {'high': 60, 'medium': 50},
                   {'high': 90, 'medium': 20}, {'high': 90, 'medium': 90}, {'high': 90}, 'x'):
            self.assertEqual(self.patch(thresholds=th).status_code, 400, th)
        self.assertEqual(self.patch(thresholds={'high': 95, 'medium': 80}).status_code, 200)

    def test_the_identifying_criteria_keep_their_weight(self):
        w = dict(default_config()['weights'])
        w.update(mother=5, birth_time=35)
        self.assertEqual(self.patch(weights=w).status_code, 400)
        w = dict(default_config()['weights'])
        w.update(birth_date=10, birth_time=25)
        self.assertEqual(self.patch(weights=w).status_code, 400)

    def test_other_parameters_stay_in_range(self):
        for key, value in (('min_quality_for_high', 100), ('date_window_days', 0), ('date_window_days', 99),
                           ('min_recorded_score', 100)):
            self.assertEqual(self.patch(**{key: value}).status_code, 400, (key, value))

    def test_a_malformed_body_is_a_400_not_a_crash(self):
        r = self.client_for(self.admin).patch(CFG, [1, 2], format='json')
        self.assertEqual(r.status_code, 400)

    def test_a_value_written_straight_in_the_database_is_ignored(self):
        bad = {**default_config(), 'blocking_levels': [], 'thresholds': {'high': 100, 'medium': 99}}
        SiteSetting.objects.create(key=CONFIG_KEY, value=json.dumps(bad))
        self.assertEqual(get_config(), default_config())

    def test_a_high_risk_case_blocks_even_if_the_stored_levels_are_empty(self):
        """Belt and braces: the service forces HIGH whatever the configuration says."""
        from unittest import mock
        a, b = self.mk(self.agent), self.mk(self.agent2)
        case = self.case_for(a['uuid'], b['uuid'])
        self.assertEqual(case.risk_level, 'HIGH')
        weak = {**default_config(), 'blocking_levels': []}
        with mock.patch('duplicates.services.cases.get_config', return_value=weak):
            self.to_pending(a['uuid'])
            self.assertEqual(self.validate(self.admin, a['uuid'], '1301').status_code, 400)
        case.refresh_from_db()
        self.assertNotEqual(case.status, CaseStatus.RESOLVED)


# ── dates coming from a device are never taken at face value ──

from django.test import SimpleTestCase

from audit.models import AuditAction
from declarations.models import Declaration, StatusHistory
from sync.models import SyncOperation
from sync.services import resolve_device_time

HOURS = lambda n: datetime.timedelta(hours=n)  # noqa: E731
DAYS = lambda n: datetime.timedelta(days=n)    # noqa: E731


class DeviceClockRules(SimpleTestCase):
    NOW = datetime.datetime(2026, 11, 12, 12, 0, tzinfo=datetime.timezone.utc)

    def r(self, device_time, sent_at):
        return resolve_device_time(device_time, sent_at, self.NOW)

    def test_without_sent_at_the_clock_cannot_be_checked(self):
        self.assertEqual(self.r(self.NOW - DAYS(20), None), (self.NOW, None, 'clock_unverified'))

    def test_a_crafted_sent_at_cannot_move_an_entry_far_back_in_time(self):
        """device_time = now and sent_at = now + 29 days would give an entry dated 29 days ago."""
        effective, skew, anomaly = self.r(self.NOW, self.NOW + DAYS(29))
        self.assertEqual((effective, anomaly), (self.NOW, 'clock_untrusted'))
        self.assertEqual(self.r(self.NOW, self.NOW - DAYS(29))[2], 'clock_untrusted')

    def test_the_skew_is_corrected_up_to_the_limit_only(self):
        self.assertEqual(self.r(self.NOW - HOURS(1), self.NOW + HOURS(47))[2], 'clock_corrected')
        self.assertEqual(self.r(self.NOW - HOURS(1), self.NOW + HOURS(49))[2], 'clock_untrusted')

    def test_an_old_entry_is_kept_but_flagged(self):
        entered = self.NOW - DAYS(10)
        self.assertEqual(self.r(entered, self.NOW), (entered, 0, 'late_entry'))
        entered = self.NOW - DAYS(6)
        self.assertEqual(self.r(entered, self.NOW), (entered, 0, ''))

    def test_too_old_and_future_dates_fall_back_to_the_server_time(self):
        self.assertEqual(self.r(self.NOW - DAYS(121), self.NOW)[2], 'too_old')
        self.assertEqual(self.r(self.NOW + DAYS(1), self.NOW)[2], 'future_date')


class DeviceDateIntegrationTests(SyncTestCase):
    def day(self, n):
        return (timezone.localdate() - datetime.timedelta(days=n)).isoformat()

    def op_for(self, *, device_days_ago, birth_days_ago, **extra):
        payload = self.declaration_payload(birth_date=self.day(birth_days_ago))
        return self.create_op(payload=payload, device_time=iso(timezone.now() - datetime.timedelta(days=device_days_ago)), **extra)

    def push_raw(self, operations, sent_at):
        body = {'device': {'id': DEVICE, 'label': 'x'}, 'user': str(self.agent.uuid), 'operations': operations}
        if sent_at is not None:
            body['sent_at'] = iso(sent_at)
        return self.client_for(self.agent).post('/api/sync/push/', body, format='json')

    def test_sent_at_is_compulsory(self):
        r = self.push_raw([self.op_for(device_days_ago=1, birth_days_ago=2)], None)
        self.assertEqual(r.status_code, 400)
        self.assertIn('sent_at', r.data)
        body, r2 = self.upload(self.agent, str(uuid.uuid4()))
        form = {k: v for k, v in body.items() if k != 'sent_at'}
        r3 = self.client_for(self.agent).post('/api/sync/documents/', form, format='multipart')
        self.assertEqual(r3.status_code, 400)

    def test_the_crafted_clock_is_ignored_and_audited(self):
        op = self.op_for(device_days_ago=0, birth_days_ago=1)
        r = self.push_raw([op], timezone.now() + DAYS(29))
        res = r.data['results'][0]
        self.assertEqual((res['status'], res['date_anomaly']), ('applied', 'clock_untrusted'))
        d = Declaration.objects.get(uuid=op['entity_uuid'])
        self.assertLess(abs((d.device_created_at - timezone.now()).total_seconds()), 60)   # server time, not 29 days ago
        event = AuditLog.objects.get(action=AuditAction.SYNC_DATE_ANOMALY)
        self.assertEqual(event.changes['anomaly'], 'clock_untrusted')
        self.assertEqual(SyncOperation.objects.get(op_id=op['op_id']).date_anomaly, 'clock_untrusted')

    def test_an_entry_dated_before_the_birth_is_refused_its_date(self):
        """Declared 20 days ago on the device for a child born 10 days ago: impossible."""
        op = self.op_for(device_days_ago=20, birth_days_ago=10)
        res = self.push_raw([op], timezone.now()).data['results'][0]
        self.assertEqual((res['status'], res['date_anomaly']), ('applied', 'before_birth'))
        d = Declaration.objects.get(uuid=op['entity_uuid'])
        self.assertLess(abs((d.device_created_at - timezone.now()).total_seconds()), 60)

    def test_a_late_entry_keeps_its_date_but_is_flagged(self):
        op = self.op_for(device_days_ago=10, birth_days_ago=20)
        res = self.push_raw([op], timezone.now()).data['results'][0]
        self.assertEqual((res['status'], res['date_anomaly']), ('applied', 'late_entry'))
        d = Declaration.objects.get(uuid=op['entity_uuid'])
        self.assertGreater((timezone.now() - d.device_created_at).days, 8)

    def test_the_anomaly_is_audited_once_even_if_the_batch_is_replayed(self):
        op = self.op_for(device_days_ago=0, birth_days_ago=1)
        for _ in range(2):
            self.push_raw([op], timezone.now() + DAYS(29))
        self.assertEqual(AuditLog.objects.filter(action=AuditAction.SYNC_DATE_ANOMALY).count(), 1)

    def test_a_normal_entry_raises_no_anomaly(self):
        op = self.op_for(device_days_ago=2, birth_days_ago=3)
        res = self.push_raw([op], timezone.now()).data['results'][0]
        self.assertEqual((res['status'], res['date_anomaly']), ('applied', ''))
        self.assertFalse(AuditLog.objects.filter(action=AuditAction.SYNC_DATE_ANOMALY).exists())


# ── an agent cannot use the duplicate control to query the civil register ──

class NoOracleTests(SyncTestCase, DuplicateBase):
    def setUp(self):
        super().setUp()
        self.victim = self.mk(self.agent)                         # a dossier typed by somebody else

    def probe(self):
        """Agent 2 types the same identity, online and through the synchronisation."""
        online = self.client_for(self.agent2).post('/api/declarations/', self.payload(), format='json')
        offline = self.push(self.agent2, [self.create_op(payload=self.payload())], device='5b4d3c2e-1f0a-4e9b-8c7d-6a5f4e3d2c1b')
        return online, offline.data['results'][0]

    def test_the_author_learns_nothing_whatever_the_channel(self):
        online, offline = self.probe()
        self.assertEqual(online.status_code, 201)
        self.assertIsNone(online.data['duplicate_alert'])
        self.assertNotIn('duplicate_cases', offline)
        self.assertIsNone(offline['declaration']['duplicate_alert'])
        self.assertTrue(DuplicateCase.objects.exists())            # the control centre does have its cases
        raw = json.dumps([online.data, offline], default=str)
        self.assertNotIn('DUP-', raw)

    def test_the_synchronisation_history_hides_the_cases_from_the_agent(self):
        self.probe()
        rows = self.client_for(self.agent2).get('/api/sync/operations/').data['results']
        self.assertTrue(rows)
        self.assertNotIn("DUP-", json.dumps(rows, default=str))
        # ... and the people of the control centre still see them
        stored = SyncOperation.objects.filter(user=self.agent2, op_type='declaration.create').first()
        self.assertIn('duplicate_cases', stored.result)
        seen = self.client_for(self.admin).get('/api/sync/operations/').data['results']
        self.assertIn("DUP-", json.dumps(seen, default=str))

    def test_the_control_centre_still_sees_the_alert(self):
        online, _ = self.probe()
        self.transition(self.agent2, online.data['uuid'], 'TRANSMITTED')
        r = self.client_for(self.secretary).get(f"/api/declarations/{online.data['uuid']}/")
        self.assertTrue(r.data['duplicate_alert']['blocked'])


# ── detection: the pre-filter cannot hide the original dossier ──

from unittest import mock

from django.db.models import Q


class CandidateTiersTests(DuplicateBase):
    DAY = (timezone.localdate() - datetime.timedelta(days=10)).isoformat()

    def link(self, a, b):
        return DuplicateCase.objects.filter(
            Q(declaration__uuid=a, other_declaration__uuid=b) | Q(other_declaration__uuid=a, declaration__uuid=b)).count()

    def busy_week(self, n=6):
        orig = self.mk(self.agent, date=self.DAY)
        peoples = [(('Ibrahima', 'Sylla'), ('Kadiatou', 'Soumah')), (('Moussa', 'Camara'), ('Hawa', 'Touré')),
                   (('Sekou', 'Bangoura'), ('Djénabou', 'Barry')), (('Alpha', 'Sow'), ('Aïssatou', 'Baldé')),
                   (('Mohamed', 'Traoré'), ('Salimatou', 'Kourouma')), (('Fanta', 'Cissé'), ('Binta', 'Doumbouya')),
                   (('Lansana', 'Fofana'), ('Mamata', 'Sidibé')), (('Kadiatou', 'Yansané'), ('Oumou', 'Magassouba'))]
        for child, mother in peoples[:n]:
            self.mk(self.agent2, date=self.DAY, child=child, mother=mother, hospital_ref=f'X-{child[0]}')
        return orig

    def test_a_busy_week_cannot_push_the_original_out_of_the_candidates(self):
        """Same mother as the original: that key is searched first, whatever the number of births that week."""
        orig = self.busy_week()
        with mock.patch('duplicates.services.detection.CANDIDATE_LIMIT', 2):
            copy = self.mk(self.agent2, date=self.DAY)
        self.assertEqual(self.link(orig['uuid'], copy['uuid']), 1)

    def test_a_truncated_analysis_is_flagged_and_the_validation_redoes_it_in_full(self):
        from duplicates.models import DuplicateCheck
        from duplicates.services.detection import DuplicateDetectionService
        self.busy_week()
        with mock.patch('duplicates.services.detection.CANDIDATE_LIMIT', 2):
            copy = self.mk(self.agent2, date=self.DAY, mother=('Zeinab', 'Sylla'), child=('Zeinab', 'Sylla'), hospital_ref='Z-1')
        check = DuplicateCheck.objects.filter(declaration__uuid=copy['uuid']).latest('pk')
        self.assertTrue(check.candidates_truncated)
        decl = Declaration.objects.get(uuid=copy['uuid'])
        fresh = DuplicateDetectionService.ensure_fresh(decl, self.admin)      # what the official validation calls
        self.assertFalse(fresh.candidates_truncated)
        self.assertEqual(fresh.trigger, 'PRE_VALIDATION')
        self.assertGreater(fresh.candidates_examined, check.candidates_examined)
        self.assertTrue(AuditLog.objects.filter(action=AuditAction.DUPLICATE_CHECK, changes__truncated=True).exists())

    def test_the_manual_analysis_is_exhaustive(self):
        self.busy_week()
        with mock.patch('duplicates.services.detection.CANDIDATE_LIMIT', 2):
            copy = self.mk(self.agent2, date=self.DAY, mother=('Zeinab', 'Sylla'), child=('Zeinab', 'Sylla'), hospital_ref='Z-1')
        r = self.client_for(self.secretary).post('/api/duplicates/analyze/', {'declaration': copy['uuid']}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.data['check']['truncated'])


class CaseNotesStayInTheCaseTests(DuplicateBase):
    def test_an_observation_cannot_be_attached_to_a_dossier_outside_the_case(self):
        a, b = self.mk(self.agent), self.mk(self.agent2)
        c = self.mk(self.agent, mother=('Kadiatou', 'Soumah'), child=('Ibrahima', 'Sylla'))
        case = self.case_for(a['uuid'], b['uuid'])
        cl = self.client_for(self.secretary)
        base = f'/api/duplicates/cases/{case.uuid}'
        bad = cl.post(f'{base}/note/', {'content': 'Observation', 'kind': 'OBSERVATION', 'declaration': c['uuid']}, format='json')
        self.assertEqual(bad.status_code, 400)
        bad = cl.post(f'{base}/request-verification/', {'content': 'Vérifier', 'declaration': c['uuid']}, format='json')
        self.assertEqual(bad.status_code, 400)
        ok = cl.post(f'{base}/note/', {'content': 'Observation', 'kind': 'OBSERVATION', 'declaration': a['uuid']}, format='json')
        self.assertEqual(ok.status_code, 201, ok.content)


# ── headers of the API answers, rate limits, deployment checks ──

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from rest_framework.test import APITestCase


class ApiHeadersTests(SyncTestCase):
    def test_every_api_answer_is_no_store_with_a_restrictive_policy(self):
        for response in (self.client_for(self.agent).get('/api/auth/me/'),
                         self.client_for(self.agent).get('/api/declarations/'),
                         self.client_for(self.admin).get('/api/duplicates/cases/'),
                         self.client.get('/api/public/settings/'),
                         self.client.get('/api/declarations/')):                    # even a refusal
            self.assertEqual(response['Cache-Control'], 'no-store', response.request['PATH_INFO'])
            self.assertIn("default-src 'none'", response['Content-Security-Policy'])
            self.assertIn('sandbox', response['Content-Security-Policy'])
            self.assertEqual(response['X-Content-Type-Options'], 'nosniff')
            self.assertEqual(response['Referrer-Policy'], 'no-referrer')

    def test_a_header_set_by_the_view_is_kept(self):
        r = self.client_for(self.agent).get('/api/sync/pull/')
        self.assertEqual(r['Cache-Control'], 'private, no-store')

    def test_documents_are_served_sandboxed_and_never_cached(self):
        decl = self.create_declaration(self.agent)
        content = b'\xff\xd8\xff\xe0' + b'photo' * 30
        r = self.client_for(self.agent).post('/api/documents/', {
            'declaration': decl['uuid'], 'kind': 'PAPER_FORM', 'file': SimpleUploadedFile('f.jpg', content)}, format='multipart')
        self.assertEqual(r.status_code, 201, r.content)
        got = self.client_for(self.agent).get(f"/api/documents/{r.data['uuid']}/download/")
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got['Cache-Control'], 'private, no-store')
        self.assertIn('sandbox', got['Content-Security-Policy'])
        self.assertEqual(got['X-Content-Type-Options'], 'nosniff')


class RateLimitTests(SyncTestCase):
    def test_the_synchronisation_is_rate_limited_per_user(self):
        from sync.views import SyncRateThrottle
        with mock.patch.dict(SyncRateThrottle.THROTTLE_RATES, {'sync': '3/min'}):
            codes = [self.client_for(self.agent).get('/api/sync/pull/').status_code for _ in range(5)]
            self.assertEqual(codes, [200, 200, 200, 429, 429])
            # another agent has his own counter
            self.assertEqual(self.client_for(self.agent2).get('/api/sync/pull/').status_code, 200)

    def test_the_public_ping_is_rate_limited_per_address(self):
        from sync.views import PingRateThrottle
        with mock.patch.dict(PingRateThrottle.THROTTLE_RATES, {'sync_ping': '2/min'}):
            codes = [self.client.get('/api/sync/ping/').status_code for _ in range(4)]
            self.assertEqual(codes, [200, 200, 429, 429])

    def test_analyses_and_comparisons_are_rate_limited(self):
        from duplicates.views import HeavyRateThrottle
        decl = self.create_declaration(self.agent)
        with mock.patch.dict(HeavyRateThrottle.THROTTLE_RATES, {'duplicates_heavy': '2/min'}):
            cl = self.client_for(self.secretary)
            self.transition(self.agent, decl['uuid'], 'TRANSMITTED')
            codes = [cl.post('/api/duplicates/analyze/', {'declaration': decl['uuid']}, format='json').status_code for _ in range(3)]
            self.assertEqual(codes, [200, 200, 429])


class DeploymentChecksTests(APITestCase):
    def run_checks(self):
        from django.core.checks import run_checks
        return {m.id for m in run_checks(include_deployment_checks=True)}

    def test_the_in_memory_rate_limit_cache_is_reported(self):
        self.assertIn('wakara.W001', self.run_checks())

    @override_settings(CACHES={'default': {'BACKEND': 'django.core.cache.backends.dummy.DummyCache'}})
    def test_a_shared_cache_silences_it(self):
        self.assertNotIn('wakara.W001', self.run_checks())

    @override_settings(NUM_PROXIES=0, DEBUG=False)
    def test_a_missing_proxy_count_is_reported(self):
        self.assertIn('wakara.W002', self.run_checks())
