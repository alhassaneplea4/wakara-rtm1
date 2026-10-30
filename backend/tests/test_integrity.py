"""No physical deletion, append-only history, audit protection, private documents, statistics."""
import datetime
import shutil
import tempfile

from django.core.files.storage import FileSystemStorage
from django.core.files.uploadedfile import SimpleUploadedFile

from audit import service as audit
from audit.models import AuditLog
from core.mixins import HardDeleteForbidden
from declarations.models import Declaration, StatusHistory
from documents.models import SupportingDocument
from hospitals.models import Hospital

from .base import WakaraTestCase

PDF = b'%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF'


class NoPhysicalDeletionTests(WakaraTestCase):
    def test_model_and_queryset_deletes_are_blocked(self):
        d = self.create_declaration()
        obj = Declaration.objects.get(uuid=d['uuid'])
        with self.assertRaises(HardDeleteForbidden):
            obj.delete()
        with self.assertRaises(HardDeleteForbidden):
            Declaration.objects.all().delete()
        with self.assertRaises(HardDeleteForbidden):
            Declaration.all_objects.filter(pk=obj.pk).delete()
        with self.assertRaises(HardDeleteForbidden):
            self.hospital.delete()
        with self.assertRaises(HardDeleteForbidden):
            self.agent.delete()
        self.assertTrue(Declaration.all_objects.filter(pk=obj.pk).exists())

    def test_api_delete_archives_instead_of_deleting(self):
        d = self.create_declaration()
        r = self.client_for(self.admin).delete(f'/api/declarations/{d["uuid"]}/')
        self.assertEqual(r.status_code, 204)
        row = Declaration.all_objects.get(uuid=d['uuid'])
        self.assertTrue(row.is_archived)
        self.assertIsNotNone(row.archived_at)
        self.assertEqual(row.archived_by, self.admin)
        self.assertEqual(self.client_for(self.admin).get(f'/api/declarations/{d["uuid"]}/').status_code, 404)
        self.assertTrue(AuditLog.objects.filter(action='archive', object_id=d['uuid']).exists())

    def test_only_draft_or_rejected_can_be_archived_by_api(self):
        d = self.create_declaration()
        self.transition(self.agent, d['uuid'], 'TRANSMITTED')
        r = self.client_for(self.admin).delete(f'/api/declarations/{d["uuid"]}/')
        self.assertEqual(r.status_code, 403)
        self.assertFalse(Declaration.all_objects.get(uuid=d['uuid']).is_archived)

    def test_agent_cannot_archive(self):
        d = self.create_declaration()
        self.assertEqual(self.client_for(self.agent).delete(f'/api/declarations/{d["uuid"]}/').status_code, 403)

    def test_hospital_with_declarations_is_deactivated_not_deleted(self):
        self.create_declaration()
        c = self.client_for(self.admin)
        r = c.post(f'/api/hospitals/{self.hospital.uuid}/deactivate/', {'reason': 'Fermé'}, format='json')
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.data['is_active'])
        c.delete(f'/api/hospitals/{self.hospital.uuid}/')
        h = Hospital.all_objects.get(pk=self.hospital.pk)
        self.assertTrue(h.is_archived)
        self.assertEqual(Declaration.objects.filter(hospital=h).count(), 1)  # history preserved
        self.assertEqual(self.client_for(self.agent).get('/api/declarations/').data['count'], 1)

    def test_archived_rows_can_be_restored_by_authorised_users_only(self):
        c = self.client_for(self.admin)
        c.delete(f'/api/hospitals/{self.hospital.uuid}/')
        self.assertEqual(c.get('/api/hospitals/').data['count'], 0)
        self.assertEqual(c.get('/api/hospitals/?archived=true').data['count'], 1)
        self.assertEqual(c.post(f'/api/hospitals/{self.hospital.uuid}/restore/').status_code, 200)
        self.assertEqual(c.get('/api/hospitals/').data['count'], 1)


