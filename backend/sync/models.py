"""
Offline mode: devices of the collection agents and the operations they synchronise.

A device prepares operations without connection (create / edit / transmit a declaration, attach a photo of
the paper form) and pushes them later. Each operation carries an identifier generated on the device
(``op_id``): replaying it never creates a duplicate. PostgreSQL stays the single reference.
"""
from django.conf import settings
from django.db import models

from core.mixins import NoHardDeleteMixin


class Device(NoHardDeleteMixin, models.Model):
    """One browser / phone used by one agent. Revoking it makes the server refuse its synchronisations."""
    device_id = models.UUIDField("Identifiant de l'appareil", db_index=True)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='devices', verbose_name="Utilisateur")
    label = models.CharField("Libellé", max_length=120, blank=True)
    user_agent = models.CharField("Agent utilisateur", max_length=255, blank=True)
    created_at = models.DateTimeField("Enregistré le", auto_now_add=True)
    last_seen_at = models.DateTimeField("Dernier contact", null=True, blank=True)
    last_sync_at = models.DateTimeField("Dernière synchronisation", null=True, blank=True)
    is_revoked = models.BooleanField("Révoqué", default=False)
    revoked_at = models.DateTimeField("Révoqué le", null=True, blank=True)
    revoked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name='+')

    class Meta:
        verbose_name = "Appareil"
        verbose_name_plural = "Appareils"
        ordering = ['-last_seen_at', '-created_at']
        constraints = [models.UniqueConstraint(fields=['device_id', 'user'], name='uniq_device_per_user')]

    def __str__(self):
        return self.label or str(self.device_id)


class SyncOperation(NoHardDeleteMixin, models.Model):
    """
    One operation received from a device, with what the server did of it.

    The content of the operation is NOT kept here (personal data live in the business tables only): the
    fingerprint of the payload is enough to recognise a replay.
    """

    class Type(models.TextChoices):
        DECLARATION_CREATE = 'declaration.create', "Création d'une déclaration"
        DECLARATION_UPDATE = 'declaration.update', "Modification d'une déclaration"
        DECLARATION_TRANSMIT = 'declaration.transmit', "Transmission au secrétariat"
        DOCUMENT_UPLOAD = 'document.upload', "Ajout d'une pièce"

    class Status(models.TextChoices):
        APPLIED = 'applied', 'Appliquée'
        REJECTED = 'rejected', 'Refusée'
        CONFLICT = 'conflict', 'Conflit'

    op_id = models.UUIDField("Identifiant de l'opération", unique=True)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='sync_operations',
        verbose_name="Utilisateur")
    device = models.ForeignKey(Device, on_delete=models.PROTECT, related_name='operations', verbose_name="Appareil")
    op_type = models.CharField("Type", max_length=30, choices=Type.choices)
    entity_uuid = models.UUIDField("Objet concerné", db_index=True)
    declaration_uuid = models.UUIDField("Déclaration", null=True, blank=True, db_index=True)
    payload_hash = models.CharField("Empreinte du contenu", max_length=64, blank=True)
    status = models.CharField("Résultat", max_length=10, choices=Status.choices, db_index=True)
    result = models.JSONField("Résumé du résultat", default=dict, blank=True)
    error = models.JSONField("Erreur", default=dict, blank=True)
    # Time of the action on the device as received, then as kept after the clock checks (sync.services).
    device_time = models.DateTimeField("Date sur l'appareil (reçue)", null=True, blank=True)
    effective_time = models.DateTimeField("Date retenue", null=True, blank=True)
    clock_skew_seconds = models.IntegerField("Décalage d'horloge (s)", null=True, blank=True)
    date_anomaly = models.CharField("Anomalie de date", max_length=30, blank=True)
    attempts = models.PositiveIntegerField("Tentatives", default=1)
    received_at = models.DateTimeField("Reçue le (serveur)", auto_now_add=True, db_index=True)
    applied_at = models.DateTimeField("Appliquée le (serveur)", null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Opération synchronisée"
        verbose_name_plural = "Opérations synchronisées"
        ordering = ['-received_at', '-id']

    def __str__(self):
        return f"{self.op_type} {self.entity_uuid} ({self.status})"
