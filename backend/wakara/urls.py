"""URL configuration for Wakara. Django Admin is reserved to technical maintenance."""
from django.conf import settings
from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

from core.views import AudienceView, InboxView, PublicHitView, PublicSettingsView, SettingsView

urlpatterns = [
    path('api/auth/', include('accounts.urls_auth')),
    path('api/users/', include('accounts.urls_users')),
    path('api/roles/', include('accounts.urls_roles')),
    path('api/permissions/', include('accounts.urls_permissions')),
    path('api/hospitals/', include('hospitals.urls')),
    path('api/declarations/', include('declarations.urls')),
    path('api/actes/', include('actes.urls')),
    path('api/documents/', include('documents.urls')),
    path('api/audit/', include('audit.urls')),
    path('api/history/', include('audit.urls_history')),
    path('api/duplicates/', include('duplicates.urls')),
    path('api/stats/', include('stats.urls')),
    path('api/sync/', include('sync.urls')),
    path('api/public/settings/', PublicSettingsView.as_view(), name='public-settings'),
    path('api/public/hit/', PublicHitView.as_view(), name='public-hit'),
    path('api/stats/audience/', AudienceView.as_view(), name='audience'),
    path('api/settings/', SettingsView.as_view(), name='settings'),
    path('api/inbox/', InboxView.as_view(), name='inbox'),
]

# Django administration: maintenance only, off in production unless ENABLE_DJANGO_ADMIN (see settings).
if settings.ENABLE_DJANGO_ADMIN:
    urlpatterns += [path('admin/', admin.site.urls)]

# API documentation is exposed only in development.
if settings.DEBUG:
    urlpatterns += [
        path('api/schema/', SpectacularAPIView.as_view(), name='schema'),
        path('api/docs/', SpectacularSwaggerView.as_view(url_name='schema'), name='swagger-ui'),
    ]
