"""WSGI config for Wakara project."""
import os
from django.core.wsgi import get_wsgi_application

# Forced (not setdefault): a stray DJANGO_SETTINGS_MODULE in the hosting environment must not break the app.
os.environ['DJANGO_SETTINGS_MODULE'] = 'wakara.settings'
application = get_wsgi_application()
