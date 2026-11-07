"""Reusable field validators (phone numbers, e-mail addresses)."""
import re

from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.validators import validate_email as django_validate_email
from rest_framework import serializers

GUINEA_CODE = '224'
_SEPARATORS = re.compile(r'[\s.\-()]')
PHONE_ERROR = ("Numéro de téléphone invalide. Format attendu : +224 624 62 94 77 "
               "(indicatif puis chiffres uniquement).")


def normalize_phone(value: str) -> str:
    """
    Validate a phone number and return its canonical form.

    - Guinea (+224, or a bare 9-digit national number): ``+224 624 62 94 77``.
    - Any other country: ``+`` followed by 8 to 15 digits, no spaces (E.164).
    Separators (spaces, dots, dashes, parentheses) are tolerated on input; anything else is refused.
    Empty values stay empty (the field is optional).
    """
    raw = (value or '').strip()
    if not raw:
        return ''
    if raw.startswith('00'):
        raw = '+' + raw[2:]
    compact = _SEPARATORS.sub('', raw)
    international = compact.startswith('+')
    digits = compact[1:] if international else compact
    if not digits.isascii() or not digits.isdigit():
        raise serializers.ValidationError(PHONE_ERROR)
    if not international:
        # national number: 9 digits, assumed to be a Guinean one
        digits = GUINEA_CODE + digits
    if digits.startswith(GUINEA_CODE):
        national = digits[len(GUINEA_CODE):]
        if len(national) != 9 or national[0] == '0':
            raise serializers.ValidationError(PHONE_ERROR)
        return f"+{GUINEA_CODE} {national[:3]} {national[3:5]} {national[5:7]} {national[7:]}"
    if not 8 <= len(digits) <= 15 or digits[0] == '0':
        raise serializers.ValidationError(PHONE_ERROR)
    return f"+{digits}"


def validate_email_address(value: str) -> str:
    """Optional e-mail: empty is accepted, anything else must be a well-formed address."""
    value = (value or '').strip()
    if not value:
        return ''
    try:
        django_validate_email(value)
    except DjangoValidationError:
        raise serializers.ValidationError("Adresse e-mail invalide.")
    return value
