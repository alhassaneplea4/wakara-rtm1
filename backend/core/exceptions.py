"""Turn Django ValidationError / hard-delete attempts into clean API errors."""
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import exception_handler

from core.mixins import HardDeleteForbidden


class IncompleteConfirmationRequired(Exception):
    """Final validation of a dossier whose expected fields are not all filled: the validator must confirm."""

    def __init__(self, missing, labels):
        super().__init__("Des champs ne sont pas renseignés.")
        self.missing = list(missing)
        self.labels = list(labels)


class VersionConflict(Exception):
    """An edit prepared offline targets a version of the dossier the server no longer holds."""

    def __init__(self, expected, current):
        super().__init__("Le dossier a été modifié sur le serveur depuis votre dernière synchronisation.")
        self.expected = expected
        self.current = current


def wakara_exception_handler(exc, context):
    if isinstance(exc, VersionConflict):
        return Response({'code': 'version_conflict', 'detail': str(exc),
                         'expected_version': exc.expected, 'current_version': exc.current},
                        status=status.HTTP_409_CONFLICT)
    if isinstance(exc, IncompleteConfirmationRequired):
        return Response({
            'code': 'incomplete_confirmation_required',
            'detail': ("Des champs ne sont pas renseignés : " + ', '.join(exc.labels)
                       + ". Confirmez pour valider quand même."),
            'missing_fields': exc.missing, 'missing_labels': exc.labels,
        }, status=status.HTTP_409_CONFLICT)
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
