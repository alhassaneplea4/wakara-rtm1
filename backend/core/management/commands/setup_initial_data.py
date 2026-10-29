"""
Idempotent bootstrap: permissions, default roles, default settings and the first
administrator (credentials come from the environment, never from the code).

    python manage.py setup_initial_data
"""
from decouple import config
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from accounts.models import Permission, Role, RolePermission, UserRole
from core.models import DEFAULT_SETTINGS, SiteSetting
from core.permissions import DEFAULT_ROLES, PERMISSION_CATALOG

User = get_user_model()


class Command(BaseCommand):
    help = "Crée les permissions, rôles par défaut, paramètres et le premier administrateur."

    def add_arguments(self, parser):
        parser.add_argument('--skip-admin', action='store_true',
                            help="Ne pas créer le compte administrateur initial.")

    @transaction.atomic
    def handle(self, *args, **options):
        for codename, name, category in PERMISSION_CATALOG:
            Permission.objects.update_or_create(
                codename=codename, defaults={'name': name, 'category': category})
        self.stdout.write(f"Permissions : {len(PERMISSION_CATALOG)}")

        for codename, spec in DEFAULT_ROLES.items():
            role, created = Role.objects.get_or_create(
                codename=codename,
                defaults={'name': spec['name'], 'description': spec['description'],
                          'is_system': spec['is_system']})
            if created:  # never overwrite a role the administrator has since adjusted
                for perm_code in spec['permissions']:
                    RolePermission.objects.create(
                        role=role, permission=Permission.objects.get(codename=perm_code))
            elif codename == 'admin':
                # the admin role always owns every catalogue permission (new ones included)
                for perm in Permission.objects.exclude(role_permissions__role=role):
                    RolePermission.objects.create(role=role, permission=perm)
        self.stdout.write(f"Rôles : {', '.join(DEFAULT_ROLES)}")

        for key, value, description, is_public in DEFAULT_SETTINGS:
            SiteSetting.objects.get_or_create(
                key=key, defaults={'value': value, 'description': description, 'is_public': is_public})

        if options['skip_admin']:
            return
        username = config('WAKARA_ADMIN_USERNAME', default='')
        password = config('WAKARA_ADMIN_PASSWORD', default='')
        if not username or not password:
            self.stdout.write(self.style.WARNING(
                "WAKARA_ADMIN_USERNAME / WAKARA_ADMIN_PASSWORD absents du .env : aucun administrateur créé."))
            return
        user, created = User.objects.get_or_create(
            username=username,
            defaults={'email': config('WAKARA_ADMIN_EMAIL', default=''),
                      'first_name': 'Administrateur', 'last_name': 'Technique'})
        if created:
            user.set_password(password)
            user.save()  # NOT a Django superuser: business role only
            self.stdout.write(self.style.SUCCESS(f"Administrateur technique créé : {username}"))
        UserRole.objects.get_or_create(user=user, role=Role.objects.get(codename='admin'),
                                       defaults={'assigned_by': user})
        if not created:
            self.stdout.write(f"Administrateur existant : {username}")
