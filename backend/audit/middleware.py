"""Stores request context (IP, user agent) for the audit service."""
import contextvars
import ipaddress

from django.conf import settings

_request_ctx = contextvars.ContextVar('wakara_request_ctx', default={})


def get_request_context() -> dict:
    return _request_ctx.get()


def _valid_ip(value):
    """Normalised IP address, or None when ``value`` is not a syntactically valid IP."""
    try:
        return str(ipaddress.ip_address((value or '').strip()))
    except ValueError:
        return None


def client_ip(request):
    """
    Address of the client as seen by the trusted reverse proxies.

    ``settings.NUM_PROXIES`` is the number of trusted proxies in front of Django (the same value as DRF's
    throttling uses). 0 means "no proxy": X-Forwarded-For is ignored because a client can send anything in
    it. With N > 0 the entry appended by the Nth proxy from the right is used, never the client-controlled
    left side. A value that is not a valid IP address is dropped, so it can neither forge the audit origin
    nor make the audit insert fail.
    """
    remote = _valid_ip(request.META.get('REMOTE_ADDR'))
    hops = getattr(settings, 'NUM_PROXIES', 0) or 0
    forwarded = request.META.get('HTTP_X_FORWARDED_FOR', '')
    if hops > 0 and forwarded:
        parts = [p.strip() for p in forwarded.split(',') if p.strip()]
        if parts:
            candidate = _valid_ip(parts[-min(hops, len(parts))])
            if candidate:
                return candidate
    return remote


class AuditMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        token = _request_ctx.set({
            'ip_address': client_ip(request),
            'user_agent': request.META.get('HTTP_USER_AGENT', '')[:255],
        })
        try:
            return self.get_response(request)
        finally:
            _request_ctx.reset(token)
