"""User management URLs: /api/users/"""
from rest_framework.routers import DefaultRouter

from .views import UserViewSet

router = DefaultRouter()
router.register('', UserViewSet, basename='user')

urlpatterns = router.urls
