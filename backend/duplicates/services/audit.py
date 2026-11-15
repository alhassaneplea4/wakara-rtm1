"""DuplicateAuditService: protected history of each case + entries in the global audit log."""
import datetime

from django.utils import timezone

from audit import service as audit
from audit.models import AuditAction
from duplicates.models import DuplicateReviewHistory

SYSTEM_NAME = 'Système'
VIEW_DEDUP_MINUTES = 10


def actor_name(user) -> str:
    if user is None or not getattr(user, 'is_authenticated', False):
        return SYSTEM_NAME
    return user.get_full_name() or user.username


class DuplicateAuditService:
    @staticmethod
    def record(case, action, user=None, note='', detail=None):
        """Append one row to the case history (append-only)."""
        return DuplicateReviewHistory.objects.create(
            case=case, action=action,
            actor=user if user is not None and getattr(user, 'is_authenticated', False) else None,
            actor_name=actor_name(user), note=note or '', detail=detail or {})

    @classmethod
    def record_view(cls, case, user, action, detail=None):
        """
        Sensitive consultation (comparison, supporting document): traced in the case history and in the
        audit log. The same user opening the same thing repeatedly is only written once per few minutes.
        """
        since = timezone.now() - datetime.timedelta(minutes=VIEW_DEDUP_MINUTES)
        key = (detail or {}).get('document')
        recent = DuplicateReviewHistory.objects.filter(case=case, action=action, actor=user, at__gte=since)
        if key:
            recent = [h for h in recent if (h.detail or {}).get('document') == key]
        if not recent:
            cls.record(case, action, user, detail=detail)
        audit.log(AuditAction.DUPLICATE_VIEWED, user=user, obj=case, changes={'action': action, **(detail or {})})

    @staticmethod
    def log(action, user=None, obj=None, changes=None, reason='', **kwargs):
        return audit.log(action, user=user, obj=obj, changes=changes, reason=reason, **kwargs)

    @staticmethod
    def log_check(user, declaration, check):
        return audit.log(AuditAction.DUPLICATE_CHECK, user=user, obj=declaration, changes={
            'trigger': check.trigger, 'candidates': check.candidates_examined,
            'matches': check.matches_found, 'highest_score': check.highest_score})
