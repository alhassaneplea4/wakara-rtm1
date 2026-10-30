"""Database-backed private storage (hosts without a persistent disk)."""
from django.core.files.base import ContentFile
from django.core.files.uploadedfile import SimpleUploadedFile

from documents.models import StoredFile, SupportingDocument
from documents.storage import DatabaseStorage

from .base import WakaraTestCase

JPEG = b'\xff\xd8\xff\xe0' + b'0' * 128


class DatabaseStorageTests(WakaraTestCase):
    def setUp(self):
        super().setUp()
        self._field = SupportingDocument._meta.get_field('file')
        self._old = self._field.storage
        self._field.storage = DatabaseStorage()
        self.addCleanup(setattr, self._field, 'storage', self._old)

    def test_storage_roundtrip(self):
        s = DatabaseStorage()
        name = s.save('declarations/x/abc.jpg', ContentFile(JPEG))
        self.assertTrue(s.exists(name))
        self.assertEqual(s.size(name), len(JPEG))
        self.assertEqual(s.open(name).read(), JPEG)
        with self.assertRaises(ValueError):
            s.url(name)  # never a public URL
        s.delete(name)
        self.assertFalse(s.exists(name))

    def test_document_upload_and_authenticated_download_through_the_database(self):
        d = self.create_declaration(self.agent)
        r = self.client_for(self.agent).post('/api/documents/', {
            'declaration': d['uuid'], 'kind': 'PAPER_FORM', 'file': SimpleUploadedFile('photo.jpg', JPEG)},
            format='multipart')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(StoredFile.objects.count(), 1)
        resp = self.client_for(self.secretary).get(f'/api/documents/{r.data["uuid"]}/download/')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(b''.join(resp.streaming_content), JPEG)
        self.assertEqual(self.client_for(self.agent2).get(f'/api/documents/{r.data["uuid"]}/download/').status_code, 404)
