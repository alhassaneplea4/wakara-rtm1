"""
Accounts models: CustomUser, Role, Permission, RolePermission, UserRole, UserPermission.

Django ``is_superuser`` (framework maintenance) ≠ Wakara role "admin" (business role).
"""
import uuid

from django.conf import settings
from django.contrib.auth.models import AbstractUser
from django.db import models
from django.utils import timezone

from core.mixins import NoHardDeleteMixin, TimeStampedMixin


class CustomUser(NoHardDeleteMixin, AbstractUser):
    uuid = models.UUIDField(default=uuid.uuid4, editable=False, unique=True, db_index=True)
    phone = models.CharField("Téléphone", max_length=20, blank=True)
    address = models.TextField("Adresse", blank=True)
    hospital = models.ForeignKey(
        'hospitals.Hospital', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='staff', verbose_name="Établissement de santé",
    )
    must_change_password = models.BooleanField("Doit changer son mot de passe", default=False)
    failed_login_count = models.PositiveIntegerField("Échecs de connexion", default=0)
    locked_until = models.DateTimeField("Verrouillé jusqu'à", null=True, blank=True)
    session_version = models.PositiveIntegerField(
        "Version des sessions", default=0,
        help_text="Augmente à chaque changement ou réinitialisation de mot de passe et à chaque désactivation : "
                  "les jetons portant une ancienne version sont refusés aussitôt.")
    created_by = models.ForeignKey(
        'self', on_delete=models.SET_NULL, null=True, blank=True, related_name='+',
    )
    created_at = models.DateTimeField("Date de création", auto_now_add=True)
    updated_at = models.DateTimeField("Date de modification", auto_now=True)

    class Meta:
        verbose_name = "Utilisateur"
        verbose_name_plural = "Utilisateurs"
        ordering = ['-date_joined']

    def __str__(self):
        return f"{self.get_full_name() or self.username} ({self.username})"

    @property
    def is_locked(self) -> bool:
        return bool(self.locked_until and self.locked_until > timezone.now())

    @property
    def role_codenames(self):
        return list(
            self.user_roles.filter(is_active=True, role__is_active=True)
            .values_list('role__codename', flat=True)
        )

    def has_wakara_permission(self, codename: str) -> bool:
        from core.permissions import user_has_perm
        return user_has_perm(self, codename)


class LoginAttempt(models.Model):
    """
    Wrong passwords of ONE account from ONE address. The lockout is per (account, address): somebody guessing
    passwords locks himself out, not the owner of the account who signs in from elsewhere. The account itself is
    only locked when several addresses are locked at the same time (a distributed attack): see accounts.views.
    """
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='login_attempts')
    ip_address = models.CharField("Adresse", max_length=45, blank=True, default='')
    failed_count = models.PositiveIntegerField("Échecs", default=0)
    locked_until = models.DateTimeField("Verrouillé jusqu'à", null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Tentatives de connexion"
        verbose_name_plural = "Tentatives de connexion"
        constraints = [models.UniqueConstraint(fields=['user', 'ip_address'], name='uniq_login_attempt')]

    @property
    def is_locked(self) -> bool:
        return bool(self.locked_until and self.locked_until > timezone.now())


class RevokedAccessToken(models.Model):
    """An access token ended by a sign-out: refused until it would have expired anyway (then the row is purged)."""
    jti = models.CharField(max_length=64, unique=True)
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        verbose_name = "Jeton d'accès révoqué"
        verbose_name_plural = "Jetons d'accès révoqués"


class Role(NoHardDeleteMixin, TimeStampedMixin):
    """Application-level role (distinct from Django groups)."""
    codename = models.CharField("Code", max_length=50, unique=True)
    name = models.CharField("Nom", max_length=100)
    description = models.TextField("Description", blank=True)
    is_active = models.BooleanField("Actif", default=True)
    is_system = models.BooleanField("Rôle système", default=False)

    class Meta:
        verbose_name = "Rôle"
        verbose_name_plural = "Rôles"
        ordering = ['name']

    def __str__(self):
        return self.name


class Permission(NoHardDeleteMixin, TimeStampedMixin):
    """Granular Wakara permission (not Django's built-in)."""
    codename = models.CharField("Code", max_length=100, unique=True)
    name = models.CharField("Nom", max_length=200)
    category = models.CharField("Catégorie", max_length=50, blank=True)
    description = models.TextField("Description", blank=True)

    class Meta:
        verbose_name = "Permission"
        verbose_name_plural = "Permissions"
        ordering = ['category', 'codename']

    def __str__(self):
        return self.codename


class RolePermission(TimeStampedMixin):
    role = models.ForeignKey(Role, on_delete=models.CASCADE, related_name='role_permissions')
    permission = models.ForeignKey(Permission, on_delete=models.CASCADE, related_name='role_permissions')

    class Meta:
        verbose_name = "Permission du rôle"
        verbose_name_plural = "Permissions des rôles"
        unique_together = ('role', 'permission')

    def __str__(self):
        return f"{self.role.codename} → {self.permission.codename}"


class UserRole(TimeStampedMixin):
    user = models.ForeignKey(CustomUser, on_delete=models.CASCADE, related_name='user_roles')
    role = models.ForeignKey(Role, on_delete=models.CASCADE, related_name='user_roles')
    is_active = models.BooleanField("Actif", default=True)
    assigned_at = models.DateTimeField("Assigné le", default=timezone.now)
    assigned_by = models.ForeignKey(
        CustomUser, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='roles_assigned', verbose_name="Assigné par",
    )

    class Meta:
        verbose_name = "Rôle utilisateur"
        verbose_name_plural = "Rôles utilisateurs"
        unique_together = ('user', 'role')

    def __str__(self):
        return f"{self.user.username} ← {self.role.codename}"


class UserPermission(TimeStampedMixin):
    """Per-user override: grant a permission its roles lack, or deny one they give."""
    user = models.ForeignKey(CustomUser, on_delete=models.CASCADE, related_name='permission_overrides')
    permission = models.ForeignKey(Permission, on_delete=models.CASCADE, related_name='user_overrides')
    granted = models.BooleanField("Accordée", default=True)
    set_by = models.ForeignKey(
        CustomUser, on_delete=models.SET_NULL, null=True, blank=True, related_name='+',
    )

    class Meta:
        verbose_name = "Permission utilisateur"
        verbose_name_plural = "Permissions utilisateurs"
        unique_together = ('user', 'permission')

    def __str__(self):
        return f"{self.user.username} {'+' if self.granted else '-'} {self.permission.codename}"
