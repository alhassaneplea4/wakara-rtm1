"""Build step run by Vercel for the API service (see `buildCommand` in ../vercel.json).

Applies the database migrations and creates the reference data / first administrator on the PRODUCTION
deployment only, so that preview deployments never touch the production database. Both commands are
idempotent. Locally this script is not needed: use `python manage.py migrate`.
"""
import os
import subprocess
import sys


def manage(*args):
    subprocess.run([sys.executable, 'manage.py', *args], check=True)


def main():
    env = os.environ.get('VERCEL_ENV', '')
    if env == 'preview':
        return build_preview()
    if env != 'production':
        print(f"[wakara] VERCEL_ENV={env or 'absent'} : migrations ignorées (production uniquement).")
        return
    if not os.environ.get('DATABASE_URL'):
        sys.exit("[wakara] DATABASE_URL est absente : ajoutez la base PostgreSQL (Neon…) aux variables "
                 "d'environnement du projet Vercel, puis redéployez.")
    manage('migrate', '--noinput')
    manage('setup_initial_data')  # idempotent ; le mot de passe n'est lu que si l'administrateur n'existe pas


def build_preview():
    """
    Preview deployment (branch). The settings force PREVIEW_DATABASE_URL, a separate test database: it is migrated
    here and receives three test accounts (admin.apercu, secretaire.apercu, agent.apercu) sharing the password given
    in WAKARA_PREVIEW_PASSWORD. Without that database nothing is touched (production is never reachable from here).
    """
    if not (os.environ.get('PREVIEW_DATABASE_URL') or os.environ.get('PREVIEW_DATABASE_DATABASE_URL')):
        print("[wakara] Aperçu sans PREVIEW_DATABASE_URL : aucune migration (la base de production n'est jamais utilisée). "
              "L'API de cet aperçu refusera de démarrer.")
        return
    password = os.environ.get('WAKARA_PREVIEW_PASSWORD', '')
    if password:
        for prefix, username in (('WAKARA_ADMIN', 'admin.apercu'), ('WAKARA_SECRETARY', 'secretaire.apercu'), ('WAKARA_AGENT', 'agent.apercu')):
            os.environ[f'{prefix}_USERNAME'] = username
            os.environ[f'{prefix}_PASSWORD'] = password
    manage('migrate', '--noinput')
    manage('setup_initial_data')  # idempotent ; mots de passe lus seulement à la création des comptes
    if password:
        # Comptes de test jamais ouverts (changement de mot de passe encore exigé) : on les realigne sur la variable,
        # pour qu'un mot de passe corrigé dans Vercel soit pris en compte au déploiement suivant. Un compte dont la
        # personne a déjà choisi son mot de passe n'est jamais touché.
        print(f"[wakara] Mot de passe des comptes d'aperçu lu dans WAKARA_PREVIEW_PASSWORD : {len(password)} caractères.")
        manage('shell', '-c', (
            "import os\nfrom accounts.models import CustomUser\n"
            "for u in CustomUser.objects.filter(username__in=['admin.apercu','secretaire.apercu','agent.apercu'], must_change_password=True):\n"
            "    u.set_password(os.environ['WAKARA_PREVIEW_PASSWORD']); u.failed_login_count = 0; u.locked_until = None; u.save(); print('Mot de passe aligné :', u.username)\n"))


if __name__ == '__main__':
    main()
