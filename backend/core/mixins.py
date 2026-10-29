"""
Shared model mixins for all Wakara apps.

Traceability convention (documented in docs/architecture.md):
  - created_at / updated_at      set by the server (auto_now*), never by the client
  - created_by / updated_by      set by the views through ``AuditedModelViewSet``
  - is_archived / archived_*     logical deletion. Business rows are NEVER removed.
  - change_reason                lives in the audit log, not on every table
"""
import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone


class HardDeleteForbidden(Exception):
    """Raised when code tries to physically delete a business row."""


class BusinessQuerySet(models.QuerySet):
    def delete(self):
        raise HardDeleteForbidden(
            "Suppression physique interdite : utilisez l'archivage logique."
        )

    def archived(self):
        return self.filter(is_archived=True)


class ActiveManager(models.Manager.from_queryset(BusinessQuerySet)):
    """Default manager: excludes archived rows."""

    def get_queryset(self):
        return super().get_queryset().filter(is_archived=False)


class AllObjectsManager(models.Manager.from_queryset(BusinessQuerySet)):
    """Manager that includes archived rows."""


class TimeStampedMixin(models.Model):
    created_at = models.DateTimeField("Date de création", auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField("Date de modification", auto_now=True)

    class Meta:
        abstract = True


class ArchiveMixin(models.Model):
    """Logical deletion — archived rows are hidden but preserved."""
    is_archived = models.BooleanField("Archivé", default=False, db_index=True)
    archived_at = models.DateTimeField("Date d'archivage", null=True, blank=True)
    archived_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='+',
        verbose_name="Archivé par",
    )

    objects = ActiveManager()
    all_objects = AllObjectsManager()

    class Meta:
        abstract = True
        base_manager_name = 'all_objects'

    def delete(self, *args, **kwargs):
        raise HardDeleteForbidden(
            "Suppression physique interdite : utilisez l'archivage logique."
        )

    def archive(self, user=None):
        self.is_archived = True
        self.archived_at = timezone.now()
        self.archived_by = user
        self.save(update_fields=['is_archived', 'archived_at', 'archived_by', 'updated_at'])

    def unarchive(self):
        self.is_archived = False
        self.archived_at = None
        self.archived_by = None
        self.save(update_fields=['is_archived', 'archived_at', 'archived_by', 'updated_at'])


class UUIDMixin(models.Model):
    """UUID as public identifier; the integer pk is never exposed by the API."""
    uuid = models.UUIDField(default=uuid.uuid4, editable=False, unique=True, db_index=True)

    class Meta:
        abstract = True


class CreatedByMixin(models.Model):
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='+',
        verbose_name="Créé par",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='+',
        verbose_name="Modifié par",
    )

    class Meta:
        abstract = True


class BaseModel(UUIDMixin, TimeStampedMixin, ArchiveMixin):
    """UUID + timestamps + logical archive."""

    class Meta:
        abstract = True
        base_manager_name = 'all_objects'
        ordering = ['-created_at']


class NoHardDeleteMixin(models.Model):
    """For tables without an archive flag (users, roles): deactivate, never delete."""

    class Meta:
        abstract = True

    def delete(self, *args, **kwargs):
        raise HardDeleteForbidden("Suppression physique interdite : désactivez l'élément.")


class AppendOnlyQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise HardDeleteForbidden("Cette table est en ajout seul : modification interdite.")

    def bulk_update(self, objs, fields, batch_size=None):
        raise HardDeleteForbidden("Cette table est en ajout seul : modification interdite.")

    def delete(self):
        raise HardDeleteForbidden("Cette table est en ajout seul : suppression interdite.")


class AppendOnlyModel(models.Model):
    """Rows can be inserted but never modified or deleted (audit, history)."""

    objects = AppendOnlyQuerySet.as_manager()

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        if self.pk is not None and not self._state.adding:
            raise HardDeleteForbidden("Cette table est en ajout seul : modification interdite.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise HardDeleteForbidden("Cette table est en ajout seul : suppression interdite.")
