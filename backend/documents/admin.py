from django.contrib import admin

from .models import SupportingDocument


@admin.register(SupportingDocument)
class SupportingDocumentAdmin(admin.ModelAdmin):
    list_display = ['original_name', 'declaration', 'kind', 'size', 'created_at']
    readonly_fields = [f.name for f in SupportingDocument._meta.fields]

    def get_queryset(self, request):
        return SupportingDocument.all_objects.all()

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
