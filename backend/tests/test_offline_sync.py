"""Offline mode: push / pull, idempotence, device dates, conflicts, photos, devices (fictional data only)."""
import datetime
import hashlib
import uuid

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, override_settings
from django.utils import timezone

from audit.models import AuditLog
from core.models import SiteSetting
from declarations.models import Declaration, ReferenceCounter, StatusHistory
from documents.models import SupportingDocument
from sync.models import Device, SyncOperation
from sync.services import resolve_device_time

from .base import WakaraTestCase

JPEG = b'\xff\xd8\xff\xe0' + b'wakara-photo-de-test' * 20
DEVICE = '7f1c0f0e-5b7b-4a53-9d39-3a8f1c2d4e5f'


def iso(dt):
    return dt.isoformat()


class SyncTestCase(WakaraTestCase):
    def push(self, user, operations, device=DEVICE, prepared_by=None):
        body = {'device': {'id': device, 'label': 'Téléphone de test'}, 'user': str((prepared_by or user).uuid),
                'sent_at': iso(timezone.now()), 'operations': operations}
        return self.client_for(user).post('/api/sync/push/', body, format='json')

    def op(self, kind, entity=None, **extra):
        return {'op_id': str(uuid.uuid4()), 'type': f'declaration.{kind}', 'entity_uuid': entity or str(uuid.uuid4()),
                'device_time': iso(timezone.now()), **extra}

    def create_op(self, **extra):
        payload = extra.pop('payload', None) or self.declaration_payload()
        return self.op('create', payload=payload, **extra)

    def pushed(self, user=None, **extra):
        """A declaration created through the synchronisation; returns (operation, answer)."""
        op = self.create_op(**extra)
        r = self.push(user or self.agent, [op])
        self.assertEqual(r.status_code, 200, r.content)
        return op, r.data['results'][0]

    def upload(self, user, declaration, content=JPEG, name='fiche.jpg', sha=None, device=DEVICE, **extra):
        body = {'op_id': str(uuid.uuid4()), 'device_id': device, 'user': str(user.uuid),
                'sent_at': iso(timezone.now()), 'device_time': iso(timezone.now()), 'uuid': str(uuid.uuid4()),
                'declaration': declaration, 'kind': 'PAPER_FORM',
                'sha256': sha or hashlib.sha256(content).hexdigest(),
                'file': SimpleUploadedFile(name, content), **extra}
        return body, self.client_for(user).post('/api/sync/documents/', body, format='multipart')


class DeviceClockTests(SimpleTestCase):
    NOW = datetime.datetime(2026, 11, 12, 12, 0, tzinfo=datetime.timezone.utc)

    def test_device_time_is_kept_when_the_clock_is_right(self):
        entered = self.NOW - datetime.timedelta(days=3)
        self.assertEqual(resolve_device_time(entered, self.NOW, self.NOW), (entered, 0, ''))

    def test_wrong_clock_is_corrected_by_the_measured_skew(self):
        # the phone is 2 hours ahead; the entry was made one day before the push
        sent = self.NOW + datetime.timedelta(hours=2)
        entered = sent - datetime.timedelta(days=1)
        effective, skew, anomaly = resolve_device_time(entered, sent, self.NOW)
        self.assertEqual(effective, self.NOW - datetime.timedelta(days=1))
        self.assertEqual((skew, anomaly), (-7200, 'clock_corrected'))

    def test_future_date_falls_back_to_the_server_time(self):
        effective, _skew, anomaly = resolve_device_time(self.NOW + datetime.timedelta(days=2), self.NOW, self.NOW)
        self.assertEqual((effective, anomaly), (self.NOW, 'future_date'))

    def test_too_old_date_falls_back_to_the_server_time(self):
        effective, _skew, anomaly = resolve_device_time(self.NOW - datetime.timedelta(days=45), self.NOW, self.NOW)
        self.assertEqual((effective, anomaly), (self.NOW, 'too_old'))

    def test_without_device_time_the_server_time_is_used(self):
        self.assertEqual(resolve_device_time(None, None, self.NOW), (self.NOW, None, ''))


