"""Backup / restore round-trip on SQLite (the engine used by the test-suite)."""
import sqlite3
import tempfile
import zipfile
from pathlib import Path
from unittest import skipUnless

from django.conf import settings
from django.core.management import call_command
from django.test import TransactionTestCase, override_settings

from declarations.models import Declaration

from .base import make_user


@skipUnless(settings.DATABASES['default']['ENGINE'].endswith('sqlite3'), 'SQLite only')
class BackupRestoreTests(TransactionTestCase):
    def test_backup_contains_a_consistent_database_and_documents(self):
        from django.core.management import call_command as cmd
        cmd('setup_initial_data', skip_admin=True, verbosity=0)
        with tempfile.TemporaryDirectory() as out, tempfile.TemporaryDirectory() as media:
            (Path(media) / 'declarations').mkdir()
            (Path(media) / 'declarations' / 'a.pdf').write_bytes(b'%PDF-test')
            # the in-memory test DB cannot be copied by file name: back up a real file DB
            db_file = Path(out) / 'live.sqlite3'
            con = sqlite3.connect(db_file)
            con.execute('create table t(x)'); con.execute("insert into t values (42)"); con.commit(); con.close()
            dbs = {'default': {**settings.DATABASES['default'], 'NAME': str(db_file)}}
            with override_settings(DATABASES=dbs, PRIVATE_MEDIA_ROOT=media):
                call_command('backup_wakara', output_dir=out, verbosity=0)
                archive = next(Path(out).glob('wakara_*.zip'))
                with zipfile.ZipFile(archive) as z:
                    self.assertIn('database.sqlite3', z.namelist())
                    self.assertIn('private_media/declarations/a.pdf', z.namelist())
                # simulate data loss, then restore
                db_file.write_bytes(b'corrupted')
                call_command('restore_wakara', str(archive), yes=True, verbosity=0)
                restored = sqlite3.connect(db_file)
                self.assertEqual(restored.execute('select x from t').fetchone(), (42,))
                restored.close()
                # the corrupted file was moved aside, not destroyed
                self.assertTrue(list(Path(out).glob('live.sqlite3.before-restore-*')))
