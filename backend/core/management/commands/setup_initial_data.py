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
        # (variable prefix, role, first name, last name, label). Only the administrator is mandatory;
        # the others are optional starter accounts. Passwords are read only when the account is created.
        accounts = [
            ('WAKARA_ADMIN', 'admin', 'Administrateur', 'Technique', 'Administrateur technique'),
            ('WAKARA_SECRETARY', 'secretary', 'Secrétaire', "d'état civil", "Secrétaire d'état civil"),
            ('WAKARA_AGENT', 'collection_agent', 'Agent', 'de collecte', 'Agent de collecte'),
        ]
        admin_user = None
        for prefix, role_code, first, last, label in accounts:
            username = config(f'{prefix}_USERNAME', default='')
            password = config(f'{prefix}_PASSWORD', default='')
            if not username or not password:
                if prefix == 'WAKARA_ADMIN':
                    self.stdout.write(self.style.WARNING(
                        "WAKARA_ADMIN_USERNAME / WAKARA_ADMIN_PASSWORD absents : aucun administrateur créé."))
                continue
            user, created = User.objects.get_or_create(
                username=username,
                defaults={'email': config(f'{prefix}_EMAIL', default=''), 'first_name': first, 'last_name': last})
            if created:
                user.set_password(password)
                user.must_change_password = True  # chosen by the person at the first sign-in
                user.save()  # NOT a Django superuser: business role only
                self.stdout.write(self.style.SUCCESS(f"{label} créé : {username}"))
            else:
                self.stdout.write(f"{label} existant : {username}")
            if prefix == 'WAKARA_ADMIN':
                admin_user = user
            UserRole.objects.get_or_create(user=user, role=Role.objects.get(codename=role_code),
                                           defaults={'assigned_by': admin_user or user})
