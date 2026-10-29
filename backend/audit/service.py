"""Audit service: the only place that writes to AuditLog."""
import datetime
import decimal
import uuid as uuid_lib

from .middleware import get_request_context
from .models import AuditLog

SENSITIVE_KEYS = ('password', 'token', 'secret', 'refresh', 'access', 'authorization')


def _scrub(value):
    if isinstance(value, dict):
        return {
            k: ('***' if any(s in k.lower() for s in SENSITIVE_KEYS) else _scrub(v))
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_scrub(v) for v in value]
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, (uuid_lib.UUID, decimal.Decimal)):
        return str(value)
    return value


def snapshot(instance, fields):
    """Plain dict of the audited fields of a model instance."""
    data = {}
    for name in fields:
        value = getattr(instance, name, None)
        if hasattr(value, 'pk') and not isinstance(value, (str, int)):
            value = str(value)
        data[name] = value
    return _scrub(data)


def diff(before: dict, after: dict) -> dict:
    """{field: {'from': old, 'to': new}} for the fields that changed."""
    return {
        k: {'from': before.get(k), 'to': after.get(k)}
        for k in after
        if before.get(k) != after.get(k)
    }


def log(action, *, user=None, obj=None, object_type='', object_id='', object_repr='',
        changes=None, reason='', username=''):
    """Record an audit event. ``obj`` provides object_type/id/repr when given."""
    if obj is not None:
        object_type = object_type or obj.__class__.__name__
        object_id = object_id or str(getattr(obj, 'uuid', None) or obj.pk)
        object_repr = object_repr or str(obj)
    ctx = get_request_context()
    if user is not None and not getattr(user, 'is_authenticated', False):
        user = None
    return AuditLog.objects.create(
        user=user,
        username=getattr(user, 'username', '') or username,
        action=action,
        object_type=object_type,
        object_id=object_id,
        object_repr=object_repr[:255],
        changes=_scrub(changes or {}),
        reason=reason or '',
        ip_address=ctx.get('ip_address'),
        user_agent=ctx.get('user_agent', ''),
    )
