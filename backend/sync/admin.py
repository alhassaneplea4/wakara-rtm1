from django.contrib import admin

from .models import Device, SyncOperation


class ReadOnlyAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(Device)
class DeviceAdmin(ReadOnlyAdmin):
    list_display = ['label', 'user', 'device_id', 'last_sync_at', 'is_revoked']
    list_filter = ['is_revoked']
    search_fields = ['label', 'user__username', 'device_id']


@admin.register(SyncOperation)
class SyncOperationAdmin(ReadOnlyAdmin):
    list_display = ['received_at', 'user', 'op_type', 'status', 'entity_uuid', 'date_anomaly']
    list_filter = ['status', 'op_type']
    search_fields = ['op_id', 'entity_uuid', 'user__username']
