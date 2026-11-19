"""Core models: editable site settings (login-page texts, institution names…)."""
from django.conf import settings
from django.db import models

from core.mixins import TimeStampedMixin


class SiteSetting(TimeStampedMixin):
    """Key/value settings editable by an administrator. ``is_public`` ones are exposed to the login page."""
    key = models.CharField("Clé", max_length=100, unique=True)
    value = models.TextField("Valeur", blank=True)
    description = models.CharField("Description", max_length=255, blank=True)
    is_public = models.BooleanField("Public", default=False)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name='+',
    )

    class Meta:
        verbose_name = "Paramètre"
        verbose_name_plural = "Paramètres"
        ordering = ['key']

    def __str__(self):
        return self.key



class PageHit(models.Model):
    """
    Audience of the PUBLIC pages (login, privacy policy, terms…): a count per day and per page, nothing else.
    No address, no identifier, no cookie, nothing that could single out a visitor; never the pages of the application.
    """
    day = models.DateField("Jour", db_index=True)
    path = models.CharField("Page", max_length=60)
    count = models.PositiveIntegerField("Visites", default=0)

    class Meta:
        verbose_name = "Audience d'une page publique"
        verbose_name_plural = "Audience des pages publiques"
        constraints = [models.UniqueConstraint(fields=['day', 'path'], name='uniq_pagehit_day_path')]
        ordering = ['-day', 'path']

    def __str__(self):
        return f"{self.day} {self.path} : {self.count}"


DEFAULT_SETTINGS = [
    ('institution.name', "Mairie de Ratoma", "Nom de l'institution", True),
    ('login.tag', 'ÉTAT CIVIL', 'Étiquette du panneau de présentation', True),
    ('login.headline', "Des naissances\nmieux *enregistrées*\npour un *avenir plus sûr.*", 'Titre du panneau de présentation', True),
    ('login.description',
     "Wakara est la plateforme de gestion des déclarations de naissance et des actes de naissance de la mairie de Ratoma. Un outil moderne, sécurisé et au service des citoyens.",
     'Texte du panneau de présentation', True),
    ('login.footer', "Une solution moderne pour un état civil fiable et accessible", 'Pied de la page de connexion', True),
    ('acte.default_region', 'Conakry', "Région administrative par défaut des actes", False),
    ('acte.default_prefecture', 'Conakry', "Préfecture par défaut des actes", False),
    ('acte.default_commune', 'Ratoma', "Commune par défaut des actes", False),
    ('acte.default_centre', "Centre d'état civil de Ratoma", "Centre par défaut des actes", False),
    ('acte.default_commune_type', 'URBAINE', "Type de commune par défaut des actes (URBAINE ou RURALE)", False),
    ('acte.default_centre_type', 'PRINCIPAL', "Type de centre par défaut des actes (PRINCIPAL ou SECONDAIRE)", False),
    # Remote switch of the offline mode: 'false' makes every device stop working locally and remove its
    # service worker at the next contact; pending operations can still be synchronised.
    ('offline.enabled', 'true', "Mode hors connexion pour les agents de collecte (true ou false)", True),
    ('acte.default_officer', 'AMADOU KONIA CAMARA', "Officier d'état civil pré-rempli sur les actes", False),
    # Roles that must sign in with a second factor (authentication application): codes separated by commas, e.g.
    # « admin,secretary », or « all ». Empty = optional for everybody. An account concerned that has not set it up yet
    # can only reach its profile page until it does.
    # Public pages (privacy policy, terms, legal notice): who is responsible and how to reach them. Shown to everybody.
    ('legal.controller', "Mairie de Ratoma — Centre d'état civil et de l'identification (CECI Ratoma)", "Responsable du traitement (pages légales)", True),
    ('legal.address', "Ratoma, Conakry, République de Guinée", "Adresse du responsable (pages légales)", True),
    ('legal.contact_email', '', "E-mail pour exercer ses droits et signaler un problème de sécurité (pages légales)", True),
    ('legal.contact_phone', '', "Téléphone du responsable (pages légales)", True),
    ('legal.data_officer', '', "Nom du responsable de la protection des données (pages légales)", True),
    ('legal.validated', 'false', "Pages légales relues et validées par la mairie (true) : retire la mention « version provisoire »", True),
    ('legal.updated', '19 novembre 2026', "Date de dernière mise à jour des pages légales", True),
    ('security.two_factor_roles', '', "Rôles qui doivent utiliser la double authentification (codes séparés par des virgules, ex. admin,secretary ; « all » pour tous ; vide = facultative)", False),
]


def get_setting(key, default=''):
    try:
        return SiteSetting.objects.get(key=key).value
    except SiteSetting.DoesNotExist:
        for k, v, _d, _p in DEFAULT_SETTINGS:
            if k == key:
                return v
        return default