class AppendOnlyTests(WakaraTestCase):
    def test_audit_log_cannot_be_modified_or_deleted(self):
        entry = audit.log('create', user=self.admin, object_type='X')
        entry.reason = 'tampered'
        with self.assertRaises(HardDeleteForbidden):
            entry.save()
        with self.assertRaises(HardDeleteForbidden):
            entry.delete()
        with self.assertRaises(HardDeleteForbidden):
            AuditLog.objects.all().delete()
        with self.assertRaises(HardDeleteForbidden):
            AuditLog.objects.all().update(reason='x')

    def test_status_history_is_append_only(self):
        d = self.create_declaration()
        h = StatusHistory.objects.filter(declaration__uuid=d['uuid']).first()
        h.reason = 'tampered'
        with self.assertRaises(HardDeleteForbidden):
            h.save()
        with self.assertRaises(HardDeleteForbidden):
            StatusHistory.objects.all().delete()

    def test_audit_api_is_read_only(self):
        c = self.client_for(self.admin)
        entry = AuditLog.objects.first() or audit.log('create', user=self.admin)
        self.assertIn(c.post('/api/audit/', {}, format='json').status_code, (403, 405))
        self.assertIn(c.delete(f'/api/audit/{entry.pk}/').status_code, (403, 405))
        self.assertIn(c.patch(f'/api/audit/{entry.pk}/', {'reason': 'x'}, format='json').status_code, (403, 405))
        self.assertTrue(AuditLog.objects.filter(pk=entry.pk, reason='').exists())


