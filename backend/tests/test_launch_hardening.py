"""Pre-launch hardening: encrypted database link, no default CORS, Django admin off, anti-robot field, public audience counter."""
import json
import os
import subprocess
import sys
from pathlib import Path

from unittest import skipIf

from django.core.cache import cache
from rest_framework.test import APIClient

from core.models import PageHit

from .base import PASSWORD, WakaraTestCase

BACKEND = Path(__file__).resolve().parents[1]


def settings_of(**env):
    """Settings the project computes under a given environment (fresh interpreter: settings are read once)."""
    base = {k: v for k, v in os.environ.items() if k not in (
        'DEBUG', 'DATABASE_URL', 'CORS_ALLOWED_ORIGINS', 'ENABLE_DJANGO_ADMIN', 'VERCEL', 'VERCEL_ENV', 'DB_ENGINE')}
    base.update({'SECRET_KEY': 'x' * 60, 'DJANGO_SETTINGS_MODULE': 'wakara.settings', 'DEBUG': 'False'})
    base.update(env)
    code = ("import json, django.conf as c; s = c.settings; print(json.dumps({"
            "'options': s.DATABASES['default'].get('OPTIONS', {}), 'cors': list(s.CORS_ALLOWED_ORIGINS), "
            "'admin': s.ENABLE_DJANGO_ADMIN, 'engine': s.DATABASES['default']['ENGINE']}))")
    out = subprocess.run([sys.executable, '-c', code], cwd=BACKEND, env=base, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


class ConfigurationTests(WakaraTestCase):
    def test_a_remote_database_is_always_reached_over_tls(self):
        got = settings_of(DATABASE_URL='postgres://u:p@db.example.com:5432/wakara')
        self.assertEqual(got['options'].get('sslmode'), 'require')

    def test_an_explicit_tls_mode_is_kept(self):
        got = settings_of(DATABASE_URL='postgres://u:p@db.example.com:5432/wakara?sslmode=verify-full')
        self.assertEqual(got['options'].get('sslmode'), 'verify-full')

    def test_a_local_database_is_left_alone(self):
        got = settings_of(DATABASE_URL='postgres://u:p@localhost:5432/wakara')
        self.assertNotIn('sslmode', got['options'])

    @skipIf((BACKEND / '.env').exists(), 'a local .env file may define CORS_ALLOWED_ORIGINS (production has none)')
    def test_no_origin_is_allowed_by_cors_in_production(self):
        self.assertEqual(settings_of()['cors'], [])
        self.assertEqual(settings_of(CORS_ALLOWED_ORIGINS='https://wakara.example.gn')['cors'], ['https://wakara.example.gn'])

    def test_the_django_admin_is_off_in_production_unless_asked(self):
        self.assertFalse(settings_of()['admin'])
        self.assertTrue(settings_of(ENABLE_DJANGO_ADMIN='True')['admin'])
        self.assertTrue(settings_of(DEBUG='True')['admin'])


class AntiRobotTests(WakaraTestCase):
    def login(self, **extra):
        return APIClient().post('/api/auth/login/', {'username': 'agent', 'password': PASSWORD, **extra}, format='json')

    def test_a_person_does_not_see_the_trap_field_and_signs_in(self):
        self.assertEqual(self.login().status_code, 200)
        self.assertEqual(self.login(website='').status_code, 200)

    def test_a_robot_that_fills_the_field_is_refused_even_with_the_right_password(self):
        r = self.login(website='http://spam.example')
        self.assertEqual(r.status_code, 401)
        self.assertNotIn('access', r.data)


class AudienceTests(WakaraTestCase):
    def hit(self, path, **headers):
        return APIClient().post('/api/public/hit/', {'path': path}, format='json', **headers)

    def test_a_public_page_visit_is_counted_per_day(self):
        self.assertEqual(self.hit('/login').status_code, 204)
        self.assertEqual(self.hit('/login').status_code, 204)
        self.assertEqual(self.hit('/confidentialite').status_code, 204)
        counts = {row.path: row.count for row in PageHit.objects.all()}
        self.assertEqual(counts, {'/login': 2, '/confidentialite': 1})

    def test_the_pages_of_the_application_are_never_counted(self):
        for path in ('/declarations/6f1c0f0e-5b7b-4a53-9d39-3a8f1c2d4e5f', '/users', '/api/auth/me/', '', 'x' * 200):
            self.assertEqual(self.hit(path).status_code, 204)      # the answer never tells what was counted
        self.assertEqual(PageHit.objects.count(), 0)

    def test_do_not_track_and_global_privacy_control_are_respected(self):
        self.hit('/login', HTTP_DNT='1')
        self.hit('/login', HTTP_SEC_GPC='1')
        self.assertEqual(PageHit.objects.count(), 0)

    def test_a_malformed_body_never_breaks_the_counter(self):
        for body in ('[1, 2]', '"text"', '{"path": 12345}', '{"path": {"a": 1}}', 'null'):
            r = APIClient().post('/api/public/hit/', body, content_type='application/json')
            self.assertEqual(r.status_code, 204, body)
        self.assertEqual(PageHit.objects.count(), 0)

    def test_nothing_identifying_is_stored(self):
        self.hit('/login')
        self.assertEqual(sorted(f.name for f in PageHit._meta.get_fields()), ['count', 'day', 'id', 'path'])

    def test_the_counter_is_rate_limited(self):
        cache.clear()
        codes = {self.hit('/login').status_code for _ in range(40)}
        self.assertIn(429, codes)

    def test_only_those_who_see_statistics_read_the_audience(self):
        self.hit('/login')
        self.assertEqual(APIClient().get('/api/stats/audience/').status_code, 401)
        self.assertEqual(self.client_for(self.agent).get('/api/stats/audience/').status_code, 403)
        r = self.client_for(self.admin).get('/api/stats/audience/')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data['total'], 1)
        self.assertEqual(r.data['pages'], [{'path': '/login', 'visits': 1}])


