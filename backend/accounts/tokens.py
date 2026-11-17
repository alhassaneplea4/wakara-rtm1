"""Tokens bound to a device: issuing, refreshing and revoking them (see accounts.authentication)."""
import jwt
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.serializers import TokenRefreshSerializer
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenRefreshView

from .authentication import (
    DEVICE_CLAIM, DEVICE_REVOKED_MESSAGE, clean_device_id, device_of_token, is_device_revoked,
)


def tokens_for(user, device_id=None) -> RefreshToken:
    """A refresh token (its ``access_token`` inherits the claim) bound to ``device_id`` when it is known."""
    refresh = RefreshToken.for_user(user)
    did = clean_device_id(device_id)
    if did:
        refresh[DEVICE_CLAIM] = did
        # the blacklist app stored the token before the claim existed: store it again with the claim, so that a
        # revocation can tell which device each outstanding token belongs to
        OutstandingToken.objects.filter(jti=refresh[api_settings.JTI_CLAIM]).update(token=str(refresh))
    return refresh


class DeviceAwareRefreshSerializer(TokenRefreshSerializer):
    def validate(self, attrs):
        try:
            token = RefreshToken(attrs['refresh'])
        except TokenError as exc:
            raise InvalidToken(exc.args[0])
        if is_device_revoked(token.get(api_settings.USER_ID_CLAIM), device_of_token(token)):
            raise InvalidToken(DEVICE_REVOKED_MESSAGE)
        return super().validate(attrs)


class DeviceAwareTokenRefreshView(TokenRefreshView):
    serializer_class = DeviceAwareRefreshSerializer


def revoke_device_tokens(user, device_id) -> int:
    """
    Blacklist the refresh tokens that could still serve the revoked device: the ones bound to it and the ones
    bound to nothing (older sessions: they could be on that very device). Sessions bound to the user's other
    devices are left alone. Returns how many tokens were blacklisted.
    """
    did = clean_device_id(device_id)
    done = 0
    for outstanding in OutstandingToken.objects.filter(user=user):
        try:
            claim = clean_device_id(jwt.decode(outstanding.token, options={'verify_signature': False}).get(DEVICE_CLAIM))
        except jwt.PyJWTError:
            claim = None
        if claim is None or claim == did:
            _, created = BlacklistedToken.objects.get_or_create(token=outstanding)
            done += int(created)
    return done
