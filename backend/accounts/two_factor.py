"""
Second factor of the sign-in: a time-based one-time code (TOTP, RFC 6238) from an authentication application
(Google Authenticator, Microsoft Authenticator, Aegis, FreeOTP…). No SMS and no external service: the code is computed
on the phone from a secret shared once, and works without any network.

- The secret is stored encrypted (core.secretbox) and a code is accepted once (``totp_last_step``).
- Eight one-time backup codes replace the application when the phone is lost (only a keyed hash is kept).
- The administrator can require it from some roles (setting ``security.two_factor_roles``) and can reset it for an
  account whose phone is lost (never his own: a stolen session must not be able to switch the factor off).
"""
import base64
import hashlib
import hmac
import re
import secrets
import struct
import time
from urllib.parse import quote

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from core import secretbox
from core.models import get_setting

STEP_SECONDS = 30
DIGITS = 6
WINDOW = 1                     # one step either side: a phone clock a few seconds off still works
BACKUP_COUNT = 8
BACKUP_LENGTH = 10
_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
ISSUER = 'Wakara'


def _now() -> float:
    return time.time()


def new_secret() -> str:
    """160 random bits, base32 (what the applications expect)."""
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip('=')


def _hotp(secret_b32: str, counter: int) -> str:
    key = base64.b32decode(secret_b32 + '=' * (-len(secret_b32) % 8))
    digest = hmac.new(key, struct.pack('>Q', counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = (struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 10 ** DIGITS
    return f'{value:0{DIGITS}d}'


def code_at(secret_b32: str, at: float | None = None) -> str:
    """The code the application shows at time ``at`` (used by the tests)."""
    return _hotp(secret_b32, int((_now() if at is None else at) // STEP_SECONDS))


def otpauth_uri(user, secret_b32: str) -> str:
    return (f"otpauth://totp/{quote(ISSUER)}:{quote(user.username)}?secret={secret_b32}&issuer={quote(ISSUER)}"
            f"&algorithm=SHA1&digits={DIGITS}&period={STEP_SECONDS}")


def required_for(user) -> bool:
    """Do the roles of this account have to use the second factor? (setting ``security.two_factor_roles``)"""
    roles = [c.strip() for c in get_setting('security.two_factor_roles', '').split(',') if c.strip()]
    if not roles:
        return False
    if 'all' in roles or '*' in roles:
        return True
    return user.user_roles.filter(is_active=True, role__is_active=True, role__codename__in=roles).exists()


def verify_totp(user, raw: str, at: float | None = None) -> bool:
    """A valid code of the user's secret, not used before. A good code is consumed."""
    code = re.sub(r'\D', '', raw or '')
    secret = secretbox.open_box('totp', user.totp_secret)
    if len(code) != DIGITS or not secret:
        return False
    now_step = int((_now() if at is None else at) // STEP_SECONDS)
    matched = None
    for offset in range(-WINDOW, WINDOW + 1):       # every step is compared: the time taken does not tell which one matched
        step = now_step + offset
        if hmac.compare_digest(_hotp(secret, step), code):
            matched = step
    if matched is None or matched <= user.totp_last_step:
        return False
    User = get_user_model()
    # atomic: two requests with the same code cannot both succeed
    if User.objects.filter(pk=user.pk, totp_last_step__lt=matched).update(totp_last_step=matched):
        user.totp_last_step = matched
        return True
    return False


def _normalize_backup(raw: str) -> str:
    text = re.sub(r'[^0-9A-Za-z]', '', raw or '').upper().replace('O', '0').replace('I', '1').replace('L', '1')
    return text if len(text) == BACKUP_LENGTH and all(c in _ALPHABET for c in text) else ''


def generate_backup_codes(user) -> list[str]:
    """Eight new one-time codes (the previous ones stop working). Shown once, kept only as hashes."""
    from .models import TwoFactorBackupCode
    codes = [''.join(secrets.choice(_ALPHABET) for _ in range(BACKUP_LENGTH)) for _ in range(BACKUP_COUNT)]
    with transaction.atomic():
        TwoFactorBackupCode.objects.filter(user=user).delete()
        TwoFactorBackupCode.objects.bulk_create([
            TwoFactorBackupCode(user=user, code_hash=secretbox.fingerprint('backup', c)) for c in codes])
    return [f'{c[:5]}-{c[5:]}' for c in codes]


def backup_codes_left(user) -> int:
    from .models import TwoFactorBackupCode
    return TwoFactorBackupCode.objects.filter(user=user, used_at__isnull=True).count()


def _use_backup_code(user, raw: str) -> bool:
    from .models import TwoFactorBackupCode
    code = _normalize_backup(raw)
    if not code:
        return False
    return bool(TwoFactorBackupCode.objects.filter(
        user=user, code_hash=secretbox.fingerprint('backup', code), used_at__isnull=True).update(used_at=timezone.now()))


def verify_login_code(user, raw: str) -> bool:
    """The code typed at sign-in: six digits from the application, or one of the backup codes."""
    if re.fullmatch(r'\d{3}\s?\d{3}', (raw or '').strip()):
        return verify_totp(user, raw)
    return _use_backup_code(user, raw)


# ── set-up ────────────────────────────────────────

def begin_setup(user) -> str:
    """A new secret waits on the account until a code proves the application holds it."""
    secret = new_secret()
    user.totp_secret = secretbox.seal('totp', secret)
    user.totp_last_step = 0
    user.save(update_fields=['totp_secret', 'totp_last_step', 'updated_at'])
    return secret


def pending_secret(user) -> str | None:
    return secretbox.open_box('totp', user.totp_secret)


def confirm_setup(user, raw_code: str) -> list[str] | None:
    """Turns the second factor on when ``raw_code`` comes from the pending secret. Returns the backup codes, or None."""
    if user.two_factor_enabled or not verify_totp(user, raw_code):
        return None
    user.two_factor_enabled = True
    user.two_factor_enabled_at = timezone.now()
    user.save(update_fields=['two_factor_enabled', 'two_factor_enabled_at', 'updated_at'])
    return generate_backup_codes(user)


def clear(user) -> None:
    """Switches the second factor off and forgets its secret and codes."""
    from .models import TwoFactorBackupCode
    user.two_factor_enabled = False
    user.two_factor_enabled_at = None
    user.totp_secret = ''
    user.totp_last_step = 0
    user.save(update_fields=['two_factor_enabled', 'two_factor_enabled_at', 'totp_secret', 'totp_last_step', 'updated_at'])
    TwoFactorBackupCode.objects.filter(user=user).delete()
