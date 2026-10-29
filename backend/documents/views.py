"""Supporting documents: validated upload, private storage, authenticated + audited download."""
import os

from django.conf import settings
from django.http import FileResponse
from rest_framework import mixins, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response

from audit import service as audit
from audit.models import AuditAction
from core.permissions import HasWakaraPermission
from core.workflow import Status
from declarations.models import Declaration
from declarations.services import can_edit_data, visible_declarations

from .models import SupportingDocument

ALLOWED_TYPES = {
    '.pdf': {'application/pdf'},
    '.jpg': {'image/jpeg'}, '.jpeg': {'image/jpeg'},
    '.png': {'image/png'},
}
MAGIC = {  # first bytes of each accepted format
    '.pdf': b'%PDF', '.jpg': b'\xff\xd8\xff', '.jpeg': b'\xff\xd8\xff', '.png': b'\x89PNG',
}


class DocumentSerializer(serializers.ModelSerializer):
    declaration = serializers.SlugRelatedField(slug_field='uuid', queryset=Declaration.objects.all())
    file = serializers.FileField(write_only=True)
    uploaded_by_name = serializers.SerializerMethodField()

    class Meta:
        model = SupportingDocument
        fields = ['uuid', 'declaration', 'kind', 'file', 'original_name', 'content_type', 'size',
                  'sha256', 'description', 'uploaded_by_name', 'created_at']
        read_only_fields = ['uuid', 'original_name', 'content_type', 'size', 'sha256', 'created_at']

    def get_uploaded_by_name(self, obj):
        u = obj.uploaded_by
        return (u.get_full_name() or u.username) if u else ''

    def validate_file(self, f):
        ext = os.path.splitext(f.name)[1].lower()
        if ext not in ALLOWED_TYPES:
            raise serializers.ValidationError("Format non autorisé (PDF, JPG ou PNG uniquement).")
        if f.size > settings.MAX_UPLOAD_SIZE:
            raise serializers.ValidationError(
                f"Fichier trop volumineux (max {settings.MAX_UPLOAD_SIZE // (1024 * 1024)} Mo).")
        head = f.read(8)
        f.seek(0)
        if not head.startswith(MAGIC[ext]):
            raise serializers.ValidationError("Le contenu du fichier ne correspond pas à son extension.")
        return f


class DocumentViewSet(mixins.CreateModelMixin, mixins.ListModelMixin, mixins.RetrieveModelMixin,
                      mixins.DestroyModelMixin, viewsets.GenericViewSet):
    queryset = SupportingDocument.objects.select_related('declaration', 'uploaded_by')
    serializer_class = DocumentSerializer
    permission_classes = [HasWakaraPermission]
    parser_classes = [MultiPartParser, FormParser]
    lookup_field = 'uuid'
    filterset_fields = ['kind']
    permission_map = {
        'list': 'document.view', 'retrieve': 'document.view', 'download': 'document.view',
        'create': 'document.upload', 'destroy': 'document.upload',
    }

    def get_queryset(self):
        qs = super().get_queryset().filter(
            declaration__in=visible_declarations(self.request.user))
        decl = self.request.query_params.get('declaration')
        return qs.filter(declaration__uuid=decl) if decl else qs

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        declaration = serializer.validated_data['declaration']
        if not visible_declarations(request.user).filter(pk=declaration.pk).exists():
            raise PermissionDenied("Dossier inaccessible.")
        if declaration.status in Status.FROZEN:
            raise PermissionDenied("Le dossier est figé : impossible d'ajouter une pièce.")
        upload = serializer.validated_data.pop('file')
        doc = SupportingDocument(
            **serializer.validated_data, original_name=os.path.basename(upload.name)[:255],
            content_type=next(iter(ALLOWED_TYPES[os.path.splitext(upload.name)[1].lower()])),
            size=upload.size, sha256=SupportingDocument.compute_sha256(upload),
            uploaded_by=request.user,
        )
        doc.file.save(upload.name, upload, save=False)
        doc.save()
        audit.log(AuditAction.DOCUMENT_UPLOADED, user=request.user, obj=doc,
                  changes={'declaration': declaration.reference, 'name': doc.original_name,
                           'sha256': doc.sha256})
        return Response(self.get_serializer(doc).data, status=status.HTTP_201_CREATED)

    def perform_destroy(self, instance):
        if instance.declaration.status in Status.FROZEN:
            raise PermissionDenied("Le dossier est figé : impossible d'archiver cette pièce.")
        instance.archive(user=self.request.user)
        audit.log(AuditAction.ARCHIVE, user=self.request.user, obj=instance)

    @action(detail=True, methods=['get'], url_path='download')
    def download(self, request, uuid=None):
        doc = self.get_object()
        audit.log(AuditAction.DOCUMENT_DOWNLOADED, user=request.user, obj=doc)
        response = FileResponse(doc.file.open('rb'), content_type=doc.content_type)
        response['Content-Disposition'] = f'inline; filename="{doc.uuid}{os.path.splitext(doc.original_name)[1]}"'
        response['X-Content-Type-Options'] = 'nosniff'
        response['Cache-Control'] = 'private, no-store'
        return response
