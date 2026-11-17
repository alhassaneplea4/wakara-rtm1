"""
Headers of every API answer.

* ``Cache-Control: no-store`` — nothing the API answers (personal data of children and parents) may be kept by a
  browser, a service worker or a shared cache. A CDN such as Cloudflare does not cache JSON by default, but a
  "Cache Everything" rule or a wrong default would otherwise expose one user's answer to another.
* a restrictive Content-Security-Policy (an API answer is never a page: nothing may load or run from it) and
  ``sandbox``, so that a document served by the API could never run script in the origin of the application;
* no referrer, no sniffing, no embedding, same-origin resource policy.
Headers a view already set are kept (the documents view sends its own ``private, no-store``).
"""
from django.conf import settings

API_PREFIX = '/api/'
# the developer documentation (DEBUG only) needs scripts and styles of its own
DOC_PREFIXES = ('/api/docs/', '/api/schema/')

API_HEADERS = {
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
}


class ApiSecurityHeadersMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        path = request.path
        if path.startswith(API_PREFIX) and not (settings.DEBUG and path.startswith(DOC_PREFIXES)):
            for key, value in API_HEADERS.items():
                if key not in response:
                    response[key] = value
        return response
