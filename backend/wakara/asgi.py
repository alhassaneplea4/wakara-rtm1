"""ASGI config for Wakara project."""
import os
from django.core.asgi import get_asgi_application

# Forced (not setdefault): a stray DJANGO_SETTINGS_MODULE in the hosting environment must not break the app.
os.environ['DJANGO_SETTINGS_MODULE'] = 'wakara.settings'
application = get_asgi_application()
