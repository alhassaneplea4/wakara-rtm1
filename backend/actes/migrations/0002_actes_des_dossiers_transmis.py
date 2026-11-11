"""Create the acte dossier of the declarations already transmitted (it now exists from the transmission)."""
from django.db import migrations

DEFAULTS = {
    'region': ('acte.default_region', 'Conakry'),
    'prefecture': ('acte.default_prefecture', 'Conakry'),
    'commune': ('acte.default_commune', 'Ratoma'),
    'centre': ('acte.default_centre', "Centre d'état civil de Ratoma"),
    'officer_name': ('acte.default_officer', 'AMADOU KONIA CAMARA'),
}


def create_missing_actes(apps, schema_editor):
    Declaration = apps.get_model('declarations', 'Declaration')
    Acte = apps.get_model('actes', 'Acte')
    SiteSetting = apps.get_model('core', 'SiteSetting')
    values = {}
    for field, (key, fallback) in DEFAULTS.items():
        row = SiteSetting.objects.filter(key=key).first()
        values[field] = row.value if row else fallback
    for d in Declaration.objects.filter(status='TRANSMITTED', acte__isnull=True):
        Acte.objects.create(declaration=d, annee=d.birth_date.year if d.birth_date else None, **values)


class Migration(migrations.Migration):
    dependencies = [
        ('actes', '0001_initial'),
        ('declarations', '0006_statut_acte_incomplet'),
        ('core', '0001_initial'),
    ]
    operations = [migrations.RunPython(create_missing_actes, migrations.RunPython.noop)]
