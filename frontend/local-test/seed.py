"""
Données fictives du banc d'essai local du mode hors connexion (lancé par local-test/serve.mjs, jamais en production).
Comptes : agent.collecte, agent2.collecte, secretaire, admin — mot de passe dans .local-test/identifiants.txt.
"""
import datetime
import os

from accounts.models import CustomUser, Role, UserRole
from core.workflow import Status
from declarations.services import create_declaration, transition_status
from hospitals.models import Hospital

PASSWORD = os.environ['LOCAL_TEST_PASSWORD']
ACCOUNTS = [
    ('agent.collecte', 'collection_agent', 'Agent', 'Collecte'),
    ('agent2.collecte', 'collection_agent', 'Second', 'Agent'),
    ('secretaire', 'secretary', 'Secrétaire', "d'état civil"),
    ('admin', 'admin', 'Administrateur', 'Technique'),
]

users = {}
for username, role, first, last in ACCOUNTS:
    user = CustomUser.objects.create_user(username=username, password=PASSWORD, first_name=first, last_name=last)
    UserRole.objects.create(user=user, role=Role.objects.get(codename=role))
    users[username] = user

agent, secretary, admin = users['agent.collecte'], users['secretaire'], users['admin']
hospital = Hospital.objects.filter(is_active=True).order_by('name').first()
today = datetime.date.today()


def payload(first, last, days_ago, gender='F'):
    return {
        'hospital': hospital, 'hospital_document_ref': f'H-{days_ago:04d}', 'doctor_name': 'Dr Essai', 'midwife_name': 'Sage-femme Essai',
        'birth_date': today - datetime.timedelta(days=days_ago), 'birth_time': datetime.time(8, 30), 'birth_place': 'Ratoma',
        'child': {'first_names': first, 'last_name': last, 'gender': gender, 'nationality': 'Guinéenne'},
        'mother': {'first_names': 'Fatoumata', 'last_name': last, 'nationality': 'Guinéenne'},
        'declarant': {'first_names': 'Fatoumata', 'last_name': last, 'relationship': 'Mère'},
    }


def make(first, last, days_ago, *path):
    """Creates a dossier for the collection agent and walks it through the given (status, actor, extras) steps."""
    d = create_declaration(agent, payload(first, last, days_ago))
    for target, actor, extra in path:
        transition_status(d.pk, target, actor, **extra)
    return d


make('Mariama', 'Diallo', 1)                                                            # brouillon, modifiable
make('Ibrahima', 'Bah', 2, (Status.TRANSMITTED, agent, {}))                             # transmis au secrétariat, figé pour l'agent
make('Aissatou', 'Camara', 3, (Status.TRANSMITTED, agent, {}), (Status.PENDING_VALIDATION, secretary, {}),
     (Status.TO_CORRECT_COLLECTION, admin, {'reason': "Le lieu de naissance est à préciser (exemple de retour à la collecte)."}))
make('Mamadou', 'Sylla', 6, (Status.TRANSMITTED, agent, {}), (Status.PENDING_VALIDATION, secretary, {}),
     (Status.VALIDATED, admin, {'payload': {'annee': today.year, 'registre': 'R1', 'feuillet': '1', 'numero_acte': 'ESSAI-001', 'accept_incomplete': True}}))
print('Banc d\'essai prêt : 4 comptes, 4 dossiers de l\'agent (brouillon, transmis, à corriger, validé).')
