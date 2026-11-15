"""BirthIdentityService: builds the normalised, comparison-ready copy of a declaration."""
import hashlib
import json

from declarations.models import Parent
from duplicates import text
from duplicates.config import ENGINE_VERSION
from duplicates.models import BirthIdentity

# (label, weight) of what makes an identity useful for matching; drives the data-quality indicator.
QUALITY_ITEMS = [
    ('Nom de la mère', 25), ('Date de naissance', 20), ('Lieu de naissance', 10), ('Heure de naissance', 10),
    ('Nom du père', 8), ("Nom de l'enfant", 8), ('Sexe', 4), ('Établissement', 5), ('Contact des parents', 5),
    ('Rang de naissance', 5),
]


class BirthIdentityService:
    @staticmethod
    def build_fields(declaration) -> dict:
        child = getattr(declaration, 'child', None)
        parents = {p.parent_type: p for p in declaration.parents.all() if not p.is_archived}
        mother, father = parents.get(Parent.MOTHER), parents.get(Parent.FATHER)

        def parent_fields(prefix, p):
            return {
                f'{prefix}_name_key': text.name_key(p.first_names, p.last_name) if p else '',
                f'{prefix}_phonetic': text.phonetic_key(f"{p.first_names} {p.last_name}") if p else '',
                f'{prefix}_dob': p.date_of_birth if p else None,
                f'{prefix}_birth_place_norm': text.normalize_place(p.birth_place) if p else '',
                f'{prefix}_phone_norm': text.normalize_phone(p.phone) if p else '',
                f'{prefix}_address_norm': text.normalize_place(p.address) if p else '',
                f'{prefix}_id_norm': text.normalize_id(p.id_number) if p else '',
            }

        fields = {
            'child_name_key': text.name_key(child.first_names, child.last_name) if child else '',
            'child_phonetic': text.phonetic_key(f"{child.first_names} {child.last_name}") if child else '',
            'gender': (child.gender if child else '') or '',
            'birth_date': declaration.birth_date,
            'birth_time': declaration.birth_time,
            'birth_rank': child.birth_rank if child else None,
            'birth_place_norm': text.normalize_place(declaration.birth_place),
            'hospital_id': declaration.hospital_id,
            'hospital_ref_norm': text.normalize_id(declaration.hospital_document_ref),
        }
        fields.update(parent_fields('mother', mother))
        fields.update(parent_fields('father', father))
        return fields

    @staticmethod
    def quality_of(fields: dict):
        present = {
            'Nom de la mère': bool(fields['mother_name_key']),
            'Date de naissance': bool(fields['birth_date']),
            'Lieu de naissance': bool(fields['birth_place_norm'] or fields['hospital_id']),
            'Heure de naissance': bool(fields['birth_time']),
            'Nom du père': bool(fields['father_name_key']),
            "Nom de l'enfant": bool(fields['child_name_key']),
            'Sexe': bool(fields['gender']),
            'Établissement': bool(fields['hospital_id']),
            'Contact des parents': bool(fields['mother_phone_norm'] or fields['mother_address_norm']
                                        or fields['father_phone_norm']),
            'Rang de naissance': fields['birth_rank'] is not None,
        }
        total = sum(w for _, w in QUALITY_ITEMS)
        got = sum(w for label, w in QUALITY_ITEMS if present[label])
        missing = [label for label, _ in QUALITY_ITEMS if not present[label]]
        return round(100 * got / total), missing

    @staticmethod
    def hash_of(fields: dict) -> str:
        payload = json.dumps(fields, sort_keys=True, default=str, ensure_ascii=False)
        return hashlib.sha256(payload.encode('utf-8')).hexdigest()

    @classmethod
    def refresh(cls, declaration):
        """
        Create or update the identity. Returns (identity, changed). The row is only written when the
        normalised data really changed, so ``computed_at`` marks the last genuine change.
        """
        fields = cls.build_fields(declaration)
        quality, missing = cls.quality_of(fields)
        data_hash = cls.hash_of(fields)
        identity = BirthIdentity.objects.filter(declaration=declaration).first()
        if identity and identity.data_hash == data_hash and identity.engine_version == ENGINE_VERSION:
            return identity, False
        values = {**fields, 'data_hash': data_hash, 'data_quality': quality, 'missing_fields': missing,
                  'engine_version': ENGINE_VERSION}
        if identity is None:
            identity = BirthIdentity.objects.create(declaration=declaration, **values)
            return identity, True
        for k, v in values.items():
            setattr(identity, k, v)
        identity.save()
        return identity, True
