"""Permission management URLs: /api/permissions/"""
from rest_framework.routers import DefaultRouter

from .views import PermissionViewSet

router = DefaultRouter()
router.include_root_view = False   # no index of routes (and no absolute URLs built from the internal host)
router.register('', PermissionViewSet, basename='permission')

urlpatterns = router.urls
