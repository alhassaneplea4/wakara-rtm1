from django.contrib import admin

from .models import Acte, Delivery, NumberSequence, PrintLog


class ReadOnlyAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(Acte)
class ActeAdmin(ReadOnlyAdmin):
    list_display = ['numero_acte', 'annee', 'registre', 'declaration']

    def get_queryset(self, request):
        return Acte.all_objects.all()


admin.site.register(Delivery, ReadOnlyAdmin)
admin.site.register(PrintLog, ReadOnlyAdmin)
admin.site.register(NumberSequence, ReadOnlyAdmin)
