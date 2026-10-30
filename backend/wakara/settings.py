"""
Django settings for Wakara project.
Birth declaration and certificate management for Ratoma municipality, Guinea.
"""

import os
import sys
from datetime import timedelta
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from decouple import Csv, config

BASE_DIR = Path(__file__).resolve().parent.parent

# ──────────────────────────────────────────────
# Security
# ──────────────────────────────────────────────
SECRET_KEY = config('SECRET_KEY')
DEBUG = config('DEBUG', default=False, cast=bool)
ALLOWED_HOSTS = config('ALLOWED_HOSTS', default='localhost,127.0.0.1', cast=Csv())
# Vercel injects the deployment hostnames: allow them automatically (no wildcard).
VERCEL_HOSTS = [h for h in (os.environ.get(k, '') for k in (
    'VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL')) if h]
ALLOWED_HOSTS += VERCEL_HOSTS

# ──────────────────────────────────────────────
# Application definition
# ──────────────────────────────────────────────
INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    # Third-party
    'rest_framework',
    'rest_framework_simplejwt',
    'rest_framework_simplejwt.token_blacklist',
    'corsheaders',
    'django_filters',
    'drf_spectacular',
    # Local apps
    'core.apps.CoreConfig',
    'accounts.apps.AccountsConfig',
    'hospitals.apps.HospitalsConfig',
    'declarations.apps.DeclarationsConfig',
    'actes.apps.ActesConfig',
    'documents.apps.DocumentsConfig',
    'audit.apps.AuditConfig',
    'stats.apps.StatsConfig',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
    'audit.middleware.AuditMiddleware',
]

ROOT_URLCONF = 'wakara.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'wakara.wsgi.application'

# ──────────────────────────────────────────────
# Database
# ──────────────────────────────────────────────
DB_ENGINE = config('DB_ENGINE', default='django.db.backends.sqlite3')
DATABASE_URL = config('DATABASE_URL', default='')  # postgres://user:pass@host:port/name?sslmode=require

if DATABASE_URL:
    # Hosted PostgreSQL (Neon, Supabase, Vercel Postgres…). Serverless: no persistent connection is kept,
    # and server-side cursors are disabled so that connection poolers (pgbouncer) work.
    _url = urlparse(DATABASE_URL)
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.postgresql',
            'NAME': unquote(_url.path.lstrip('/')),
            'USER': unquote(_url.username or ''),
            'PASSWORD': unquote(_url.password or ''),
            'HOST': _url.hostname or 'localhost',
            'PORT': str(_url.port or 5432),
            'CONN_MAX_AGE': 0,
            'DISABLE_SERVER_SIDE_CURSORS': True,
            'OPTIONS': {k: v[0] for k, v in parse_qs(_url.query).items() if k in ('sslmode', 'options')},
        }
    }
elif DB_ENGINE == 'django.db.backends.sqlite3':
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': BASE_DIR / 'db.sqlite3',
        }
    }
else:
    DATABASES = {
        'default': {
            'ENGINE': DB_ENGINE,
            'NAME': config('DB_NAME'),
            'USER': config('DB_USER'),
            'PASSWORD': config('DB_PASSWORD'),
            'HOST': config('DB_HOST', default='localhost'),
            'PORT': config('DB_PORT', default='5432'),
        }
    }

# ──────────────────────────────────────────────
# Auth
# ──────────────────────────────────────────────
AUTH_USER_MODEL = 'accounts.CustomUser'

# Fast hasher ONLY when running the test-suite (never in dev/production).
if 'test' in sys.argv[1:2]:
    PASSWORD_HASHERS = ['django.contrib.auth.hashers.MD5PasswordHasher']

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

# ──────────────────────────────────────────────
# Internationalization
# ──────────────────────────────────────────────
LANGUAGE_CODE = 'fr'
TIME_ZONE = 'Africa/Conakry'
USE_I18N = True
USE_TZ = True

# ──────────────────────────────────────────────
# Static files and PRIVATE document storage
# Supporting documents are never served from a public URL: they go through an
# authenticated, audited download endpoint (documents app).
# ──────────────────────────────────────────────
STATIC_URL = 'static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
PRIVATE_MEDIA_ROOT = Path(config('PRIVATE_MEDIA_ROOT', default=str(BASE_DIR / 'private_media')))

# Private documents: local folder by default; a PRIVATE S3-compatible bucket (AWS S3, Cloudflare R2,
# Supabase Storage…) when DOCUMENTS_S3_BUCKET is set. This is mandatory on serverless hosts such as Vercel,
# whose filesystem is read-only and not persistent. Objects are never public: files are streamed by the
# authenticated download endpoint.
DOCUMENTS_S3_BUCKET = config('DOCUMENTS_S3_BUCKET', default='')
if DOCUMENTS_S3_BUCKET:
    _private_storage = {
        'BACKEND': 'storages.backends.s3.S3Storage',
        'OPTIONS': {
            'bucket_name': DOCUMENTS_S3_BUCKET,
            'access_key': config('DOCUMENTS_S3_ACCESS_KEY'),
            'secret_key': config('DOCUMENTS_S3_SECRET_KEY'),
            'endpoint_url': config('DOCUMENTS_S3_ENDPOINT_URL', default='') or None,
            'region_name': config('DOCUMENTS_S3_REGION', default='') or None,
            'default_acl': None,
            'querystring_auth': True,
            'file_overwrite': False,
            'location': 'wakara/private',
        },
    }
