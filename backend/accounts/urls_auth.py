"""Auth-related URLs: /api/auth/"""
from django.urls import path

from .tokens import DeviceAwareTokenRefreshView
from .views import ChangePasswordView, LoginView, LogoutView, MeView

urlpatterns = [
    path('login/', LoginView.as_view(), name='auth-login'),
    path('logout/', LogoutView.as_view(), name='auth-logout'),
    path('refresh/', DeviceAwareTokenRefreshView.as_view(), name='auth-refresh'),
    path('me/', MeView.as_view(), name='auth-me'),
    path('change-password/', ChangePasswordView.as_view(), name='auth-change-password'),
]
