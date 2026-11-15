"""
Engine configuration: weights and thresholds are CONFIGURABLE (initial values come from settings and can be
overridden by an administrator through the SiteSetting ``duplicates.config``), never hard-coded in the rules.
"""
import copy
import json

from django.conf import settings
from django.core.exceptions import ValidationError

ENGINE_VERSION = '1.0'
CONFIG_KEY = 'duplicates.config'

CRITERIA = ['mother', 'birth_date', 'birth_place', 'birth_time', 'father', 'complementary']
CRITERIA_LABELS = {
    'mother': 'Identité de la mère', 'birth_date': "Date de naissance de l'enfant",
    'birth_place': 'Lieu de naissance', 'birth_time': 'Heure de naissance',
    'father': 'Identité du père', 'complementary': 'Informations complémentaires',
}
# Relative share of the "complementary" weight given to each sub-criterion (renormalised when some are missing).
COMPLEMENTARY_PARTS = {'child_name': 3, 'gender': 2, 'birth_rank': 1, 'hospital': 2, 'hospital_ref': 1,
                       'parent_contact': 1}
COMPLEMENTARY_LABELS = {
    'child_name': "Nom de l'enfant", 'gender': 'Sexe', 'birth_rank': 'Rang de naissance',
    'hospital': 'Établissement sanitaire', 'hospital_ref': 'Référence hospitalière',
    'parent_contact': 'Adresse / contact des parents',
}
# A pair scoring below this is not even recorded (pure noise).
MIN_RECORDED_SCORE = 40
CANDIDATE_LIMIT = 400


def default_config() -> dict:
    return {
        'weights': dict(settings.DUPLICATE_WEIGHTS),
        'thresholds': dict(settings.DUPLICATE_THRESHOLDS),
        'min_quality_for_high': settings.DUPLICATE_MIN_QUALITY_FOR_HIGH,
        'blocking_levels': list(settings.DUPLICATE_BLOCKING_LEVELS),
        'date_window_days': settings.DUPLICATE_DATE_WINDOW_DAYS,
        'min_recorded_score': MIN_RECORDED_SCORE,
    }


def validate_config(cfg: dict) -> dict:
    """Return a clean config or raise ValidationError."""
    base = default_config()
    out = copy.deepcopy(base)
    weights = cfg.get('weights', base['weights'])
    if set(weights) != set(CRITERIA):
        raise ValidationError({'weights': f"Critères attendus : {', '.join(CRITERIA)}."})
    try:
        weights = {k: float(v) for k, v in weights.items()}
    except (TypeError, ValueError):
        raise ValidationError({'weights': "Les pondérations doivent être des nombres."})
    if any(w < 0 for w in weights.values()) or sum(weights.values()) <= 0:
        raise ValidationError({'weights': "Les pondérations doivent être positives."})
    if abs(sum(weights.values()) - 100) > 0.01:
        raise ValidationError({'weights': "La somme des pondérations doit faire 100."})
    out['weights'] = weights
    th = cfg.get('thresholds', base['thresholds'])
    try:
        high, medium = float(th['high']), float(th['medium'])
    except (KeyError, TypeError, ValueError):
        raise ValidationError({'thresholds': "Seuils attendus : high et medium."})
    if not (0 < medium < high <= 100):
        raise ValidationError({'thresholds': "Il faut 0 < seuil moyen < seuil élevé ≤ 100."})
    out['thresholds'] = {'high': high, 'medium': medium}
    for key, lo, hi in (('min_quality_for_high', 0, 100), ('date_window_days', 0, 30),
                        ('min_recorded_score', 0, 100)):
        if key in cfg:
            try:
                value = int(cfg[key])
            except (TypeError, ValueError):
                raise ValidationError({key: "Valeur numérique attendue."})
            if not lo <= value <= hi:
                raise ValidationError({key: f"Doit être entre {lo} et {hi}."})
            out[key] = value
    if 'blocking_levels' in cfg:
        levels = list(cfg['blocking_levels'])
        if any(lv not in ('HIGH', 'MEDIUM', 'LOW') for lv in levels):
            raise ValidationError({'blocking_levels': "Niveaux possibles : HIGH, MEDIUM, LOW."})
        out['blocking_levels'] = levels
    return out


def get_config() -> dict:
    """Effective configuration (defaults + administrator override when valid)."""
    from core.models import SiteSetting
    row = SiteSetting.objects.filter(key=CONFIG_KEY).first()
    if row and row.value:
        try:
            return validate_config(json.loads(row.value))
        except (ValueError, ValidationError):
            pass  # a broken override must never stop the detection: fall back to the defaults
    return default_config()
