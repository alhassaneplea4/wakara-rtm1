"""Stores request context (IP, user agent) for the audit service."""
import contextvars

_request_ctx = contextvars.ContextVar('wakara_request_ctx', default={})


def get_request_context() -> dict:
    return _request_ctx.get()


class AuditMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        forwarded = request.META.get('HTTP_X_FORWARDED_FOR', '')
        ip = forwarded.split(',')[0].strip() if forwarded else request.META.get('REMOTE_ADDR')
        token = _request_ctx.set({
            'ip_address': ip or None,
            'user_agent': request.META.get('HTTP_USER_AGENT', '')[:255],
        })
        try:
            return self.get_response(request)
        finally:
            _request_ctx.reset(token)
