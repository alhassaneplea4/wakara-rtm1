"""Supporting documents (scans of hospital forms, ID copies…) in PRIVATE storage."""
import hashlib
import os
import uuid as uuid_lib

from django.conf import settings
from django.core.files.storage import storages
from django.db import models

from core.mixins import BaseModel

def private_storage():
    """Private storage configured in settings.STORAGES['private'] (local folder or private S3 bucket)."""
    return storages['private']


def upload_path(instance, filename):
    # Random name on disk: the original name is kept in the DB only.
    ext = os.path.splitext(filename)[1].lower()
    return f"declarations/{instance.declaration.uuid}/{uuid_lib.uuid4().hex}{ext}"


class SupportingDocument(BaseModel):
    class Kind(models.TextChoices):
        PAPER_FORM = 'PAPER_FORM', "Fiche de déclaration physique (photo / scan)"
        HOSPITAL_FORM = 'HOSPITAL_FORM', "Déclaration hospitalière (scan)"
        PARENT_ID = 'PARENT_ID', "Pièce d'identité d'un parent"
        DECLARANT_ID = 'DECLARANT_ID', "Pièce d'identité du déclarant"
        OTHER = 'OTHER', 'Autre pièce'

    declaration = models.ForeignKey(
        'declarations.Declaration', on_delete=models.PROTECT, related_name='documents')
    kind = models.CharField("Type", max_length=20, choices=Kind.choices, default=Kind.OTHER)
    file = models.FileField(storage=private_storage, upload_to=upload_path, max_length=255)
    original_name = models.CharField("Nom d'origine", max_length=255)
    content_type = models.CharField("Type MIME", max_length=100)
    size = models.PositiveIntegerField("Taille (octets)")
    sha256 = models.CharField("Empreinte SHA-256", max_length=64)
    description = models.CharField("Description", max_length=255, blank=True)
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='+')

    class Meta(BaseModel.Meta):
        verbose_name = "Pièce justificative"
        verbose_name_plural = "Pièces justificatives"

    def __str__(self):
        return self.original_name

    @staticmethod
    def compute_sha256(uploaded) -> str:
        digest = hashlib.sha256()
        for chunk in uploaded.chunks():
            digest.update(chunk)
        uploaded.seek(0)
        return digest.hexdigest()