class PingTests(SyncTestCase):
    def test_ping_is_public_and_gives_the_server_time(self):
        r = self.client.get('/api/sync/ping/')
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.data['offline_enabled'])
        self.assertIn('server_time', r.data)

    def test_remote_switch_turns_the_offline_mode_off(self):
        SiteSetting.objects.update_or_create(key='offline.enabled', defaults={'value': 'false', 'is_public': True})
        self.assertFalse(self.client.get('/api/sync/ping/').data['offline_enabled'])
        self.assertEqual(self.client.get('/api/public/settings/').data['offline.enabled'], 'false')
        # pending operations can still be synchronised: no data stays stuck on a device
        _op, answer = self.pushed()
        self.assertEqual(answer['status'], 'applied')


class CreateTests(SyncTestCase):
    def test_creation_uses_the_device_uuid_and_the_device_date(self):
        entered = timezone.now() - datetime.timedelta(days=3)
        op, answer = self.pushed(device_time=iso(entered))
        self.assertEqual(answer['status'], 'applied')
        d = Declaration.objects.get(uuid=op['entity_uuid'])
        self.assertTrue(d.reference.startswith('WKR-'))
        self.assertEqual(answer['declaration']['reference'], d.reference)
        self.assertEqual(d.created_by, self.agent)
        self.assertEqual(d.status, 'DRAFT')
        # the date that counts is the one of the entry on the device; the server time stays in created_at
        self.assertEqual(d.received_at, timezone.localtime(entered).date())
        self.assertEqual(d.device_created_at, entered)
        self.assertGreater(d.created_at, entered + datetime.timedelta(days=2))
        note = StatusHistory.objects.get(declaration=d).reason
        self.assertIn('Saisie hors connexion le', note)

    def test_immediate_synchronisation_leaves_no_offline_note(self):
        op, _answer = self.pushed()
        self.assertEqual(StatusHistory.objects.get(declaration__uuid=op['entity_uuid']).reason, '')

    def test_same_operation_replayed_creates_nothing_twice(self):
        op = self.create_op()
        first = self.push(self.agent, [op]).data['results'][0]
        counter = ReferenceCounter.objects.get().value
        second = self.push(self.agent, [op]).data['results'][0]
        self.assertEqual((first['status'], second['status']), ('applied', 'duplicate'))
        self.assertEqual(second['declaration']['reference'], first['declaration']['reference'])
        self.assertEqual(Declaration.objects.count(), 1)
        self.assertEqual(ReferenceCounter.objects.get().value, counter)
        self.assertEqual(SyncOperation.objects.count(), 1)

    def test_same_dossier_sent_under_a_new_operation_is_not_duplicated(self):
        op, _answer = self.pushed()
        again = self.create_op(entity_uuid=op['entity_uuid'])
        again['entity_uuid'] = op['entity_uuid']
        answer = self.push(self.agent, [again]).data['results'][0]
        self.assertEqual(answer['status'], 'applied')
        self.assertEqual(Declaration.objects.count(), 1)

    def test_identifier_of_another_user_is_refused(self):
        op, _answer = self.pushed()
        other = self.create_op()
        other['entity_uuid'] = op['entity_uuid']
        answer = self.push(self.agent2, [other]).data['results'][0]
        self.assertEqual((answer['status'], answer['error']['code']), ('rejected', 'uuid_taken'))
        self.assertIsNone(answer['declaration'])

    def test_invalid_content_is_rejected_with_the_field_errors(self):
        payload = self.declaration_payload(birth_place='')
        _op, answer = self.pushed(payload=payload)
        self.assertEqual((answer['status'], answer['error']['code']), ('rejected', 'validation'))
        self.assertIn('birth_place', answer['error']['fields'])
        self.assertEqual(Declaration.objects.count(), 0)
        self.assertTrue(AuditLog.objects.filter(action='sync_rejected').exists())

    def test_a_rejected_operation_can_be_corrected_and_sent_again(self):
        op = self.create_op(payload=self.declaration_payload(birth_place=''))
        self.assertEqual(self.push(self.agent, [op]).data['results'][0]['status'], 'rejected')
        op['payload'] = self.declaration_payload()
        self.assertEqual(self.push(self.agent, [op]).data['results'][0]['status'], 'applied')
        record = SyncOperation.objects.get(op_id=op['op_id'])
        self.assertEqual((record.status, record.attempts), ('applied', 2))

    def test_acte_section_sent_by_a_device_is_ignored(self):
        payload = self.declaration_payload(acte={'numero_acte': '999', 'registre': 'R9'})
        op, answer = self.pushed(payload=payload)
        self.assertEqual(answer['status'], 'applied')
        self.assertFalse(hasattr(Declaration.objects.get(uuid=op['entity_uuid']), 'acte'))

    def test_every_event_is_traced_with_the_device_and_the_operation(self):
        entered = timezone.now() - datetime.timedelta(hours=5)
        op, _answer = self.pushed(device_time=iso(entered))
        log = AuditLog.objects.get(action='create', object_id=op['entity_uuid'])
        self.assertEqual(log.origin, 'offline')
        self.assertEqual((str(log.device_id), str(log.sync_op_id)), (DEVICE, op['op_id']))
        self.assertEqual(log.device_time, entered)
        record = SyncOperation.objects.get(op_id=op['op_id'])
        self.assertEqual((record.user, record.device.label), (self.agent, 'Téléphone de test'))
        self.assertEqual(record.result['reference'], Declaration.objects.get().reference)
        # events of the online API are not marked
        online = self.create_declaration()
        self.assertEqual(AuditLog.objects.get(action='create', object_id=online['uuid']).origin, '')

    def test_unreliable_device_dates_fall_back_to_the_server_date(self):
        op, answer = self.pushed(device_time=iso(timezone.now() + datetime.timedelta(days=4)))
        self.assertEqual(answer['date_anomaly'], 'future_date')
        d = Declaration.objects.get(uuid=op['entity_uuid'])
        self.assertEqual(d.received_at, timezone.localdate())
        self.assertIn('date du serveur retenue', StatusHistory.objects.get(declaration=d).reason)
        op, answer = self.pushed(device_time=iso(timezone.now() - datetime.timedelta(days=60)))
        self.assertEqual(answer['date_anomaly'], 'too_old')
        self.assertEqual(Declaration.objects.get(uuid=op['entity_uuid']).received_at, timezone.localdate())
        self.assertEqual(SyncOperation.objects.get(op_id=op['op_id']).date_anomaly, 'too_old')


