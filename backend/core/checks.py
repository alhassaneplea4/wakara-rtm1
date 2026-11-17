"""System checks: configuration that is fine in development but weakens a production deployment."""
from django.conf import settings
from django.core.checks import Warning, register


@register(deploy=True)
def rate_limit_cache(app_configs, **kwargs):
    backend = settings.CACHES.get('default', {}).get('BACKEND', '')
    if backend.endswith('LocMemCache'):
        return [Warning(
            "La limitation de débit utilise un cache en mémoire propre à chaque instance.",
            hint="Avec plusieurs instances (Vercel, plusieurs workers) chaque instance a son propre compteur : "
                 "définissez REDIS_URL, et doublez la limitation au niveau du pare-feu (Cloudflare : règles de limitation de débit).",
            id='wakara.W001')]
    return []


@register(deploy=True)
def proxy_count(app_configs, **kwargs):
    if getattr(settings, 'NUM_PROXIES', 0) == 0 and not settings.DEBUG:
        return [Warning(
            "NUM_PROXIES vaut 0 : l'adresse du client est celle du dernier proxy.",
            hint="Derrière Vercel NUM_PROXIES=1 ; derrière Cloudflare puis Vercel NUM_PROXIES=2. "
                 "Sinon la limite de connexion et le journal d'audit voient l'adresse du proxy, pas celle du client.",
            id='wakara.W002')]
    return []
