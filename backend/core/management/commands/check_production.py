"""
Is this deployment ready for real data? Reads the live configuration and database and reports what is not.

    python manage.py check_production            # report, exit code 1 when a BLOCKING point fails
    python manage.py check_production --warn     # report only (used by the Vercel build, which must never fail on it)

BLOCKING points put real data or accounts at risk; the others are advice. Nothing is changed by this command.
"""
from django.conf import settings
from django.core.cache import cache
from django.core.management.base import BaseCommand
from django.db import connection
from django.db.migrations.executor import MigrationExecutor

LOCAL_HOSTS = ('localhost', '127.0.0.1', '[::1]', '0.0.0.0', '*')


def run_checks():
    """List of (level, label, detail): level is 'ok', 'warn' (advice) or 'fail' (blocking)."""
    from django.contrib.auth import get_user_model
    User = get_user_model()
    out = []

    def add(ok, label, detail='', blocking=True):
        out.append(('ok' if ok else ('fail' if blocking else 'warn'), label, '' if ok else detail))

    add(not settings.DEBUG, 'DEBUG désactivé', "DEBUG=True expose les détails des erreurs et la documentation de l'API.")
    add(getattr(settings, 'SECRET_KEY_IS_EXPLICIT', True), 'SECRET_KEY définie explicitement',
        "Sans SECRET_KEY elle est dérivée de l'adresse de la base : définissez-la (valeur aléatoire de 50 caractères ou plus). "
        "Attention : la changer ferme toutes les sessions ouvertes.", blocking=False)
    add(len(settings.SECRET_KEY) >= 32, 'SECRET_KEY assez longue', 'Moins de 32 caractères.')
    add(bool(getattr(settings, 'FIELD_ENCRYPTION_KEY', '')), 'FIELD_ENCRYPTION_KEY définie (codes de récupération, double authentification)',
        "Sans elle, ces secrets sont chiffrés avec une clé dérivée de SECRET_KEY : changer SECRET_KEY les rend illisibles "
        "(chaque appareil enregistre alors un nouveau code de récupération à son prochain déverrouillage avec Internet ; "
        "la double authentification de chaque compte est à réinitialiser). "
        "Définissez-la une fois (valeur aléatoire de 50 caractères ou plus) et ne la changez plus.", blocking=False)

    local_hosts = [h for h in settings.ALLOWED_HOSTS if h in LOCAL_HOSTS]
    add(not local_hosts or settings.ON_VERCEL, 'ALLOWED_HOSTS limité aux domaines réels',
        f"Contient {', '.join(local_hosts)}.", blocking=False)
    add(not [o for o in settings.CORS_ALLOWED_ORIGINS if 'localhost' in o or '127.0.0.1' in o],
        'CORS_ALLOWED_ORIGINS sans adresse locale',
        'Une origine locale est autorisée : renseignez le domaine réel du site.', blocking=False)
    add(settings.NUM_PROXIES >= 1, 'NUM_PROXIES renseigné (adresse du client fiable)',
        "NUM_PROXIES=0 : la limite de connexion et le journal d'audit voient l'adresse du proxy.", blocking=False)

    redis = bool(settings.REDIS_URL)
    add(redis, 'REDIS_URL défini (limitation de débit partagée)',
        'Chaque instance compte seule : la limite réelle est un multiple de la limite configurée.')
    if redis:
        try:
            cache.set('wakara-readiness', '1', 10)
            add(cache.get('wakara-readiness') == '1', 'Le cache Redis répond', 'Écriture puis lecture impossibles.')
        except Exception as exc:  # noqa: BLE001 - any connection problem is a finding
            add(False, 'Le cache Redis répond', exc.__class__.__name__)

    add(connection.vendor == 'postgresql', 'Base PostgreSQL', f'Base « {connection.vendor} » : réservée au développement.')
    try:
        executor = MigrationExecutor(connection)
        pending = executor.migration_plan(executor.loader.graph.leaf_nodes())
        add(not pending, 'Migrations appliquées', f'{len(pending)} migration(s) en attente : lancez `manage.py migrate`.')
        admins = User.objects.filter(
            is_active=True, user_roles__role__codename='admin', user_roles__is_active=True).distinct().count()
        add(admins >= 1, 'Un administrateur actif existe', 'Aucun administrateur : lancez `manage.py setup_initial_data`.')
        add(admins <= 3, 'Peu de comptes administrateur (3 au plus)',
            f'{admins} comptes administrateur actifs : réduisez-les au strict nécessaire.', blocking=False)
        preview = list(User.objects.filter(username__iendswith='.apercu').values_list('username', flat=True))
        add(not preview, "Aucun compte d'aperçu",
            f"Comptes d'aperçu présents : {', '.join(preview)}. Ils n'ont rien à faire en production.")
        add(not User.objects.filter(is_active=True, must_change_password=True, last_login__isnull=True).exists(),
            'Tous les comptes actifs ont été ouverts au moins une fois',
            "Des comptes n'ont jamais été utilisés (mot de passe provisoire encore valable) : désactivez-les ou faites-les ouvrir.",
            blocking=False)
    except Exception as exc:  # noqa: BLE001
        add(False, 'Base de données lisible', exc.__class__.__name__)

    try:
        from accounts.models import Role
        from core.permissions import DEFAULT_ROLES, permissions_of_role
        custom = [r.name for r in Role.objects.filter(is_active=True).exclude(codename__in=DEFAULT_ROLES)
                  if {'document.upload', 'document.archive'} & permissions_of_role(r) == {'document.upload'}]
        add(not custom, 'Rôles personnalisés : retrait des pièces envoyées',
            f"Ces rôles peuvent ajouter des pièces mais pas retirer une pièce déjà envoyée (droit « document.archive ») : "
            f"{', '.join(custom)}. Ajoutez le droit à ceux qui doivent pouvoir le faire (écran Rôles).", blocking=False)
    except Exception as exc:  # noqa: BLE001
        add(False, 'Rôles lisibles', exc.__class__.__name__, blocking=False)
    if connection.vendor == 'postgresql':
        try:
            with connection.cursor() as cursor:
                cursor.execute('SELECT pg_database_size(current_database())')
                size_mb = cursor.fetchone()[0] / 1_048_576
            add(size_mb < settings.DATABASE_SIZE_WARN_MB, 'Volume de la base',
                f"La base occupe {size_mb:.0f} Mo (seuil d'alerte {settings.DATABASE_SIZE_WARN_MB} Mo ; l'offre gratuite de Neon "
                f"s'arrête à 512 Mo). Les photos des fiches sont dans la base : passez à une offre supérieure ou "
                f"déplacez les pièces vers un bucket privé (DOCUMENTS_S3_BUCKET).", blocking=False)
        except Exception as exc:  # noqa: BLE001
            add(False, 'Volume de la base lisible', exc.__class__.__name__, blocking=False)

    add(settings.DOCUMENTS_STORAGE in ('s3', 'database') or not settings.ON_VERCEL, 'Stockage des pièces durable',
        'Sur un hébergement sans disque persistant, les pièces doivent être dans la base ou un bucket privé.')
    add(settings.SIMPLE_JWT['ACCESS_TOKEN_LIFETIME'].total_seconds() <= 3600, "Jeton d'accès de 60 minutes au plus",
        'Un jeton volé reste utilisable trop longtemps.', blocking=False)
    add(settings.DOSSIER_SEPARATE_SUBMIT_AND_VALIDATE, 'Séparation des tâches active (soumettre et valider par deux personnes)',
        'Une même personne peut soumettre puis valider un acte : à garder seulement dans un très petit service.',
        blocking=False)
    add(getattr(settings, 'SECURE_SSL_REDIRECT', False) or settings.DEBUG, 'Redirection HTTPS active', 'SECURE_SSL_REDIRECT=False.')
    return out


class Command(BaseCommand):
    help = "Vérifie que ce déploiement est prêt pour des données réelles (configuration, base, comptes)."

    def add_arguments(self, parser):
        parser.add_argument('--warn', action='store_true', help="Affiche seulement ; le code de sortie reste 0.")

    def handle(self, *args, **options):
        results = run_checks()
        marks = {'ok': 'OK    ', 'warn': 'AVIS  ', 'fail': 'BLOQUE'}
        for level, label, detail in results:
            self.stdout.write(f"[{marks[level]}] {label}" + (f"\n         → {detail}" if detail else ''))
        failures = [r for r in results if r[0] == 'fail']
        advice = [r for r in results if r[0] == 'warn']
        self.stdout.write(
            f"\n{len(results) - len(failures) - len(advice)} point(s) conformes, {len(advice)} avis, {len(failures)} bloquant(s).")
        if failures and not options['warn']:
            raise SystemExit(1)
