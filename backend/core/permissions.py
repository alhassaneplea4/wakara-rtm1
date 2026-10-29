"""
Granular permissions for Wakara.

Effective permissions of a user =
    permissions of its active roles (role.is_active) + granted overrides - denied overrides

The Django ``is_superuser`` flag grants NOTHING here: the framework super-admin is a
maintenance account (Django Admin only), distinct from the business role
"Administrateur technique Wakara".
"""
from rest_framework.permissions import BasePermission

# (codename, label, category)
PERMISSION_CATALOG = [
    ('declaration.view', 'Consulter ses déclarations', 'Déclarations'),
    ('declaration.view_all', 'Consulter toutes les déclarations', 'Déclarations'),
    ('declaration.create', 'Créer une déclaration', 'Déclarations'),
    ('declaration.update', 'Modifier une déclaration', 'Déclarations'),
    ('declaration.transmit', 'Transmettre une déclaration', 'Déclarations'),
    ('declaration.archive', 'Archiver une déclaration', 'Déclarations'),
    ('acte.view', 'Consulter les actes', 'Actes'),
    ('acte.complete', 'Prendre en charge un dossier (complément)', 'Actes'),
    ('acte.update', 'Compléter un acte', 'Actes'),
    ('acte.submit', 'Soumettre un acte à validation', 'Actes'),
    ('acte.print', 'Imprimer un acte', 'Actes'),
    ('acte.deliver', 'Enregistrer une délivrance', 'Actes'),
    ('dossier.validate', 'Valider définitivement', 'Validation'),
    ('dossier.reject', 'Rejeter ou retourner un dossier', 'Validation'),
    ('document.view', 'Consulter les pièces justificatives', 'Pièces'),
    ('document.upload', 'Ajouter une pièce justificative', 'Pièces'),
    ('hospital.view', 'Consulter les établissements', 'Établissements'),
    ('hospital.create', 'Créer un établissement', 'Établissements'),
    ('hospital.update', 'Modifier un établissement', 'Établissements'),
    ('hospital.archive', 'Archiver un établissement', 'Établissements'),
    ('user.view', 'Consulter les utilisateurs', 'Administration'),
    ('user.create', 'Créer un utilisateur', 'Administration'),
    ('user.update', 'Modifier un utilisateur', 'Administration'),
    ('user.manage_status', 'Activer / désactiver un compte', 'Administration'),
    ('user.assign_roles', 'Attribuer des rôles et permissions', 'Administration'),
    ('user.reset_password', 'Réinitialiser un mot de passe', 'Administration'),
    ('role.view', 'Consulter les rôles', 'Administration'),
    ('role.manage', 'Gérer les rôles et leurs permissions', 'Administration'),
    ('stats.view', 'Consulter les statistiques', 'Statistiques'),
    ('data.export', 'Exporter les données', 'Statistiques'),
    ('audit.view', "Consulter les journaux d'audit", 'Audit'),
    ('settings.manage', 'Gérer les paramètres', 'Administration'),
]
ALL_PERMISSION_CODES = [c for c, _, _ in PERMISSION_CATALOG]

# Default role → permissions (the admin can adjust them afterwards).
DEFAULT_ROLES = {
    'admin': {
        'name': 'Administrateur technique Wakara',
        'description': 'Gère utilisateurs, rôles, établissements, et valide définitivement les dossiers.',
        'permissions': ALL_PERMISSION_CODES,
        'is_system': True,
    },
    'secretary': {
        'name': "Secrétaire d'état civil",
        'description': "Complète les dossiers d'actes et les soumet à validation.",
        'permissions': [
            'declaration.view', 'declaration.view_all',
            'acte.view', 'acte.complete', 'acte.update', 'acte.submit',
            'acte.print', 'acte.deliver',
            'document.view', 'document.upload',
            'hospital.view', 'stats.view',
        ],
        'is_system': False,
    },
    'collection_agent': {
        'name': 'Agent de collecte',
        'description': 'Enregistre les déclarations des hôpitaux et les transmet au secrétariat.',
        'permissions': [
            'declaration.view', 'declaration.create', 'declaration.update',
            'declaration.transmit',
            'document.view', 'document.upload',
            'hospital.view',
        ],
        'is_system': False,
    },
}

# Permissions the 'admin' system role can never lose (lock-out protection).
PROTECTED_ADMIN_PERMISSIONS = ['user.view', 'user.assign_roles', 'role.manage', 'role.view']


class AnyOf(tuple):
    """``permission_map`` value: the user needs AT LEAST ONE of these permissions."""

    def __new__(cls, *codenames):
        return super().__new__(cls, codenames)


def get_user_permissions(user) -> set:
    """Effective permission codenames of ``user`` (cached on the instance)."""
    if not user or not user.is_authenticated or not user.is_active:
        return set()
    cached = getattr(user, '_wk_perms', None)
    if cached is not None:
        return cached

    from accounts.models import RolePermission, UserPermission, UserRole

    role_ids = UserRole.objects.filter(
        user=user, is_active=True, role__is_active=True
    ).values_list('role_id', flat=True)
    perms = set(
        RolePermission.objects.filter(role_id__in=role_ids)
        .values_list('permission__codename', flat=True)
    )
    for override in UserPermission.objects.filter(user=user).select_related('permission'):
        if override.granted:
            perms.add(override.permission.codename)
        else:
            perms.discard(override.permission.codename)
    user._wk_perms = perms
    return perms


def user_has_perm(user, codename: str) -> bool:
    return codename in get_user_permissions(user)


class HasWakaraPermission(BasePermission):
    """
    Fail-closed permission class.

    ViewSets declare ``permission_map = {action: codename}``; plain APIViews declare
    ``required_permission``. An action absent from the map is DENIED.
    """

    def has_permission(self, request, view):
        user = request.user
        if not user or not user.is_authenticated:
            return False
        if getattr(user, 'must_change_password', False) and not getattr(
            view, 'allow_password_change_pending', False
        ):
            return False

        codename = getattr(view, 'required_permission', None)
        if codename is None:
            mapping = getattr(view, 'permission_map', None)
            if mapping is None:
                return False
            codename = mapping.get(getattr(view, 'action', None))
            if codename is None:
                return False
        if isinstance(codename, AnyOf):
            return any(user_has_perm(user, c) for c in codename)
        if isinstance(codename, (list, tuple)):
            return all(user_has_perm(user, c) for c in codename)
        return user_has_perm(user, codename)
