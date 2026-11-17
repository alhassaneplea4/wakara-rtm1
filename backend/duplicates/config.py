"""
Engine configuration: weights and thresholds are CONFIGURABLE (initial values come from settings and can be
overridden by an administrator through the SiteSetting ``duplicates.config``), never hard-coded in the rules.
"""
import copy
import json
import logging

from django.conf import settings
from django.core.exceptions import ValidationError

log = logging.getLogger(__name__)
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


# Guard rails. Whoever may calibrate the engine must not be able to switch the control off, by mistake or on
# purpose: these limits are in the code (not editable through the API), and are applied when a change is made AND
# every time the stored configuration is read (a value written straight in the database that breaks them is ignored).
GUARDS = {
    'high_threshold': (70, 95),            # a "high risk" level that nothing can reach would disable the blocking
    'medium_threshold': (40, 80),
    'min_weight': {'mother': 20, 'birth_date': 15},   # the two criteria that identify a birth cannot be dwarfed
    'min_quality_for_high': (0, 70),
    'date_window_days': (1, 30),
    'min_recorded_score': (0, 60),
}
MANDATORY_BLOCKING_LEVELS = ('HIGH',)       # an unresolved high-risk case ALWAYS blocks the official number
MIN_REASON_LENGTH = 10


def effective_blocking_levels(levels) -> list:
    """The levels that block the official number: the configured ones, plus the mandatory ones."""
    out = [lv for lv in levels if lv in ('HIGH', 'MEDIUM', 'LOW')]
    for lv in MANDATORY_BLOCKING_LEVELS:
        if lv not in out:
            out.append(lv)
    return out


def default_config() -> dict:
    return {
        'weights': dict(settings.DUPLICATE_WEIGHTS),
        'thresholds': dict(settings.DUPLICATE_THRESHOLDS),
        'min_quality_for_high': settings.DUPLICATE_MIN_QUALITY_FOR_HIGH,
        'blocking_levels': effective_blocking_levels(settings.DUPLICATE_BLOCKING_LEVELS),
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
    for key, floor in GUARDS['min_weight'].items():
        if weights[key] < floor:
            raise ValidationError({'weights': (
                f"« {CRITERIA_LABELS[key]} » doit peser au moins {floor} points : c'est un critère d'identification.")})
    out['weights'] = weights
    th = cfg.get('thresholds', base['thresholds'])
    try:
        high, medium = float(th['high']), float(th['medium'])
    except (KeyError, TypeError, ValueError):
        raise ValidationError({'thresholds': "Seuils attendus : high et medium."})
    if not medium < high:
        raise ValidationError({'thresholds': "Le seuil moyen doit être inférieur au seuil élevé."})
    (h_lo, h_hi), (m_lo, m_hi) = GUARDS['high_threshold'], GUARDS['medium_threshold']
    if not h_lo <= high <= h_hi:
        raise ValidationError({'thresholds': f"Le seuil « risque élevé » doit être compris entre {h_lo} et {h_hi}."})
    if not m_lo <= medium <= m_hi:
        raise ValidationError({'thresholds': f"Le seuil « risque moyen » doit être compris entre {m_lo} et {m_hi}."})
    out['thresholds'] = {'high': high, 'medium': medium}
    for key, (lo, hi) in (('min_quality_for_high', GUARDS['min_quality_for_high']),
                          ('date_window_days', GUARDS['date_window_days']),
                          ('min_recorded_score', GUARDS['min_recorded_score'])):
        if key in cfg:
            try:
                value = int(cfg[key])
            except (TypeError, ValueError):
                raise ValidationError({key: "Valeur numérique attendue."})
            if not lo <= value <= hi:
                raise ValidationError({key: f"Doit être entre {lo} et {hi}."})
            out[key] = value
    if 'blocking_levels' in cfg:
        levels = cfg['blocking_levels']
        if not isinstance(levels, (list, tuple)) or any(lv not in ('HIGH', 'MEDIUM', 'LOW') for lv in levels):
            raise ValidationError({'blocking_levels': "Niveaux possibles : HIGH, MEDIUM, LOW."})
        missing = [lv for lv in MANDATORY_BLOCKING_LEVELS if lv not in levels]
        if missing:
            raise ValidationError({'blocking_levels': (
                "Le niveau « risque élevé » (HIGH) bloque toujours la validation officielle : il ne peut pas être retiré.")})
        out['blocking_levels'] = effective_blocking_levels(levels)
    return out


def get_config() -> dict:
    """Effective configuration (defaults + administrator override when valid)."""
    from core.models import SiteSetting
    row = SiteSetting.objects.filter(key=CONFIG_KEY).first()
    if row and row.value:
        try:
            return validate_config(json.loads(row.value))
        except (ValueError, TypeError, AttributeError, ValidationError):
            # a broken or out-of-bounds override (typed in the database, by hand) must never weaken the control
            # nor stop the detection: the safe defaults apply, and it is said in the log
            log.warning("Configuration des doublons ignorée (invalide ou hors limites) : valeurs par défaut utilisées.")
    return default_config()


def config_meta() -> dict:
    """Who changed the rules last, when and why (shown in the control centre); empty when they are the defaults."""
    from core.models import SiteSetting
    row = SiteSetting.objects.filter(key=CONFIG_KEY).select_related('updated_by').first()
    if not row or not row.value:
        return {'customized': False}
    user = row.updated_by
    return {'customized': get_config() != default_config(), 'updated_at': row.updated_at,
            'updated_by': (user.get_full_name() or user.username) if user else '', 'reason': row.description}