class UpdateAndConflictTests(SyncTestCase):
    def test_update_on_the_current_version_is_applied(self):
        op, created = self.pushed()
        version = created['declaration']['sync_version']
        edit = self.op('update', entity=op['entity_uuid'], base_version=version,
                       payload={'birth_place': 'Kipé', 'child': {'first_names': 'Aïcha'}})
        answer = self.push(self.agent, [edit]).data['results'][0]
        self.assertEqual(answer['status'], 'applied')
        d = Declaration.objects.get(uuid=op['entity_uuid'])
        self.assertEqual((d.birth_place, d.child.first_names), ('Kipé', 'Aïcha'))
        self.assertEqual(answer['declaration']['sync_version'], version + 1)

    def test_update_on_an_old_version_is_a_conflict_and_overwrites_nothing(self):
        op, created = self.pushed()
        uid, version = op['entity_uuid'], created['declaration']['sync_version']
        # the dossier changes on the server (another device of the same agent, online)
        r = self.client_for(self.agent).patch(f'/api/declarations/{uid}/', {'birth_place': 'Serveur'}, format='json')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data['sync_version'], version + 1)
        edit = self.op('update', entity=uid, base_version=version, payload={'birth_place': 'Appareil'})
        answer = self.push(self.agent, [edit]).data['results'][0]
        self.assertEqual((answer['status'], answer['error']['code']), ('conflict', 'version_conflict'))
        self.assertEqual(Declaration.objects.get(uuid=uid).birth_place, 'Serveur')
        # the device receives the server state to let the agent decide
        self.assertEqual(answer['declaration']['birth_place'], 'Serveur')
        self.assertTrue(AuditLog.objects.filter(action='sync_conflict', object_id=uid).exists())

    def test_update_without_base_version_is_rejected(self):
        op, _created = self.pushed()
        answer = self.push(self.agent, [self.op('update', entity=op['entity_uuid'], payload={'notes': 'x'})]).data['results'][0]
        self.assertEqual(answer['status'], 'rejected')

    def test_a_transmitted_dossier_can_no_longer_be_edited_from_a_device(self):
        op, created = self.pushed()
        uid = op['entity_uuid']
        self.assertEqual(self.transition(self.agent, uid, 'TRANSMITTED').status_code, 200)
        version = Declaration.objects.get(uuid=uid).sync_version
        edit = self.op('update', entity=uid, base_version=version, payload={'birth_place': 'Appareil'})
        answer = self.push(self.agent, [edit]).data['results'][0]
        self.assertEqual((answer['status'], answer['error']['code']), ('conflict', 'not_editable'))
        self.assertEqual(Declaration.objects.get(uuid=uid).birth_place, 'Ratoma')

    def test_a_validated_act_is_never_overwritten(self):
        d = self.create_declaration()
        self.advance_to_pending(d['uuid'])
        self.assertEqual(self.transition(self.admin, d['uuid'], 'VALIDATED', numero_acte='42', accept_incomplete=True).status_code, 200)
        before = Declaration.objects.get(uuid=d['uuid'])
        ops = [self.op('update', entity=d['uuid'], base_version=before.sync_version, payload={'birth_place': 'Pirate'}),
               self.op('transmit', entity=d['uuid'])]
        results = self.push(self.agent, ops).data['results']
        self.assertEqual([r['status'] for r in results], ['conflict', 'skipped'])
        after = Declaration.objects.get(uuid=d['uuid'])
        self.assertEqual((after.status, after.birth_place, after.sync_version),
                         ('VALIDATED', before.birth_place, before.sync_version))

    def test_a_refused_operation_blocks_the_next_ones_of_the_same_dossier_only(self):
        first, created = self.pushed()
        other, _ = self.pushed()
        stale = self.op('update', entity=first['entity_uuid'], base_version=created['declaration']['sync_version'] + 5,
                        payload={'notes': 'x'})
        results = self.push(self.agent, [stale, self.op('transmit', entity=first['entity_uuid']),
                                        self.op('transmit', entity=other['entity_uuid'])]).data['results']
        self.assertEqual([r['status'] for r in results], ['conflict', 'skipped', 'applied'])
        self.assertEqual(Declaration.objects.get(uuid=first['entity_uuid']).status, 'DRAFT')
        self.assertEqual(Declaration.objects.get(uuid=other['entity_uuid']).status, 'TRANSMITTED')
        # a skipped operation leaves no trace: the device will send it again
        self.assertEqual(SyncOperation.objects.filter(declaration_uuid=first['entity_uuid']).count(), 2)

    def test_every_server_side_change_increments_the_version(self):
        d = self.create_declaration()
        self.assertEqual(d['sync_version'], 1)
        self.client_for(self.agent).patch(f'/api/declarations/{d["uuid"]}/', {'notes': 'a'}, format='json')
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        self.assertEqual(Declaration.objects.get(uuid=d['uuid']).sync_version, 3)

    def test_archived_dossier_is_a_conflict(self):
        op, created = self.pushed()
        self.assertEqual(self.client_for(self.admin).delete(f'/api/declarations/{op["entity_uuid"]}/').status_code, 204)
        edit = self.op('update', entity=op['entity_uuid'], base_version=created['declaration']['sync_version'] + 1,
                       payload={'notes': 'x'})
        answer = self.push(self.agent, [edit]).data['results'][0]
        self.assertEqual((answer['status'], answer['error']['code']), ('conflict', 'archived'))


