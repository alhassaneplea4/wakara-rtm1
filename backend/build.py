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
    if env != 'production':
        print(f"[wakara] VERCEL_ENV={env or 'absent'} : migrations ignorées (production uniquement).")
        return
    if not os.environ.get('DATABASE_URL'):
        sys.exit("[wakara] DATABASE_URL est absente : ajoutez la base PostgreSQL (Neon…) aux variables "
                 "d'environnement du projet Vercel, puis redéployez.")
    manage('migrate', '--noinput')
    manage('setup_initial_data')  # idempotent ; le mot de passe n'est lu que si l'administrateur n'existe pas


if __name__ == '__main__':
    main()
