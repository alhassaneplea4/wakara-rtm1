"""
Sessions bound to a device.

At sign-in the browser sends the identifier of the device it runs on; it is written in both tokens (claim ``did``)
and can never be changed afterwards (a refresh keeps it). Three consequences:

* the offline synchronisation only accepts a session bound to the device that sends (``sync.views``): a token
  stolen from a phone cannot be used from another device identifier;
* revoking a device cuts its sessions at once, everywhere: the access token is refused on the next request, the
  refresh token is blacklisted and refused too (a revoked device cannot "come back" with a new identifier
  because its tokens stay bound to the old one);
* a user who signs in on a revoked device is refused with a clear message.

Tokens without ``did`` (issued before this rule, or by a client that did not send the identifier) keep working
for the online application but are refused by the synchronisation, which asks the agent to sign in again.
"""
import uuid as uuidlib

from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.authentication import JWTAuthentication

DEVICE_CLAIM = 'did'
SESSION_CLAIM = 'sv'
DEVICE_REVOKED_MESSAGE = "Cet appareil a été révoqué par l'administrateur."


def clean_device_id(value):
    """A well-formed device identifier as a string, or None."""
    try:
        return str(uuidlib.UUID(str(value)))
    except (ValueError, AttributeError, TypeError):
        return None


def device_of_token(token):
    """Identifier of the device a validated token is bound to (None when it is not bound)."""
    if token is None:
        return None
    try:
        return clean_device_id(token.get(DEVICE_CLAIM))
    except AttributeError:
        return None


def is_device_revoked(user_id, device_id) -> bool:
    from sync.models import Device
    did = clean_device_id(device_id)
    return bool(did) and Device.objects.filter(user_id=user_id, device_id=did, is_revoked=True).exists()


def _check_session_still_valid(user, token):
    """A signed-out access token, or one issued before the account's sessions were cut, is refused at once."""
    from .models import RevokedAccessToken
    if int(token.get(SESSION_CLAIM, 0)) != user.session_version:
        raise AuthenticationFailed('Session terminée : reconnectez-vous.', code='session_ended')
    if RevokedAccessToken.objects.filter(jti=token.get('jti', '')).exists():
        raise AuthenticationFailed('Session terminée : reconnectez-vous.', code='session_ended')


class DeviceAwareJWTAuthentication(JWTAuthentication):
    """Standard JWT authentication, plus: a token bound to a revoked device is refused (401, code device_revoked)."""

    def get_user(self, validated_token):
        user = super().get_user(validated_token)
        _check_session_still_valid(user, validated_token)
        if is_device_revoked(user.pk, device_of_token(validated_token)):
            raise AuthenticationFailed(DEVICE_REVOKED_MESSAGE, code='device_revoked')
        return user
