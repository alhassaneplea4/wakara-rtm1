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
]


def get_setting(key, default=''):
    try:
        return SiteSetting.objects.get(key=key).value
    except SiteSetting.DoesNotExist:
        for k, v, _d, _p in DEFAULT_SETTINGS:
            if k == key:
                return v
        return default
