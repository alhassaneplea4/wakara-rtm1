"""User management URLs: /api/users/"""
from rest_framework.routers import DefaultRouter

from .views import UserViewSet

router = DefaultRouter()
router.include_root_view = False   # no index of routes (and no absolute URLs built from the internal host)
router.register('', UserViewSet, basename='user')

urlpatterns = router.urls
