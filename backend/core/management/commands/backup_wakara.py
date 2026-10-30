"""
Backup of the database and the private documents into one timestamped zip.

    python manage.py backup_wakara [--output-dir backups] [--keep 30]

SQLite  : consistent online copy through the sqlite3 backup API.
PostgreSQL : runs `pg_dump -F c` (the client tools must be installed; the password is
             passed through PGPASSWORD, never on the command line).
Restore : see `restore_wakara` and docs/backup-restore.md.
"""
import os
import shutil
import sqlite3
import subprocess
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Sauvegarde la base de données et les pièces justificatives (archive zip)."

    def add_arguments(self, parser):
        parser.add_argument('--output-dir', default=str(settings.BASE_DIR / 'backups'))
        parser.add_argument('--keep', type=int, default=30, help="Nombre d'archives conservées.")

    def handle(self, *args, **options):
        out_dir = Path(options['output_dir'])
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        archive = out_dir / f'wakara_{stamp}.zip'
        db = settings.DATABASES['default']

        with tempfile.TemporaryDirectory() as tmp:
            if db['ENGINE'].endswith('sqlite3'):
                dump = Path(tmp) / 'database.sqlite3'
                src = sqlite3.connect(db['NAME'])
                dst = sqlite3.connect(dump)
                with dst:
                    src.backup(dst)
                src.close()
                dst.close()
            else:
                dump = Path(tmp) / 'database.dump'
                env = {**os.environ, 'PGPASSWORD': db.get('PASSWORD', '')}
                cmd = ['pg_dump', '-h', db.get('HOST', 'localhost'), '-p', str(db.get('PORT', '5432')),
                       '-U', db['USER'], '-F', 'c', '-f', str(dump), db['NAME']]
                try:
                    subprocess.run(cmd, check=True, env=env)
                except (OSError, subprocess.CalledProcessError) as exc:
                    raise CommandError(f"pg_dump a échoué : {exc}")

            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
                z.write(dump, dump.name)
                root = Path(settings.PRIVATE_MEDIA_ROOT)
                if settings.DOCUMENTS_S3_BUCKET:
                    self.stdout.write(self.style.WARNING(
                        "Documents stockés dans un bucket S3 : non inclus dans cette sauvegarde "
                        "(activez le versionnement / la réplication du bucket)."))
                elif root.exists():
                    for f in root.rglob('*'):
                        if f.is_file():
                            z.write(f, Path('private_media') / f.relative_to(root))

        backups = sorted(out_dir.glob('wakara_*.zip'))
        for old in backups[:-options['keep']] if options['keep'] > 0 else []:
            old.unlink()
        self.stdout.write(self.style.SUCCESS(f"Sauvegarde créée : {archive}"))
