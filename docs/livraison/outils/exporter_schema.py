"""Exporte la structure des modèles Django vers donnees-schema.json (utilisé pour le dictionnaire des données).

    cd backend && venv\\Scripts\\python.exe ..\\docs\\livraison\\outils\\exporter_schema.py
"""
import json
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'wakara.settings')
os.environ.setdefault('SECRET_KEY', 'export-schema')
os.environ.setdefault('DEBUG', 'True')

import django  # noqa: E402

django.setup()
from django.apps import apps  # noqa: E402

models = []
for app in ('accounts', 'hospitals', 'declarations', 'actes', 'documents', 'audit', 'core'):
    for m in apps.get_app_config(app).get_models():
        fields = []
        for f in m._meta.get_fields():
            if f.auto_created and not f.concrete:
                continue
            fields.append({
                'name': f.name,
                'type': type(f).__name__,
                'rel': f.related_model.__name__ if getattr(f, 'related_model', None) else '',
                'null': bool(getattr(f, 'null', False)),
                'max': getattr(f, 'max_length', None),
                'unique': bool(getattr(f, 'unique', False)),
            })
        models.append({'app': app, 'model': m.__name__, 'table': m._meta.db_table, 'fields': fields})

out = Path(__file__).with_name('donnees-schema.json')
out.write_text(json.dumps(models, ensure_ascii=False, indent=1), encoding='utf-8')
print(len(models), 'modeles ->', out)