class ErrorDisclosureTests(WakaraTestCase):
    def test_a_broken_json_body_does_not_reveal_the_parser_message(self):
        body = b'{"username":"a' + bytes([0xff, 0xfe]) + b'b","password":"x"}'
        r = APIClient().post('/api/auth/login/', body, content_type='application/json')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.data, {'detail': 'Corps de la requête invalide.'})
        self.assertNotIn('utf-8', str(r.data))


class SurfaceTests(WakaraTestCase):
    def test_no_api_index_lists_routes_or_internal_urls(self):
        c = self.client_for(self.agent)
        for root in ('/api/sync/', '/api/declarations/export-index/', '/api/users/', '/api/audit/'):
            r = c.get(root)
            self.assertNotIn('127.0.0.1', r.content.decode(), root)
        self.assertEqual(c.get('/api/sync/').status_code, 404)        # the index of the router no longer exists

    def test_free_text_has_a_ceiling(self):
        c = self.client_for(self.agent)
        r = c.post('/api/declarations/', self.declaration_payload(notes='A' * 20000), format='json')
        self.assertEqual(r.status_code, 400)
        self.assertIn('notes', r.data)
        ok = c.post('/api/declarations/', self.declaration_payload(notes='A' * 4000), format='json')
        self.assertEqual(ok.status_code, 201, ok.content)


class PublicTextsTests(WakaraTestCase):
    def test_the_legal_contact_texts_are_public_and_editable(self):
        data = APIClient().get('/api/public/settings/').data
        for key in ('legal.controller', 'legal.address', 'legal.contact_email', 'legal.data_officer', 'legal.updated'):
            self.assertIn(key, data)
        self.assertEqual(self.client_for(self.admin).patch(
            '/api/settings/', {'legal.contact_email': 'etatcivil@example.gn'}, format='json').status_code, 200)
        self.assertEqual(APIClient().get('/api/public/settings/').data['legal.contact_email'], 'etatcivil@example.gn')

    def test_no_secret_setting_is_ever_public(self):
        data = APIClient().get('/api/public/settings/').data
        for key in data:
            self.assertFalse(any(w in key for w in ('secret', 'password', 'token', 'key')), key)
