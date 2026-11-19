"""Auth-related URLs: /api/auth/"""
from django.urls import path

from .tokens import DeviceAwareTokenRefreshView
from .views import (
    ChangePasswordView, LoginView, LogoutView, MeView, TwoFactorBackupCodesView, TwoFactorDisableView, TwoFactorEnableView,
    TwoFactorSetupView, TwoFactorStatusView,
)

urlpatterns = [
    path('login/', LoginView.as_view(), name='auth-login'),
    path('logout/', LogoutView.as_view(), name='auth-logout'),
    path('refresh/', DeviceAwareTokenRefreshView.as_view(), name='auth-refresh'),
    path('me/', MeView.as_view(), name='auth-me'),
    path('change-password/', ChangePasswordView.as_view(), name='auth-change-password'),
    path('two-factor/', TwoFactorStatusView.as_view(), name='auth-two-factor'),
    path('two-factor/setup/', TwoFactorSetupView.as_view(), name='auth-two-factor-setup'),
    path('two-factor/enable/', TwoFactorEnableView.as_view(), name='auth-two-factor-enable'),
    path('two-factor/disable/', TwoFactorDisableView.as_view(), name='auth-two-factor-disable'),
    path('two-factor/backup-codes/', TwoFactorBackupCodesView.as_view(), name='auth-two-factor-backup-codes'),
]