class AuditTraceabilityTests(WakaraTestCase):
    def test_created_by_and_updated_by_are_server_side(self):
        c = self.client_for(self.admin)
        r = c.post('/api/hospitals/', {'code': 'hnd', 'name': 'Hôpital Donka', 'created_by': self.agent.pk}, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        h = Hospital.objects.get(code='HND')
        self.assertEqual(h.created_by, self.admin)
        c.patch(f'/api/hospitals/{h.uuid}/', {'name': 'Donka'}, format='json')
        h.refresh_from_db()
        self.assertEqual(h.updated_by, self.admin)
        log = AuditLog.objects.filter(action='update', object_id=str(h.uuid)).latest('id')
        self.assertEqual(log.changes['name'], {'from': 'Hôpital Donka', 'to': 'Donka'})

    def test_audit_consultation_and_export_are_themselves_audited(self):
        c = self.client_for(self.admin)
        c.get('/api/audit/')
        self.assertTrue(AuditLog.objects.filter(action='audit_viewed', username='admin').exists())
        c.get('/api/audit/export/')
        self.assertTrue(AuditLog.objects.filter(action='export', object_type='AuditLog').exists())
        self.create_declaration()
        self.client_for(self.admin).get('/api/declarations/export/')
        self.assertTrue(AuditLog.objects.filter(action='export', object_type='Declaration').exists())

    def test_export_restricted_to_authorised_profiles(self):
        self.assertEqual(self.client_for(self.agent).get('/api/declarations/export/').status_code, 403)
        self.assertEqual(self.client_for(self.secretary).get('/api/declarations/export/').status_code, 403)
        self.assertEqual(self.client_for(self.secretary).get('/api/audit/export/').status_code, 403)

    def test_user_management_events_logged(self):
        c = self.client_for(self.admin)
        r = c.post('/api/users/', {'username': 'newone', 'password': 'Sup3r-Secret-Pass!'}, format='json')
        c.post(f'/api/users/{r.data["uuid"]}/deactivate/', {'reason': 'Départ'}, format='json')
        c.post(f'/api/users/{r.data["uuid"]}/activate/')
        actions = list(AuditLog.objects.filter(object_id=r.data['uuid']).values_list('action', flat=True))
        for a in ('create', 'account_deactivated', 'account_activated'):
            self.assertIn(a, actions)


class DocumentTests(WakaraTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._tmp = tempfile.mkdtemp()
        cls._field = SupportingDocument._meta.get_field('file')
        cls._old_storage = cls._field.storage
        cls._field.storage = FileSystemStorage(location=cls._tmp)

    @classmethod
    def tearDownClass(cls):
        cls._field.storage = cls._old_storage
        shutil.rmtree(cls._tmp, ignore_errors=True)
        super().tearDownClass()

    def upload(self, user, declaration_uuid, name='scan.pdf', content=PDF, kind='HOSPITAL_FORM'):
        return self.client_for(user).post('/api/documents/', {
            'declaration': declaration_uuid, 'kind': kind,
            'file': SimpleUploadedFile(name, content)}, format='multipart')

    def test_upload_then_authenticated_audited_download(self):
        d = self.create_declaration()
        r = self.upload(self.agent, d['uuid'])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(len(r.data['sha256']), 64)
        self.assertNotIn('file', r.data)  # no storage path leaks
        url = f'/api/documents/{r.data["uuid"]}/download/'
        resp = self.client_for(self.agent).get(url)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(b''.join(resp.streaming_content), PDF)
        self.assertEqual(resp['Cache-Control'], 'private, no-store')
        self.assertTrue(AuditLog.objects.filter(action='document_downloaded').exists())

    def test_download_requires_authentication_and_visibility(self):
        d = self.create_declaration(self.agent)
        r = self.upload(self.agent, d['uuid'])
        url = f'/api/documents/{r.data["uuid"]}/download/'
        from rest_framework.test import APIClient
        self.assertEqual(APIClient().get(url).status_code, 401)
        self.assertEqual(self.client_for(self.agent2).get(url).status_code, 404)  # not their dossier
        self.assertEqual(self.client_for(self.nobody).get(url).status_code, 403)
        self.assertEqual(self.client_for(self.secretary).get(url).status_code, 200)

    def test_dangerous_or_mismatched_files_rejected(self):
        d = self.create_declaration()
        self.assertEqual(self.upload(self.agent, d['uuid'], 'run.exe', b'MZ\x90').status_code, 400)
        self.assertEqual(self.upload(self.agent, d['uuid'], 'fake.pdf', b'<script>alert(1)</script>').status_code, 400)
        self.assertEqual(self.upload(self.agent, d['uuid'], 'big.pdf', PDF + b'0' * (11 * 1024 * 1024)).status_code, 400)
        self.assertEqual(SupportingDocument.objects.count(), 0)

    def test_cannot_attach_to_someone_elses_dossier_or_frozen_dossier(self):
        d = self.create_declaration(self.agent)
        self.assertEqual(self.upload(self.agent2, d['uuid']).status_code, 403)
        self.advance_to_pending(d['uuid'])
        self.transition(self.admin, d['uuid'], 'REJECTED', reason='Doublon')
        self.assertEqual(self.upload(self.secretary, d['uuid']).status_code, 403)

    def test_paper_form_photo_is_attached_listed_and_archived_by_the_agent(self):
        jpeg = b'\xff\xd8\xff\xe0' + b'0' * 64
        d = self.create_declaration(self.agent)
        r = self.upload(self.agent, d['uuid'], 'IMG_0001.jpg', jpeg, kind='PAPER_FORM')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.data['kind'], 'PAPER_FORM')
        self.assertEqual(r.data['content_type'], 'image/jpeg')
        # a second page, then both are listed for the dossier (agent and secretary), filtered by kind
        self.upload(self.agent, d['uuid'], 'verso.png', b'\x89PNG' + b'0' * 64, kind='PAPER_FORM')
        self.upload(self.agent, d['uuid'], 'cni.pdf', PDF, kind='PARENT_ID')
        for user in (self.agent, self.secretary):
            res = self.client_for(user).get(f'/api/documents/?declaration={d["uuid"]}&kind=PAPER_FORM')
            self.assertEqual(res.data['count'], 2)
        self.assertEqual(self.client_for(self.agent2).get(f'/api/documents/?declaration={d["uuid"]}').data['count'], 0)
        # a wrongly taken photo can be archived while the dossier is editable, never physically deleted
        self.assertEqual(self.client_for(self.agent).delete(f'/api/documents/{r.data["uuid"]}/').status_code, 204)
        self.assertEqual(self.client_for(self.agent).get(f'/api/documents/?declaration={d["uuid"]}&kind=PAPER_FORM').data['count'], 1)
        self.assertTrue(SupportingDocument.all_objects.filter(uuid=r.data['uuid']).exists())

    def test_stored_name_is_random_and_not_publicly_routable(self):
        d = self.create_declaration()
        r = self.upload(self.agent, d['uuid'], 'passeport_aminata.pdf')
        doc = SupportingDocument.objects.get(uuid=r.data['uuid'])
        self.assertNotIn('passeport', doc.file.name)
        from django.conf import settings
        self.assertFalse(hasattr(settings, 'MEDIA_URL') and settings.MEDIA_URL and 'media' in str(settings.MEDIA_URL))


class StatisticsTests(WakaraTestCase):
    def setUp(self):
        super().setUp()
        self.today = datetime.date.today()
        # 2 drafts, 1 in progress, 1 pending, 1 validated, 1 rejected
        self.create_declaration()
        self.create_declaration(child={'first_names': 'B', 'last_name': 'B', 'gender': 'M'})
        c = self.create_declaration(child={'first_names': 'C', 'last_name': 'C', 'gender': 'M'})
        self.transition(self.agent, c['uuid'], 'TRANSMITTED')
        p = self.create_declaration()
        self.advance_to_pending(p['uuid'])
        v = self.create_declaration()
        self.advance_to_pending(v['uuid'])
        self.transition(self.admin, v['uuid'], 'VALIDATED', annee=2026, registre='R1', numero_acte='1')
        r = self.create_declaration()
        self.advance_to_pending(r['uuid'])
        self.transition(self.admin, r['uuid'], 'REJECTED', reason='Doublon')

    def test_kpis_match_the_database(self):
        k = self.client_for(self.admin).get('/api/stats/dashboard/').data['kpis']
        self.assertEqual(k, {
            'births_declared': 6, 'declarations_received': 4, 'in_progress': 1,
            'pending_validation': 1, 'validated': 1, 'rejected': 1, 'delivered': 0})

    def test_breakdowns_and_monthly_series(self):
        data = self.client_for(self.admin).get('/api/stats/dashboard/').data
        self.assertEqual(sum(h['count'] for h in data['by_hospital']), 6)
        self.assertEqual(sum(s['count'] for s in data['by_status']), 6)
        month = data['monthly'][self.today.month - 1]
        self.assertEqual((month['received'], month['validated']), (4, 1))
        self.assertEqual(data['by_gender']['F'] + data['by_gender']['M'], 6)
        self.assertIsNotNone(data['delays']['avg_days_transmission_to_validation'])

    def test_filters(self):
        c = self.client_for(self.admin)
        self.assertEqual(c.get('/api/stats/dashboard/?status=DRAFT').data['kpis']['births_declared'], 2)
        self.assertEqual(c.get(f'/api/stats/dashboard/?year={self.today.year - 1}').data['kpis']['births_declared'], 0)
        other = Hospital.objects.create(code='OTH', name='Autre')
        self.assertEqual(c.get(f'/api/stats/dashboard/?hospital={other.uuid}').data['kpis']['births_declared'], 0)

    def test_stats_forbidden_without_permission_and_scoped_by_visibility(self):
        self.assertEqual(self.client_for(self.agent).get('/api/stats/dashboard/').status_code, 403)
        sec = self.client_for(self.secretary).get('/api/stats/dashboard/').data
        self.assertEqual(sec['kpis']['births_declared'], 6)

    def test_inbox_counts_work_waiting_for_each_role(self):
        adm = self.client_for(self.admin).get('/api/inbox/').data
        self.assertEqual({i['code']: i['count'] for i in adm['items']}['to_validate'], 1)
        sec = self.client_for(self.secretary).get('/api/inbox/').data
        self.assertEqual({i['code']: i['count'] for i in sec['items']}['to_complete'], 1)
