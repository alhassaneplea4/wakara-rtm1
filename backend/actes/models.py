"""
Birth-certificate (acte de naissance) dossier.

The Acte stores only what is specific to the act itself (registry references, geography,
mentions). Identity data of the child, parents and declarant stays on the declaration
side to avoid duplication.

The OFFICIAL number is distinct from the technical uuid and from the tracking
reference of the declaration. Its attribution rule is NOT hard-coded: see
``actes.services.assign_official_number`` and docs/business-decisions.md.
"""
from django.conf import settings
from django.db import models
from django.db.models import Q

from core.mixins import AppendOnlyModel, BaseModel, CreatedByMixin


class Acte(BaseModel, CreatedByMixin):
    declaration = models.OneToOneField(
        'declarations.Declaration', on_delete=models.PROTECT,
        related_name='acte', verbose_name="Déclaration",
    )
    # Registry references (from the official model, to be confirmed)
    annee = models.PositiveSmallIntegerField("Année", null=True, blank=True)
    registre = models.CharField("Registre", max_length=50, blank=True)
    feuillet = models.CharField("Feuillet", max_length=50, blank=True)
    numero_acte = models.CharField("Numéro officiel de l'acte", max_length=50, null=True, blank=True)
    numero_assigned_at = models.DateTimeField("Numéro attribué le", null=True, blank=True)
    numero_assigned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='+', verbose_name="Numéro attribué par",
    )
    # Administrative geography
    region = models.CharField("Région administrative", max_length=100, blank=True)
    prefecture = models.CharField("Préfecture", max_length=100, blank=True)
    commune = models.CharField("Commune", max_length=100, blank=True)
    centre = models.CharField("Centre", max_length=150, blank=True)
    # Act content
    declaration_date = models.DateField("Date de déclaration", null=True, blank=True)
    officer_name = models.CharField("Officier d'état civil (mention)", max_length=150, blank=True)
    mentions = models.TextField("Mentions", blank=True)

    class Meta(BaseModel.Meta):
        verbose_name = "Acte de naissance"
        verbose_name_plural = "Actes de naissance"
        ordering = ['-created_at']
        constraints = [
            models.UniqueConstraint(
                fields=['annee', 'registre', 'numero_acte'],
                condition=Q(numero_acte__isnull=False),
                name='uniq_official_number_per_registry',
            ),
        ]

    def __str__(self):
        return f"Acte {self.numero_acte or '(sans numéro)'} — {self.declaration.reference}"


class NumberSequence(models.Model):
    """Optional auto-numbering sequence per (year, registry). Used only if enabled by settings."""
    annee = models.PositiveSmallIntegerField()
    registre = models.CharField(max_length=50, blank=True)
    last_value = models.PositiveIntegerField(default=0)

    class Meta:
        unique_together = ('annee', 'registre')
        verbose_name = "Séquence de numérotation"
        verbose_name_plural = "Séquences de numérotation"

    def __str__(self):
        return f"{self.annee}/{self.registre}: {self.last_value}"


class PrintLog(AppendOnlyModel):
    """One row per print of an acte (append-only)."""
    acte = models.ForeignKey(Acte, on_delete=models.PROTECT, related_name='print_logs')
    printed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='+')
    printed_at = models.DateTimeField(auto_now_add=True)
    copy_number = models.PositiveSmallIntegerField(default=1)

    class Meta:
        verbose_name = "Impression d'acte"
        verbose_name_plural = "Impressions d'actes"
        ordering = ['-printed_at']


class Delivery(BaseModel):
    """Record of the delivery of an acte to a requester."""
    acte = models.ForeignKey(Acte, on_delete=models.PROTECT, related_name='deliveries')
    delivered_at = models.DateTimeField("Délivré le")
    recipient_name = models.CharField("Remis à", max_length=200)
    recipient_relationship = models.CharField("Qualité", max_length=100, blank=True)
    recipient_id_type = models.CharField("Type de pièce", max_length=50, blank=True)
    recipient_id_number = models.CharField("Numéro de pièce", max_length=50, blank=True)
    is_duplicate = models.BooleanField("Duplicata / réédition", default=False)
    notes = models.TextField("Observations", blank=True)
    delivered_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='+')

    class Meta(BaseModel.Meta):
        verbose_name = "Délivrance"
        verbose_name_plural = "Délivrances"
        ordering = ['-delivered_at']
