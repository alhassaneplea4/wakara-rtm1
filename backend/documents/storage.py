"""Private file storage inside the database (PostgreSQL), for hosts with no persistent disk (Vercel…).

Files are never exposed by URL: they are read back by name through the authenticated, audited download
endpoint, and they are included in the regular database backups.
"""
from django.core.files.base import ContentFile
from django.core.files.storage import Storage
from django.utils.deconstruct import deconstructible


@deconstructible
class DatabaseStorage(Storage):
    @staticmethod
    def _model():
        from .models import StoredFile  # imported lazily: the app registry is not ready when settings load
        return StoredFile

    def _open(self, name, mode='rb'):
        row = self._model().objects.get(name=name)
        return ContentFile(bytes(row.content), name=name)

    def _save(self, name, content):
        data = b''.join(content.chunks())
        self._model().objects.update_or_create(name=name, defaults={'content': data, 'size': len(data)})
        return name

    def exists(self, name):
        return self._model().objects.filter(name=name).exists()

    def delete(self, name):
        self._model().objects.filter(name=name).delete()

    def size(self, name):
        return self._model().objects.values_list('size', flat=True).get(name=name)

    def url(self, name):
        raise ValueError("Les documents n'ont pas d'URL publique : utilisez le téléchargement authentifié.")
