"""Validation and storage of a supporting document, shared by the API and the offline synchronisation."""
import os

from django.conf import settings
from django.core.exceptions import PermissionDenied, ValidationError

from audit import service as audit
from audit.models import AuditAction
from core.workflow import Status
from declarations.services import visible_declarations

from .models import SupportingDocument

ALLOWED_TYPES = {
    '.pdf': {'application/pdf'},
    '.jpg': {'image/jpeg'}, '.jpeg': {'image/jpeg'},
    '.png': {'image/png'},
}
MAGIC = {  # first bytes of each accepted format
    '.pdf': b'%PDF', '.jpg': b'\xff\xd8\xff', '.jpeg': b'\xff\xd8\xff', '.png': b'\x89PNG',
}


def upload_error(f):
    """Message explaining why the uploaded file is refused, or None when it is acceptable."""
    ext = os.path.splitext(f.name)[1].lower()
    if ext not in ALLOWED_TYPES:
        return "Format non autorisé (PDF, JPG ou PNG uniquement)."
    if f.size > settings.MAX_UPLOAD_SIZE:
        return f"Fichier trop volumineux (max {settings.MAX_UPLOAD_SIZE // (1024 * 1024)} Mo)."
    head = f.read(8)
    f.seek(0)
    if not head.startswith(MAGIC[ext]):
        return "Le contenu du fichier ne correspond pas à son extension."
    return None


def store_document(user, declaration, upload, *, kind, description='', uuid=None, expected_sha256=None):
    """
    Attach ``upload`` to ``declaration``. Raises PermissionDenied (dossier not visible / frozen) or
    ValidationError (file content different from the fingerprint computed on the device).

    ``uuid`` and ``expected_sha256`` are only given by the offline synchronisation: the identifier generated
    on the device makes the upload idempotent, the fingerprint proves the file arrived intact.
    """
    if not visible_declarations(user).filter(pk=declaration.pk).exists():
        raise PermissionDenied("Dossier inaccessible.")
    if declaration.status in Status.FROZEN:
        raise PermissionDenied("Le dossier est figé : impossible d'ajouter une pièce.")
    sha256 = SupportingDocument.compute_sha256(upload)
    if expected_sha256 and expected_sha256.lower() != sha256:
        raise ValidationError(
            "Le fichier reçu ne correspond pas à l'empreinte calculée sur l'appareil.", code='checksum')
    extra = {'uuid': uuid} if uuid is not None else {}
    doc = SupportingDocument(
        declaration=declaration, kind=kind, description=description,
        original_name=os.path.basename(upload.name)[:255],
        content_type=next(iter(ALLOWED_TYPES[os.path.splitext(upload.name)[1].lower()])),
        size=upload.size, sha256=sha256, uploaded_by=user, **extra,
    )
    doc.file.save(upload.name, upload, save=False)
    doc.save()
    audit.log(AuditAction.DOCUMENT_UPLOADED, user=user, obj=doc,
              changes={'declaration': declaration.reference, 'name': doc.original_name,
                       'sha256': doc.sha256})
    return doc