class TransmitTests(SyncTestCase):
    def test_transmission_keeps_the_device_time(self):
        op, _created = self.pushed()
        sent = timezone.now() - datetime.timedelta(days=2)
        answer = self.push(self.agent, [self.op('transmit', entity=op['entity_uuid'], device_time=iso(sent))]).data['results'][0]
        self.assertEqual(answer['status'], 'applied')
        d = Declaration.objects.get(uuid=op['entity_uuid'])
        self.assertEqual((d.status, d.transmitted_at, d.device_transmitted_at), ('TRANSMITTED', sent, sent))
        history = StatusHistory.objects.filter(declaration=d, to_status='TRANSMITTED').get()
        self.assertIn('Transmise hors connexion le', history.reason)
        self.assertGreater(history.changed_at, sent + datetime.timedelta(days=1))  # server time of the synchronisation
        self.assertEqual(answer['declaration']['status'], 'TRANSMITTED')

    def test_whole_offline_session_in_one_batch(self):
        create = self.create_op()
        uid = create['entity_uuid']
        ops = [create, self.op('transmit', entity=uid)]
        results = self.push(self.agent, ops).data['results']
        self.assertEqual([r['status'] for r in results], ['applied', 'applied'])
        self.assertEqual(Declaration.objects.get(uuid=uid).status, 'TRANSMITTED')
        # the secretariat now sees it, exactly as a dossier transmitted online
        self.assertEqual(self.client_for(self.secretary).get(f'/api/declarations/{uid}/').status_code, 200)

    def test_transmission_twice_is_a_conflict_not_a_second_transition(self):
        op, _created = self.pushed()
        uid = op['entity_uuid']
        self.assertEqual(self.push(self.agent, [self.op('transmit', entity=uid)]).data['results'][0]['status'], 'applied')
        answer = self.push(self.agent, [self.op('transmit', entity=uid)]).data['results'][0]
        self.assertEqual((answer['status'], answer['error']['code']), ('conflict', 'invalid_transition'))
        self.assertEqual(StatusHistory.objects.filter(declaration__uuid=uid, to_status='TRANSMITTED').count(), 1)

    @override_settings(DECLARATION_REQUIRED_FOR_TRANSMISSION=['birth_date', 'father.name'])
    def test_required_fields_are_checked_by_the_server(self):
        op, _created = self.pushed()
        answer = self.push(self.agent, [self.op('transmit', entity=op['entity_uuid'])]).data['results'][0]
        self.assertEqual(answer['status'], 'rejected')
        self.assertIn('father.name', answer['error']['fields']['missing_fields'])
        self.assertIn('nom du père', answer['error']['detail'])
        self.assertEqual(Declaration.objects.get(uuid=op['entity_uuid']).status, 'DRAFT')


