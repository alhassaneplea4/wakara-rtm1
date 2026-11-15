from django.urls import path
from rest_framework.routers import SimpleRouter

from .views import (
    AnalyzeView, CaseViewSet, CompareView, ConfigView, MatchViewSet,
)

router = SimpleRouter()
router.register('cases', CaseViewSet, basename='duplicate-case')
router.register('matches', MatchViewSet, basename='duplicate-match')

urlpatterns = [
    path('analyze/', AnalyzeView.as_view(), name='duplicate-analyze'),
    path('compare/', CompareView.as_view(), name='duplicate-compare'),
    path('config/', ConfigView.as_view(), name='duplicate-config'),
] + router.urls
