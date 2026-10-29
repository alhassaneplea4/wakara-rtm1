"""
Restore an archive produced by `backup_wakara`.

    python manage.py restore_wakara backups/wakara_YYYYMMDD_HHMMSS.zip --yes

STOP the application first. The current database file / private documents are moved
aside (`*.before-restore`), never deleted. For PostgreSQL the dump is extracted and
`pg_restore` must be run by an operator (command printed), because it needs DBA rights.
"""
import shutil
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Restaure une sauvegarde Wakara (application arrêtée)."

    def add_arguments(self, parser):
        parser.add_argument('archive')
        parser.add_argument('--yes', action='store_true', help="Confirme l'opération.")

    def handle(self, *args, **options):
        archive = Path(options['archive'])
        if not archive.is_file():
            raise CommandError(f"Archive introuvable : {archive}")
        if not options['yes']:
            raise CommandError("Ajoutez --yes pour confirmer la restauration.")
        db = settings.DATABASES['default']
        stamp = datetime.now().strftime('%Y%m%d_%H%M%S')

        with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(archive) as z:
            names = z.namelist()
            z.extractall(tmp)
            tmp = Path(tmp)
            if db['ENGINE'].endswith('sqlite3'):
                if 'database.sqlite3' not in names:
                    raise CommandError("Cette archive ne contient pas de base SQLite.")
                target = Path(db['NAME'])
                if target.exists():
                    shutil.move(target, f"{target}.before-restore-{stamp}")
                shutil.copy2(tmp / 'database.sqlite3', target)
            else:
                dump_dest = Path(settings.BASE_DIR) / f'restore_{stamp}.dump'
                shutil.copy2(tmp / 'database.dump', dump_dest)
                self.stdout.write(self.style.WARNING(
                    f"Dump extrait : {dump_dest}\nExécutez : pg_restore -h {db.get('HOST')} -U {db['USER']} "
                    f"-d {db['NAME']} --clean --if-exists {dump_dest}"))

            media = tmp / 'private_media'
            root = Path(settings.PRIVATE_MEDIA_ROOT)
            if media.exists():
                if root.exists():
                    shutil.move(root, f"{root}.before-restore-{stamp}")
                shutil.copytree(media, root)
        self.stdout.write(self.style.SUCCESS("Restauration terminée. Lancez `manage.py check` puis redémarrez l'application."))
