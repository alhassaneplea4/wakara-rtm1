"""
Switch off the second factor of an account (lost phone and backup codes), from the server.

    python manage.py reset_two_factor <identifiant> --reason "Téléphone perdu, identité vérifiée"

For the case where no other administrator can do it from the Utilisateurs screen (a single administrator who lost
his phone). The sessions of the account end and the reset is written to the audit log.
"""
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from accounts import two_factor
from accounts.views import revoke_user_tokens
from audit import service as audit
from audit.models import AuditAction


class Command(BaseCommand):
    help = "Réinitialise la double authentification d'un compte (téléphone et codes de secours perdus)."

    def add_arguments(self, parser):
        parser.add_argument('username')
        parser.add_argument('--reason', required=True, help="Motif (10 caractères au moins), inscrit au journal d'audit.")

    def handle(self, *args, **options):
        reason = options['reason'].strip()
        if len(reason) < 10:
            raise CommandError("Le motif doit contenir au moins 10 caractères.")
        user = get_user_model().objects.filter(username__iexact=options['username']).first()
        if user is None:
            raise CommandError("Compte introuvable.")
        two_factor.clear(user)
        revoke_user_tokens(user)
        audit.log(AuditAction.TWO_FACTOR_RESET, obj=user, username='(serveur)', reason=f"{reason} [commande reset_two_factor]")
        self.stdout.write(self.style.SUCCESS(f"Double authentification de {user.username} réinitialisée ; ses sessions sont terminées."))
