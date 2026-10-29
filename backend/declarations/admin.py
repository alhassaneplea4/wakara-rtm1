from django.contrib import admin

from .models import Child, Declarant, Declaration, Parent, StatusHistory


class ReadOnlyInline(admin.TabularInline):
    extra = 0
    can_delete = False

    def has_add_permission(self, request, obj=None):
        return False


class StatusHistoryInline(ReadOnlyInline):
    model = StatusHistory
    readonly_fields = ['from_status', 'to_status', 'changed_by', 'changed_at', 'reason']


@admin.register(Declaration)
class DeclarationAdmin(admin.ModelAdmin):
    """Read-only technical view: the workflow is only driven through the application."""
    list_display = ['reference', 'status', 'hospital', 'birth_date', 'created_at', 'is_archived']
    list_filter = ['status', 'hospital', 'is_archived']
    search_fields = ['reference']
    inlines = [StatusHistoryInline]

    def get_queryset(self, request):
        return Declaration.all_objects.all()

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
