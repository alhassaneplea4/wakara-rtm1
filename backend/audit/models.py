"""Append-only audit log."""
from django.conf import settings
from django.db import models

from core.mixins import AppendOnlyModel


class AuditAction:
    CREATE = 'create'
    UPDATE = 'update'
    ARCHIVE = 'archive'
    RESTORE = 'restore'
    TRANSITION = 'transition'
    TRANSMIT = 'transmit'
    RETURN = 'return'
    REJECT = 'reject'
    VALIDATE = 'validate'
    NUMBER_ASSIGNED = 'number_assigned'
    PRINT = 'print'
    DELIVER = 'deliver'
    LOGIN = 'login'
    LOGIN_FAILED = 'login_failed'
    LOGOUT = 'logout'
    PASSWORD_CHANGED = 'password_changed'
    PASSWORD_RESET = 'password_reset'
    ACCOUNT_ACTIVATED = 'account_activated'
    ACCOUNT_DEACTIVATED = 'account_deactivated'
    ROLE_ASSIGNED = 'role_assigned'
    ROLE_REMOVED = 'role_removed'
    PERMISSION_CHANGED = 'permission_changed'
    DOCUMENT_UPLOADED = 'document_uploaded'
    DOCUMENT_DOWNLOADED = 'document_downloaded'
    EXPORT = 'export'
    AUDIT_VIEWED = 'audit_viewed'

    CHOICES = [(v, v) for k, v in vars().items() if k.isupper()]


class AuditLog(AppendOnlyModel):
    created_at = models.DateTimeField("Date", auto_now_add=True, db_index=True)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='+', verbose_name="Utilisateur",
    )
    username = models.CharField("Identifiant (instantané)", max_length=150, blank=True)
    action = models.CharField("Action", max_length=40, choices=AuditAction.CHOICES, db_index=True)
    object_type = models.CharField("Type d'objet", max_length=60, blank=True, db_index=True)
    object_id = models.CharField("Identifiant de l'objet", max_length=64, blank=True)
    object_repr = models.CharField("Objet", max_length=255, blank=True)
    changes = models.JSONField("Modifications", default=dict, blank=True)
    reason = models.TextField("Motif", blank=True)
    ip_address = models.GenericIPAddressField("Adresse IP", null=True, blank=True)
    user_agent = models.CharField("Agent utilisateur", max_length=255, blank=True)

    class Meta:
        verbose_name = "Événement d'audit"
        verbose_name_plural = "Journal d'audit"
        ordering = ['-created_at', '-id']
        indexes = [models.Index(fields=['object_type', 'object_id'])]

    def __str__(self):
        return f"{self.created_at:%Y-%m-%d %H:%M} {self.username} {self.action} {self.object_type}"
