"""
DuplicateScoringService — similarity score (0-100) between two normalised identities.

Principles
  * Weighted criteria (configurable): mother 30, birth date 25, birth place 15, birth time 10, father 10,
    complementary information 10.
  * A criterion that cannot be compared (information missing on either side) is EXCLUDED from numerator
    and denominator: missing data never earns artificial points. The score is normalised on the weight
    that was really comparable, and ``data_quality`` tells how much of the 100 points that represents.
  * Risk: >= 85 high, 60-84 medium, < 60 low (configurable). Guards keep the classification honest:
      - clearly different mothers without two other strong agreements → LOW;
      - not enough comparable data              → HIGH is capped to MEDIUM;
      - nothing besides mother + date + place   → HIGH is capped to MEDIUM (twins share exactly that);
      - signs of a multiple birth               → HIGH is capped to MEDIUM and flagged.
  * The score is an aid to a human decision, NEVER a legal conclusion.
"""
from duplicates import text
from duplicates.config import COMPLEMENTARY_LABELS, COMPLEMENTARY_PARTS, CRITERIA, CRITERIA_LABELS
from duplicates.models import RiskLevel


def _criterion(key, weight, similarity=None, *, detail='', exact=False, parts=None):
    comparable = similarity is not None
    return {
        'key': key, 'label': CRITERIA_LABELS[key], 'weight': weight,
        'comparable': comparable,
        'similarity': round(similarity, 3) if comparable else None,
        'points': round(weight * similarity, 2) if comparable else 0.0,
        'exact': bool(exact and comparable and similarity >= 0.999),
        'detail': detail, 'parts': parts or [],
    }


def _weighted(parts):
    """Combine sub-parts [(label, weight, similarity|None, detail)] on the comparable ones only."""
    usable = [p for p in parts if p[2] is not None]
    if not usable:
        return None, []
    total = sum(p[1] for p in usable)
    value = sum(p[1] * p[2] for p in usable) / total
    rendered = [{'label': p[0], 'weight': p[1], 'similarity': None if p[2] is None else round(p[2], 3),
                 'detail': p[3]} for p in parts]
    return value, rendered