class PermissionTests(SyncTestCase):
    def test_push_requires_authentication_and_a_declaration_permission(self):
        body = {'device': {'id': DEVICE}, 'operations': []}
        self.assertEqual(self.client.post('/api/sync/push/', body, format='json').status_code, 401)
        self.assertEqual(self.client_for(self.nobody).post('/api/sync/push/', body, format='json').status_code, 403)
        self.assertEqual(self.client_for(self.secretary).post('/api/sync/push/', body, format='json').status_code, 403)
        self.assertEqual(self.client_for(self.agent).post('/api/sync/push/', body, format='json').status_code, 200)

    def test_account_that_must_change_its_password_cannot_synchronise(self):
        self.agent2.must_change_password = True
        self.agent2.save(update_fields=['must_change_password'])
        self.assertEqual(self.push(self.agent2, [self.create_op()]).status_code, 403)
        self.assertEqual(Declaration.objects.count(), 0)

    def test_nobody_synchronises_the_operations_of_another_user(self):
        r = self.push(self.agent, [self.create_op()], prepared_by=self.agent2)
        self.assertEqual((r.status_code, r.data['code']), (403, 'user_mismatch'))
        self.assertEqual(Declaration.objects.count(), 0)

    def test_dossier_of_another_agent_is_refused(self):
        op, created = self.pushed()
        version = created['declaration']['sync_version']
        for user in (self.agent2, self.admin):  # even an administrator: a device only works on its own dossiers
            ops = [self.op('update', entity=op['entity_uuid'], base_version=version, payload={'notes': 'x'})]
            answer = self.push(user, ops).data['results'][0]
            self.assertEqual((answer['status'], answer['error']['code']), ('rejected', 'forbidden'), user)
            self.assertIsNone(answer['declaration'])
        self.assertEqual(Declaration.objects.get(uuid=op['entity_uuid']).notes, '')

    def test_operation_of_another_user_cannot_be_replayed(self):
        op = self.create_op()
        self.push(self.agent, [op])
        answer = self.push(self.agent2, [op]).data['results'][0]
        self.assertEqual((answer['status'], answer['error']['code']), ('rejected', 'forbidden'))

    def test_permission_removed_while_offline_is_enforced_at_synchronisation(self):
        from accounts.models import Permission, UserPermission
        UserPermission.objects.create(user=self.agent, permission=Permission.objects.get(codename='declaration.transmit'),
                                      granted=False)
        create = self.create_op()
        results = self.push(self.agent, [create, self.op('transmit', entity=create['entity_uuid'])]).data['results']
        self.assertEqual([r['status'] for r in results], ['applied', 'rejected'])
        self.assertEqual(results[1]['error']['code'], 'forbidden')
        self.assertEqual(Declaration.objects.get(uuid=create['entity_uuid']).status, 'DRAFT')

    def test_batch_size_is_limited(self):
        with override_settings(SYNC_MAX_BATCH=2):
            r = self.push(self.agent, [self.create_op() for _ in range(3)])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(Declaration.objects.count(), 0)

    def test_unknown_operation_type_is_refused(self):
        r = self.push(self.agent, [{**self.create_op(), 'type': 'declaration.validate'}])
        self.assertEqual(r.status_code, 400)


