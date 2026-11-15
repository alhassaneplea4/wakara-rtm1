"""Read-only admin: investigation records are never edited or deleted from the back office."""
from django.contrib import admin

from .models import (
    BirthIdentity, DuplicateCase, DuplicateCounter, DuplicateCheck, DuplicateDecision, DuplicateEvidence,
    DuplicateMatch, DuplicateReviewHistory,
)


class ReadOnlyAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


for model in (BirthIdentity, DuplicateCase, DuplicateCounter, DuplicateCheck, DuplicateDecision,
              DuplicateEvidence, DuplicateMatch, DuplicateReviewHistory):
    admin.site.register(model, ReadOnlyAdmin)
