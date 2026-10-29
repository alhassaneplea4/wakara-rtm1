"""Turn Django ValidationError / hard-delete attempts into clean API errors."""
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import exception_handler

from core.mixins import HardDeleteForbidden


def wakara_exception_handler(exc, context):
    if isinstance(exc, DjangoValidationError):
        detail = exc.message_dict if hasattr(exc, 'error_dict') else {'detail': exc.messages}
        code = getattr(exc, 'code', None)
        body = dict(detail) if isinstance(detail, dict) else {'detail': detail}
        if code:
            body['code'] = code
        return Response(body, status=status.HTTP_400_BAD_REQUEST)
    if isinstance(exc, HardDeleteForbidden):
        return Response({'detail': str(exc)}, status=status.HTTP_405_METHOD_NOT_ALLOWED)
    return exception_handler(exc, context)
