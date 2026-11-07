"""The secretary may now manage the health facilities (create, update, archive/restore).

Roles are data that the administrator can adjust, and ``setup_initial_data`` never overwrites an existing role.
This one-time data migration therefore adds the three permissions to an EXISTING secretary role; on a new
installation the role does not exist yet and is created with these permissions by ``setup_initial_data``.
"""
from django.db import migrations

CODES = ('hospital.create', 'hospital.update', 'hospital.archive')


def add_permissions(apps, schema_editor):
    Role = apps.get_model('accounts', 'Role')
    Permission = apps.get_model('accounts', 'Permission')
    RolePermission = apps.get_model('accounts', 'RolePermission')
    role = Role.objects.filter(codename='secretary').first()
    if role is None:
        return
    for code in CODES:
        perm = Permission.objects.filter(codename=code).first()
        if perm is not None:
            RolePermission.objects.get_or_create(role=role, permission=perm)


class Migration(migrations.Migration):
    dependencies = [('accounts', '0002_initial')]
    operations = [migrations.RunPython(add_permissions, migrations.RunPython.noop)]
