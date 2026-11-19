"""
Recovery codes of the offline devices.

The code that unlocks a device (the PIN) never leaves it: the data of the device are encrypted with a random key
that only the PIN opens. To spare an agent who forgot his PIN the loss of what he has not sent yet, the device
ALSO wraps that key with a random *recovery code* (120 bits, generated on the device, never shown to the agent) and
registers the code here. The administrator, and only the one holding ``device.recover``, can read it back — after
typing his own password, with a written reason, every reading being audited — and give it to the agent over the
phone. The code opens nothing by itself: it is useless without the device, and the server already holds every
dossier that was synchronised.

The code is stored encrypted (core.secretbox: Fernet under ``FIELD_ENCRYPTION_KEY``, or a key derived from
``SECRET_KEY``), so that a copy of the database alone does not reveal it.
"""
import re

from core import secretbox

# Crockford base32 (no I, L, O, U): easy to read out over the phone. 24 characters = 120 bits, in groups of 4.
ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
CODE_LENGTH = 24
_CODE_RE = re.compile(rf'^[{ALPHABET}]{{{CODE_LENGTH}}}$')


def normalize(raw: str) -> str:
    """The code as stored and displayed (``ABCD-EFGH-…``), or '' when ``raw`` is not a valid code."""
    text = re.sub(r'[^0-9A-Za-z]', '', raw or '').upper().replace('O', '0').replace('I', '1').replace('L', '1')
    if not _CODE_RE.match(text):
        return ''
    return '-'.join(text[i:i + 4] for i in range(0, CODE_LENGTH, 4))


def encrypt(code: str) -> str:
    return secretbox.seal('recovery', code)


def decrypt(blob: str) -> str | None:
    """The code, or None when there is none or it cannot be read any more (the encryption key changed)."""
    return secretbox.open_box('recovery', blob)