class DuplicateScoringService:
    # ── per-criterion similarities ───────────────

    @staticmethod
    def _person(a, b, prefix, name_w, dob_w, contact_w):
        ka, kb = getattr(a, f'{prefix}_name_key'), getattr(b, f'{prefix}_name_key')
        if not ka or not kb:
            return None, []
        name_sim = text.name_similarity(ka, kb)
        dob_a, dob_b = getattr(a, f'{prefix}_dob'), getattr(b, f'{prefix}_dob')
        dob_sim = text.date_similarity(dob_a, dob_b) if dob_a and dob_b else None
        pa, pb = getattr(a, f'{prefix}_phone_norm'), getattr(b, f'{prefix}_phone_norm')
        ia, ib = getattr(a, f'{prefix}_id_norm'), getattr(b, f'{prefix}_id_norm')
        contact_sim = None
        if pa and pb:
            contact_sim = 1.0 if pa == pb else 0.0
        elif ia and ib:
            contact_sim = 1.0 if ia == ib else 0.0
        parts = [
            ('Nom et prénoms', name_w, name_sim, f"{ka} ≈ {kb}"),
            ('Date de naissance', dob_w, dob_sim, f"{dob_a} / {dob_b}" if dob_sim is not None else 'non comparable'),
            ('Téléphone / pièce d\'identité', contact_w, contact_sim, 'non comparable' if contact_sim is None else
             ('identique' if contact_sim else 'différent')),
        ]
        return _weighted(parts)

    @classmethod
    def _complementary(cls, a, b):
        parts = []
        ca, cb = a.child_name_key, b.child_name_key
        parts.append((COMPLEMENTARY_LABELS['child_name'], COMPLEMENTARY_PARTS['child_name'],
                      text.name_similarity(ca, cb) if ca and cb else None, f"{ca or '—'} / {cb or '—'}"))
        parts.append((COMPLEMENTARY_LABELS['gender'], COMPLEMENTARY_PARTS['gender'],
                      (1.0 if a.gender == b.gender else 0.0) if a.gender and b.gender else None,
                      f"{a.gender or '—'} / {b.gender or '—'}"))
        parts.append((COMPLEMENTARY_LABELS['birth_rank'], COMPLEMENTARY_PARTS['birth_rank'],
                      (1.0 if a.birth_rank == b.birth_rank else 0.0)
                      if a.birth_rank is not None and b.birth_rank is not None else None,
                      f"{a.birth_rank or '—'} / {b.birth_rank or '—'}"))
        parts.append((COMPLEMENTARY_LABELS['hospital'], COMPLEMENTARY_PARTS['hospital'],
                      (1.0 if a.hospital_id == b.hospital_id else 0.0)
                      if a.hospital_id and b.hospital_id else None, 'même établissement'
                      if a.hospital_id and a.hospital_id == b.hospital_id else 'établissements différents ou inconnus'))
        parts.append((COMPLEMENTARY_LABELS['hospital_ref'], COMPLEMENTARY_PARTS['hospital_ref'],
                      (1.0 if a.hospital_ref_norm == b.hospital_ref_norm else 0.0)
                      if a.hospital_ref_norm and b.hospital_ref_norm else None,
                      f"{a.hospital_ref_norm or '—'} / {b.hospital_ref_norm or '—'}"))
        addr = None
        for prefix in ('mother', 'father'):
            x, y = getattr(a, f'{prefix}_address_norm'), getattr(b, f'{prefix}_address_norm')
            if x and y:
                s = text.place_similarity(x, y)
                addr = s if addr is None else max(addr, s)
        parts.append((COMPLEMENTARY_LABELS['parent_contact'], COMPLEMENTARY_PARTS['parent_contact'], addr,
                      'adresse comparée' if addr is not None else 'non comparable'))
        return _weighted(parts)

    # ── multiple-birth hints ─────────────────────

    @staticmethod
    def _distinguishing(a, b, mother_sim):
        """Elements that tell the two records may be two different children of the same mother."""
        out = []
        if a.gender and b.gender and a.gender != b.gender:
            out.append('Sexe différent')
        if a.birth_rank is not None and b.birth_rank is not None and a.birth_rank != b.birth_rank:
            out.append('Rang de naissance différent')
        if a.child_name_key and b.child_name_key:
            ta, tb = a.child_name_key.split(), b.child_name_key.split()
            # first names only differ clearly when no token is alike (last names are usually shared)
            if text.name_similarity(a.child_name_key, b.child_name_key) < 0.5 and not set(ta) & set(tb):
                out.append("Noms de l'enfant différents")
        if a.birth_time and b.birth_time and text.minutes_between(a.birth_time, b.birth_time) >= 5:
            out.append("Heures de naissance différentes")
        return out

    # ── main entry point ─────────────────────────

    @classmethod
    def score(cls, a, b, config: dict) -> dict:
        """Score the pair (a, b) of BirthIdentity. Pure: no database writes."""
        w = config['weights']
        criteria = {}

        mother_sim, mother_parts = cls._person(a, b, 'mother', 0.6, 0.25, 0.15)
        criteria['mother'] = _criterion('mother', w['mother'], mother_sim, exact=True, parts=mother_parts,
                                        detail='' if mother_sim is not None else 'Nom de la mère manquant')

        date_sim = text.date_similarity(a.birth_date, b.birth_date) if a.birth_date and b.birth_date else None
        criteria['birth_date'] = _criterion(
            'birth_date', w['birth_date'], date_sim, exact=True,
            detail=f"{a.birth_date} / {b.birth_date}" if date_sim is not None else 'Date manquante')

        place_sim, place_detail = None, 'Lieu non comparable'
        if a.birth_place_norm and b.birth_place_norm:
            place_sim = text.place_similarity(a.birth_place_norm, b.birth_place_norm)
            place_detail = f"{a.birth_place_norm} ≈ {b.birth_place_norm}"
        criteria['birth_place'] = _criterion('birth_place', w['birth_place'], place_sim, exact=True,
                                             detail=place_detail)

        time_sim = text.time_similarity(a.birth_time, b.birth_time) if a.birth_time and b.birth_time else None
        criteria['birth_time'] = _criterion(
            'birth_time', w['birth_time'], time_sim, exact=True,
            detail=f"{a.birth_time:%H:%M} / {b.birth_time:%H:%M}" if time_sim is not None else 'Heure manquante')

        father_sim, father_parts = cls._person(a, b, 'father', 0.7, 0.15, 0.15)
        criteria['father'] = _criterion('father', w['father'], father_sim, exact=True, parts=father_parts,
                                        detail='' if father_sim is not None else 'Nom du père manquant')

        comp_sim, comp_parts = cls._complementary(a, b)
        criteria['complementary'] = _criterion('complementary', w['complementary'], comp_sim, parts=comp_parts,
                                               detail='' if comp_sim is not None else 'Aucune information comparable')

        comparable = sum(c['weight'] for c in criteria.values() if c['comparable'])
        earned = sum(c['points'] for c in criteria.values())
        total_weight = sum(w[k] for k in CRITERIA) or 100
        score = round(100 * earned / comparable, 1) if comparable else 0.0
        quality = round(100 * comparable / total_weight)

        th = config['thresholds']
        risk = (RiskLevel.HIGH if score >= th['high'] else RiskLevel.MEDIUM if score >= th['medium']
                else RiskLevel.LOW)

        flags, caps = {}, []
        same_day = bool(a.birth_date and a.birth_date == b.birth_date)
        distinguishing = cls._distinguishing(a, b, mother_sim or 0)
        # a different hour alone is weak (typing error, or twins): it only counts when the children do not
        # carry the same name; sex, rank or clearly different names are strong signs on their own
        strong = [d for d in distinguishing if not d.startswith('Heures')]
        same_child_name = bool(a.child_name_key and b.child_name_key
                               and text.name_similarity(a.child_name_key, b.child_name_key) >= 0.8)
        twin = bool(mother_sim is not None and mother_sim >= 0.85 and same_day
                    and (strong or (distinguishing and not same_child_name)))
        flags['distinguishing'] = distinguishing
        flags['twin_suspected'] = twin

        # What corroborates "same child" beyond mother + date + place (twins share exactly those three).
        child_part = next((p for p in comp_parts if p['label'] == COMPLEMENTARY_LABELS['child_name']), None)
        ref_part = next((p for p in comp_parts if p['label'] == COMPLEMENTARY_LABELS['hospital_ref']), None)
        corroboration = []
        if child_part and (child_part['similarity'] or 0) >= 0.8:
            corroboration.append("Nom de l'enfant")
        if time_sim is not None and time_sim >= 0.7:
            corroboration.append('Heure de naissance')
        if father_sim is not None and father_sim >= 0.8:
            corroboration.append('Identité du père')
        if ref_part and (ref_part['similarity'] or 0) >= 1:
            corroboration.append('Référence hospitalière')
        flags['corroboration'] = corroboration

        if risk == RiskLevel.HIGH:
            if quality < config.get('min_quality_for_high', 0):
                risk = RiskLevel.MEDIUM
                caps.append("Données comparables insuffisantes pour retenir un risque élevé")
            elif twin:
                risk = RiskLevel.MEDIUM
                caps.append("Indices de naissance multiple : à vérifier avant toute conclusion")
            elif not corroboration:
                risk = RiskLevel.MEDIUM
                caps.append("Seuls la mère, la date et le lieu concordent : insuffisant pour conclure")
        if risk != RiskLevel.LOW and mother_sim is not None and mother_sim < 0.45 and len(corroboration) < 2:
            risk = RiskLevel.LOW
            caps.append("Mères clairement différentes et aucune autre concordance forte")
        flags['risk_caps'] = caps
        flags['raw_risk'] = (RiskLevel.HIGH if score >= th['high'] else RiskLevel.MEDIUM
                             if score >= th['medium'] else RiskLevel.LOW)

        return {
            'score': score, 'raw_points': round(earned, 2), 'comparable_points': round(comparable, 2),
            'data_quality': quality, 'risk_level': risk, 'criteria': criteria, 'flags': flags,
        }
