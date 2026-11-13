"""A Vercel preview deployment must never reach the production database nor share its secret key."""
import os
import subprocess
import sys
from pathlib import Path

from django.test import SimpleTestCase

BACKEND = Path(__file__).resolve().parent.parent
PROBE = ("import django; from django.conf import settings; "
         "print(settings.DATABASES['default'].get('HOST', ''), settings.SECRET_KEY[:12])")


def settings_with(**env):
    clean = {k: v for k, v in os.environ.items() if k not in ('DATABASE_URL', 'PREVIEW_DATABASE_URL', 'PREVIEW_DATABASE_DATABASE_URL', 'VERCEL', 'VERCEL_ENV', 'SECRET_KEY', 'DEBUG')}
    clean.update(DEBUG='True', DJANGO_SETTINGS_MODULE='wakara.settings', **env)
    return subprocess.run([sys.executable, '-c', PROBE], cwd=BACKEND, env=clean, capture_output=True, text=True)


class PreviewIsolationTests(SimpleTestCase):
    PROD = 'postgres://u:p@prod-host.example/db?sslmode=require'
    PREVIEW = 'postgres://u:p@preview-host.example/db?sslmode=require'

    def test_preview_uses_its_own_database_and_its_own_secret_key(self):
        preview = settings_with(VERCEL='1', VERCEL_ENV='preview', DATABASE_URL=self.PROD, PREVIEW_DATABASE_URL=self.PREVIEW)
        production = settings_with(VERCEL='1', VERCEL_ENV='production', DATABASE_URL=self.PROD, PREVIEW_DATABASE_URL=self.PREVIEW)
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertEqual(production.returncode, 0, production.stderr)
        self.assertTrue(preview.stdout.startswith('preview-host.example '), preview.stdout)
        self.assertTrue(production.stdout.startswith('prod-host.example '), production.stdout)
        self.assertNotEqual(preview.stdout.split()[1], production.stdout.split()[1])  # tokens of a preview are worthless in production

    def test_preview_without_its_database_refuses_to_start_even_when_production_is_exposed(self):
        result = settings_with(VERCEL='1', VERCEL_ENV='preview', DATABASE_URL=self.PROD)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('PREVIEW_DATABASE_URL', result.stderr)
        self.assertNotIn('prod-host', result.stdout + result.stderr)

    def test_preview_accepts_the_name_given_by_the_neon_integration(self):
        result = settings_with(VERCEL='1', VERCEL_ENV='preview', DATABASE_URL=self.PROD, PREVIEW_DATABASE_DATABASE_URL=self.PREVIEW)
        self.assertTrue(result.stdout.startswith('preview-host.example '), result.stdout + result.stderr)

    def test_short_preview_alias_is_an_allowed_host_in_preview_only(self):
        probe = "from django.conf import settings; print('wakara-hl.vercel.app' in settings.ALLOWED_HOSTS)"
        def hosts(**env):
            clean = {k: v for k, v in os.environ.items() if k not in ('DATABASE_URL', 'PREVIEW_DATABASE_URL', 'PREVIEW_DATABASE_DATABASE_URL', 'VERCEL', 'VERCEL_ENV', 'SECRET_KEY', 'DEBUG', 'ALLOWED_HOSTS')}
            clean.update(DEBUG='True', DJANGO_SETTINGS_MODULE='wakara.settings', **env)
            return subprocess.run([sys.executable, '-c', probe], cwd=BACKEND, env=clean, capture_output=True, text=True).stdout.strip()
        self.assertEqual(hosts(VERCEL='1', VERCEL_ENV='preview', DATABASE_URL=self.PROD, PREVIEW_DATABASE_URL=self.PREVIEW), 'True')
        self.assertEqual(hosts(VERCEL='1', VERCEL_ENV='production', DATABASE_URL=self.PROD, SECRET_KEY='x' * 40), 'False')

    def test_the_preview_variable_is_ignored_outside_preview(self):
        result = settings_with(VERCEL='1', VERCEL_ENV='production', DATABASE_URL=self.PROD, PREVIEW_DATABASE_URL=self.PREVIEW)
        self.assertTrue(result.stdout.startswith('prod-host.example '), result.stdout)