class DeviceTests(SyncTestCase):
    def test_device_is_registered_at_first_contact(self):
        self.pushed()
        device = Device.objects.get()
        self.assertEqual((str(device.device_id), device.user, device.label), (DEVICE, self.agent, 'Téléphone de test'))
        self.assertIsNotNone(device.last_sync_at)
        self.assertTrue(AuditLog.objects.filter(action='device_registered').exists())
        self.pushed()
        self.assertEqual(Device.objects.count(), 1)

    def test_revoked_device_is_refused_until_restored(self):
        self.pushed()
        device = Device.objects.get()
        admin = self.client_for(self.admin)
        self.assertEqual(self.client_for(self.agent).post(f'/api/sync/devices/{device.pk}/revoke/').status_code, 403)
        self.assertEqual(admin.post(f'/api/sync/devices/{device.pk}/revoke/').status_code, 200)
        r = self.push(self.agent, [self.create_op()])
        self.assertEqual((r.status_code, r.data['code']), (403, 'device_revoked'))
        _body, r = self.upload(self.agent, str(Declaration.objects.get().uuid))
        self.assertEqual((r.status_code, r.data['code']), (403, 'device_revoked'))
        self.assertEqual(Declaration.objects.count(), 1)
        # another device of the same agent still works
        self.assertEqual(self.push(self.agent, [self.create_op()], device=str(uuid.uuid4())).status_code, 200)
        self.assertEqual(admin.post(f'/api/sync/devices/{device.pk}/restore/').status_code, 200)
        self.assertEqual(self.push(self.agent, [self.create_op()]).data['results'][0]['status'], 'applied')
        self.assertEqual(AuditLog.objects.filter(action__in=['device_revoked', 'device_restored']).count(), 2)

    def test_device_list_is_reserved_to_the_audit_permission(self):
        self.pushed()
        self.assertEqual(self.client_for(self.agent).get('/api/sync/devices/').status_code, 403)
        r = self.client_for(self.admin).get('/api/sync/devices/')
        self.assertEqual((r.status_code, r.data['count']), (200, 1))


