"""
Small secrets kept in the database: the recovery codes of the offline devices and the second-factor secrets.

Each secret is encrypted (Fernet: AES-128-CBC + HMAC-SHA256) under a key derived, per purpose, from
``FIELD_ENCRYPTION_KEY`` — or, when it is not defined, from ``SECRET_KEY``. A copy of the database alone therefore
does not reveal them. Changing the key makes the stored secrets unreadable (``open_box`` returns None): define
``FIELD_ENCRYPTION_KEY`` once and keep it, and a later change of ``SECRET_KEY`` leaves them untouched.
"""
import base64
import hashlib
import hmac

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings


def _material() -> bytes:
    return (getattr(settings, 'FIELD_ENCRYPTION_KEY', '') or settings.SECRET_KEY).encode()


def _derived(purpose: str) -> bytes:
    return hmac.new(_material(), f'wakara-{purpose}-v1'.encode(), hashlib.sha256).digest()


def seal(purpose: str, text: str) -> str:
    """``text`` encrypted for ``purpose`` ('recovery', 'totp'…), as a string fit for a text column."""
    return Fernet(base64.urlsafe_b64encode(_derived(purpose))).encrypt(text.encode()).decode()


def open_box(purpose: str, blob: str) -> str | None:
    """The text, or None when there is none or it cannot be read any more (the encryption key changed)."""
    if not blob:
        return None
    try:
        return Fernet(base64.urlsafe_b64encode(_derived(purpose))).decrypt(blob.encode()).decode()
    except (InvalidToken, ValueError):
        return None


def fingerprint(purpose: str, text: str) -> str:
    """A keyed hash of ``text`` (to store one-time codes without keeping them)."""
    return hmac.new(_derived(purpose), text.encode(), hashlib.sha256).hexdigest()
