"""
Declaration models.

One Declaration = one child (a multiple birth is recorded as several declarations;
this is a working choice listed in docs/business-decisions.md).

Identifiers — never confuse them:
  - ``uuid``       technical public identifier (API)
  - ``reference``  internal tracking reference (WKR-YYYY-NNNN)
  - the OFFICIAL act number lives on ``actes.Acte`` and is attributed under validated rules.
"""
from django.conf import settings
from django.db import models

from core.mixins import AppendOnlyModel, BaseModel, CreatedByMixin
from core.workflow import Status


class ReferenceCounter(models.Model):
    """Per-key counter, incremented under SELECT ... FOR UPDATE (no duplicates under concurrency)."""
    key = models.CharField(max_length=60, unique=True)
    value = models.PositiveIntegerField(default=0)

    class Meta:
        verbose_name = "Compteur de référence"
        verbose_name_plural = "Compteurs de référence"

    def __str__(self):
        return f"{self.key}={self.value}"


class Declaration(BaseModel, CreatedByMixin):
    """Birth declaration received from a hospital / maternity (paper form no. 1)."""

    reference = models.CharField("Référence de suivi", max_length=50, unique=True, db_index=True)
    status = models.CharField(
        "Statut", max_length=30, choices=Status.CHOICES, default=Status.DRAFT, db_index=True)

    hospital = models.ForeignKey(
        'hospitals.Hospital', on_delete=models.PROTECT, null=True, blank=True,
        related_name='declarations', verbose_name="Établissement de santé",
    )
    hospital_document_ref = models.CharField("Référence du document hospitalier", max_length=100, blank=True)
    doctor_name = models.CharField("Médecin", max_length=150, blank=True)
    midwife_name = models.CharField("Sage-femme", max_length=150, blank=True)

    birth_date = models.DateField("Date de naissance", db_index=True)
    birth_time = models.TimeField("Heure de naissance", null=True, blank=True)
    birth_place = models.CharField("Lieu de naissance", max_length=200, blank=True)
    notes = models.TextField("Observations", blank=True)

    received_at = models.DateField("Date de réception", db_index=True)
    assigned_to = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='assigned_declarations', verbose_name="Agent responsable",
    )
    last_decision_reason = models.TextField("Dernier motif de retour / rejet", blank=True)

    transmitted_at = models.DateTimeField("Transmise le", null=True, blank=True)
    validated_at = models.DateTimeField("Validée le", null=True, blank=True, db_index=True)
    validated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='validated_declarations', verbose_name="Validée par",
    )

    class Meta(BaseModel.Meta):
        verbose_name = "Déclaration de naissance"
        verbose_name_plural = "Déclarations de naissance"
        ordering = ['-created_at']
        indexes = [models.Index(fields=['status', 'hospital']), models.Index(fields=['received_at'])]

    def __str__(self):
        return f"Déclaration {self.reference}"


class Child(BaseModel):
    declaration = models.OneToOneField(
        Declaration, on_delete=models.CASCADE, related_name='child', verbose_name="Déclaration")
    first_names = models.CharField("Prénoms", max_length=150, blank=True)
    last_name = models.CharField("Nom", max_length=100, blank=True)
    gender = models.CharField(
        "Sexe", max_length=1, blank=True, choices=[('M', 'Masculin'), ('F', 'Féminin')])
    birth_weight = models.DecimalField(
        "Poids (kg)", max_digits=4, decimal_places=2, null=True, blank=True)
    birth_length = models.DecimalField(
        "Taille (cm)", max_digits=5, decimal_places=2, null=True, blank=True)

    class Meta(BaseModel.Meta):
        verbose_name = "Enfant"
        verbose_name_plural = "Enfants"

    def __str__(self):
        return f"{self.first_names} {self.last_name}".strip()


class Parent(BaseModel):
    FATHER = 'FATHER'
    MOTHER = 'MOTHER'

    declaration = models.ForeignKey(
        Declaration, on_delete=models.CASCADE, related_name='parents', verbose_name="Déclaration")
    parent_type = models.CharField(
        "Type", max_length=10, choices=[(FATHER, 'Père'), (MOTHER, 'Mère')])
    first_names = models.CharField("Prénoms", max_length=150, blank=True)
    last_name = models.CharField("Nom", max_length=100, blank=True)
    date_of_birth = models.DateField("Date de naissance", null=True, blank=True)
    birth_place = models.CharField("Lieu de naissance", max_length=200, blank=True)
    age = models.PositiveSmallIntegerField("Âge", null=True, blank=True)
    nationality = models.CharField("Nationalité", max_length=50, blank=True)
    profession = models.CharField("Profession", max_length=100, blank=True)
    address = models.TextField("Domicile", blank=True)
    phone = models.CharField("Téléphone", max_length=20, blank=True)
    id_type = models.CharField("Type de pièce d'identité", max_length=50, blank=True)
    id_number = models.CharField("Numéro de pièce d'identité", max_length=50, blank=True)

    class Meta(BaseModel.Meta):
        verbose_name = "Parent"
        verbose_name_plural = "Parents"
        constraints = [
            models.UniqueConstraint(
                fields=['declaration', 'parent_type'], condition=models.Q(is_archived=False),
                name='uniq_parent_type_per_declaration'),
        ]

    def __str__(self):
        return f"{self.get_parent_type_display()} : {self.first_names} {self.last_name}".strip()


class Declarant(BaseModel):
    """The person who declares the birth to the civil registry (may differ from the parents)."""
    declaration = models.OneToOneField(
        Declaration, on_delete=models.CASCADE, related_name='declarant', verbose_name="Déclaration")
    first_names = models.CharField("Prénoms", max_length=150, blank=True)
    last_name = models.CharField("Nom", max_length=100, blank=True)
    relationship = models.CharField("Lien avec l'enfant", max_length=50, blank=True)
    profession = models.CharField("Profession", max_length=100, blank=True)
    phone = models.CharField("Téléphone", max_length=20, blank=True)
    address = models.TextField("Domicile", blank=True)
    id_type = models.CharField("Type de pièce d'identité", max_length=50, blank=True)
    id_number = models.CharField("Numéro de pièce d'identité", max_length=50, blank=True)

    class Meta(BaseModel.Meta):
        verbose_name = "Déclarant"
        verbose_name_plural = "Déclarants"

    def __str__(self):
        return f"{self.first_names} {self.last_name}".strip()


class StatusHistory(AppendOnlyModel):
    """Every workflow transition: who, when, from, to, why. Append-only."""
    declaration = models.ForeignKey(
        Declaration, on_delete=models.PROTECT, related_name='status_history')
    from_status = models.CharField("Ancien statut", max_length=30, blank=True)
    to_status = models.CharField("Nouveau statut", max_length=30)
    changed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='+')
    changed_at = models.DateTimeField("Date", auto_now_add=True)
    reason = models.TextField("Motif / commentaire", blank=True)

    class Meta:
        verbose_name = "Historique de statut"
        verbose_name_plural = "Historiques de statut"
        ordering = ['-changed_at', '-id']

    def __str__(self):
        return f"{self.declaration.reference}: {self.from_status} → {self.to_status}"