class DocumentTests(SyncTestCase):
    def test_photo_is_attached_with_the_device_identifier(self):
        op, _created = self.pushed()
        body, r = self.upload(self.agent, op['entity_uuid'])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.data['result']['status'], 'applied')
        doc = SupportingDocument.objects.get(uuid=body['uuid'])
        self.assertEqual((doc.kind, doc.sha256, doc.uploaded_by), ('PAPER_FORM', body['sha256'], self.agent))
        self.assertEqual(doc.file.open('rb').read(), JPEG)
        log = AuditLog.objects.get(action='document_uploaded')
        self.assertEqual(log.origin, 'offline')

    def test_photo_replayed_is_stored_once(self):
        op, _created = self.pushed()
        body, first = self.upload(self.agent, op['entity_uuid'])
        body['file'] = SimpleUploadedFile('fiche.jpg', JPEG)
        second = self.client_for(self.agent).post('/api/sync/documents/', body, format='multipart')
        self.assertEqual((first.data['result']['status'], second.data['result']['status']), ('applied', 'duplicate'))
        self.assertEqual(SupportingDocument.objects.count(), 1)

    def test_damaged_file_is_rejected(self):
        op, _created = self.pushed()
        _body, r = self.upload(self.agent, op['entity_uuid'], sha='0' * 64)
        self.assertEqual((r.data['result']['status'], r.data['result']['error']['code']), ('rejected', 'checksum'))
        self.assertEqual(SupportingDocument.objects.count(), 0)

    def test_forbidden_file_type_is_rejected(self):
        op, _created = self.pushed()
        _body, r = self.upload(self.agent, op['entity_uuid'], content=b'MZ-executable', name='virus.exe')
        self.assertEqual(r.data['result']['status'], 'rejected')
        _body, r = self.upload(self.agent, op['entity_uuid'], content=b'not-a-jpeg', name='faux.jpg')
        self.assertEqual(r.data['result']['status'], 'rejected')
        self.assertEqual(SupportingDocument.objects.count(), 0)

    def test_photo_on_the_dossier_of_another_agent_is_refused(self):
        op, _created = self.pushed()
        _body, r = self.upload(self.agent2, op['entity_uuid'])
        self.assertEqual((r.data['result']['status'], r.data['result']['error']['code']), ('rejected', 'forbidden'))
        self.assertEqual(SupportingDocument.objects.count(), 0)

    def test_photo_on_a_frozen_dossier_is_refused(self):
        d = self.create_declaration()
        self.advance_to_pending(d['uuid'])
        self.assertEqual(self.transition(self.admin, d['uuid'], 'VALIDATED', numero_acte='7', accept_incomplete=True).status_code, 200)
        _body, r = self.upload(self.agent, d['uuid'])
        self.assertEqual(r.data['result']['status'], 'rejected')
        self.assertEqual(SupportingDocument.objects.count(), 0)

    def test_photo_of_an_unknown_dossier_is_rejected(self):
        _body, r = self.upload(self.agent, str(uuid.uuid4()))
        self.assertEqual((r.data['result']['status'], r.data['result']['error']['code']), ('rejected', 'not_found'))

    def test_online_upload_still_works(self):
        d = self.create_declaration()
        r = self.client_for(self.agent).post('/api/documents/', {
            'declaration': d['uuid'], 'kind': 'PAPER_FORM', 'file': SimpleUploadedFile('fiche.jpg', JPEG)}, format='multipart')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.data['sha256'], hashlib.sha256(JPEG).hexdigest())


