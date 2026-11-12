"""
The edit form proposes « Urbaine » / « Principal » when an acte has no commune / centre type yet, but nothing was stored:
the preview (aperçu) then showed empty boxes although the form displayed a selection. Store the same defaults on the
actes that are still being worked on. Validated or delivered actes are frozen and are left as they are.
"""
from django.db import migrations

IN_PROGRESS = ['TRANSMITTED', 'IN_COMPLETION', 'TO_CORRECT_SECRETARIAT', 'PENDING_VALIDATION']


def fill_defaults(apps, schema_editor):
    Acte = apps.get_model('actes', 'Acte')
    SiteSetting = apps.get_model('core', 'SiteSetting')

    def default(key, fallback):
        row = SiteSetting.objects.filter(key=key).first()
        return (row.value if row and row.value else fallback)

    qs = Acte.objects.filter(declaration__status__in=IN_PROGRESS)
    qs.filter(commune_type='').update(commune_type=default('acte.default_commune_type', 'URBAINE'))
    qs.filter(centre_type='').update(centre_type=default('acte.default_centre_type', 'PRINCIPAL'))


class Migration(migrations.Migration):
    dependencies = [
        ('actes', '0003_type_commune_centre'),
        ('declarations', '0008_divorce'),
        ('core', '0001_initial'),
    ]
    operations = [migrations.RunPython(fill_defaults, migrations.RunPython.noop)]
