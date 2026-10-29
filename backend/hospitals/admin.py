from django.contrib import admin

from .models import Hospital


@admin.register(Hospital)
class HospitalAdmin(admin.ModelAdmin):
    list_display = ['code', 'name', 'facility_type', 'commune', 'is_active', 'is_archived']
    list_filter = ['facility_type', 'is_active', 'is_archived']
    search_fields = ['code', 'name']

    def get_queryset(self, request):
        return Hospital.all_objects.all()

    def has_delete_permission(self, request, obj=None):
        return False