class PullAndHistoryTests(SyncTestCase):
    def test_pull_returns_own_dossiers_facilities_and_rules(self):
        mine = self.create_declaration()
        self.create_declaration(user=self.agent2)
        r = self.client_for(self.agent).get('/api/sync/pull/')
        self.assertEqual(r.status_code, 200)
        self.assertEqual([d['uuid'] for d in r.data['declarations']], [mine['uuid']])
        row = r.data['declarations'][0]
        self.assertEqual((row['child']['first_names'], row['sync_version'], row['is_archived']), ('Aminata', 1, False))
        self.assertEqual(r.data['hospitals'], [{'uuid': str(self.hospital.uuid), 'code': 'CMC', 'name': 'Clinique Médicale Centrale'}])
        self.assertIn('birth_date', r.data['rules']['required_for_transmission'])
        self.assertFalse(r.data['has_more'])
        self.assertEqual(self.client_for(self.nobody).get('/api/sync/pull/').status_code, 403)

    def test_pull_since_the_cursor_returns_only_what_changed(self):
        first = self.create_declaration()
        agent = self.client_for(self.agent)
        cursor = agent.get('/api/sync/pull/').data['cursor']
        self.assertEqual(agent.get('/api/sync/pull/', {'since': cursor}).data['declarations'], [])
        second = self.create_declaration()
        agent.patch(f'/api/declarations/{first["uuid"]}/', {'notes': 'modifié'}, format='json')
        r = agent.get('/api/sync/pull/', {'since': cursor})
        self.assertEqual({d['uuid'] for d in r.data['declarations']}, {first['uuid'], second['uuid']})
        # an archived dossier is announced so that the device removes its copy
        self.client_for(self.admin).delete(f'/api/declarations/{second["uuid"]}/')
        r = agent.get('/api/sync/pull/', {'since': r.data['cursor']})
        self.assertEqual([(d['uuid'], d['is_archived']) for d in r.data['declarations']], [(second['uuid'], True)])
        self.assertEqual(agent.get('/api/sync/pull/', {'since': 'hier'}).status_code, 400)

    @override_settings(SYNC_PULL_PAGE_SIZE=2)
    def test_pull_is_paginated(self):
        for _ in range(5):
            self.create_declaration()
        agent, seen, cursor = self.client_for(self.agent), [], None
        for _ in range(5):
            r = agent.get('/api/sync/pull/', {'since': cursor} if cursor else {})
            seen += [d['uuid'] for d in r.data['declarations']]
            cursor = r.data['cursor']
            if not r.data['has_more']:
                break
        self.assertEqual(len(set(seen)), 5)
        self.assertEqual(len(seen), 5)

    def test_updated_since_filter_of_the_declarations_list(self):
        self.create_declaration()
        agent = self.client_for(self.agent)
        later = (timezone.now() + datetime.timedelta(minutes=1)).isoformat()
        self.assertEqual(agent.get('/api/declarations/', {'updated_since': later}).data['count'], 0)
        earlier = (timezone.now() - datetime.timedelta(minutes=1)).isoformat()
        self.assertEqual(agent.get('/api/declarations/', {'updated_since': earlier}).data['count'], 1)

    def test_history_shows_own_operations_or_all_with_audit_view(self):
        self.pushed()
        self.pushed(user=self.agent2)
        self.assertEqual(self.client_for(self.agent).get('/api/sync/operations/').data['count'], 1)
        r = self.client_for(self.admin).get('/api/sync/operations/')
        self.assertEqual(r.data['count'], 2)
        self.assertEqual(r.data['results'][0]['status_label'], 'Appliquée')
        self.assertEqual(self.client_for(self.nobody).get('/api/sync/operations/').status_code, 403)

    def test_operations_cannot_be_deleted(self):
        from core.mixins import HardDeleteForbidden
        self.pushed()
        with self.assertRaises(HardDeleteForbidden):
            SyncOperation.objects.get().delete()