else:
    _private_storage = {
        'BACKEND': 'django.core.files.storage.FileSystemStorage',
        'OPTIONS': {'location': str(PRIVATE_MEDIA_ROOT), 'base_url': None},
    }
STORAGES = {
    'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
    'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'},
    'private': _private_storage,
}

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# ──────────────────────────────────────────────
# DRF
# ──────────────────────────────────────────────
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': (
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ),
    'DEFAULT_PERMISSION_CLASSES': (
        'rest_framework.permissions.IsAuthenticated',
    ),
    'DEFAULT_PAGINATION_CLASS': 'core.pagination.StandardPagination',
    'PAGE_SIZE': 20,
    'DEFAULT_FILTER_BACKENDS': (
        'django_filters.rest_framework.DjangoFilterBackend',
        'rest_framework.filters.SearchFilter',
        'rest_framework.filters.OrderingFilter',
    ),
    'DEFAULT_SCHEMA_CLASS': 'drf_spectacular.openapi.AutoSchema',
    'DATETIME_FORMAT': '%Y-%m-%dT%H:%M:%S%z',
    'DEFAULT_THROTTLE_RATES': {
        'login': config('LOGIN_THROTTLE_RATE', default='10/min'),
    },
    'EXCEPTION_HANDLER': 'core.exceptions.wakara_exception_handler',
}

# ──────────────────────────────────────────────
# SimpleJWT
# ──────────────────────────────────────────────
SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(
        minutes=config('JWT_ACCESS_TOKEN_LIFETIME_MINUTES', default=60, cast=int)
    ),
    'REFRESH_TOKEN_LIFETIME': timedelta(
        days=config('JWT_REFRESH_TOKEN_LIFETIME_DAYS', default=7, cast=int)
    ),
    'ROTATE_REFRESH_TOKENS': True,
    'BLACKLIST_AFTER_ROTATION': True,
    'AUTH_HEADER_TYPES': ('Bearer',),
}

# ──────────────────────────────────────────────
# Login protection
# ──────────────────────────────────────────────
LOGIN_MAX_FAILED_ATTEMPTS = config('LOGIN_MAX_FAILED_ATTEMPTS', default=5, cast=int)
LOGIN_LOCKOUT_MINUTES = config('LOGIN_LOCKOUT_MINUTES', default=15, cast=int)

# ──────────────────────────────────────────────
# Business settings — HYPOTHESES awaiting validation by the mairie
# (see docs/business-decisions.md). They are configuration, not hard-coded rules.
# ──────────────────────────────────────────────
# Minimum data required to TRANSMIT a declaration to the secretariat.
DECLARATION_REQUIRED_FOR_TRANSMISSION = config(
    'DECLARATION_REQUIRED_FOR_TRANSMISSION',
    default='birth_date,child.gender,child.name,mother.name',
    cast=Csv(),
)
# Minimum data required to SUBMIT an acte to validation.
ACTE_REQUIRED_FOR_SUBMISSION = config(
    'ACTE_REQUIRED_FOR_SUBMISSION',
    default='acte.declaration_date,declarant.name',
    cast=Csv(),
)
# Official act number: manual entry by default. Automatic sequential numbering per
# (year, registry) is only available when explicitly enabled.
ACTE_AUTO_NUMBERING = config('ACTE_AUTO_NUMBERING', default=False, cast=bool)
STATS_SHOW_GENDER = config('STATS_SHOW_GENDER', default=True, cast=bool)

# ──────────────────────────────────────────────
# CORS
# ──────────────────────────────────────────────
CORS_ALLOWED_ORIGINS = config(
    'CORS_ALLOWED_ORIGINS',
    default='http://localhost:4200',
    cast=Csv(),
)

# ──────────────────────────────────────────────
# drf-spectacular
# ──────────────────────────────────────────────
SPECTACULAR_SETTINGS = {
    'TITLE': 'Wakara API – Mairie de Ratoma',
    'DESCRIPTION': 'API de gestion des déclarations de naissance et actes d\'état civil',
    'VERSION': '1.0.0',
}

# ──────────────────────────────────────────────
# File uploads
# ──────────────────────────────────────────────
MAX_UPLOAD_SIZE = config('MAX_UPLOAD_SIZE_MB', default=10, cast=int) * 1024 * 1024
DATA_UPLOAD_MAX_MEMORY_SIZE = MAX_UPLOAD_SIZE

# ──────────────────────────────────────────────
# Production hardening (HTTPS is mandatory outside DEBUG)
# ──────────────────────────────────────────────
if not DEBUG:
    SECURE_SSL_REDIRECT = config('SECURE_SSL_REDIRECT', default=True, cast=bool)
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_HSTS_SECONDS = config('SECURE_HSTS_SECONDS', default=31536000, cast=int)
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_CONTENT_TYPE_NOSNIFF = True
    CSRF_TRUSTED_ORIGINS = config('CSRF_TRUSTED_ORIGINS', default='', cast=Csv()) + [f'https://{h}' for h in VERCEL_HOSTS]
X_FRAME_OPTIONS = 'DENY'

# ──────────────────────────────────────────────
# Cache (throttling). Use Redis/Memcached in production with several workers.
# ──────────────────────────────────────────────
CACHES = {'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}}
