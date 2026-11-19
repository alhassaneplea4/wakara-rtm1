"""Role management URLs: /api/roles/"""
from rest_framework.routers import DefaultRouter

from .views import RoleViewSet

router = DefaultRouter()
router.include_root_view = False   # no index of routes (and no absolute URLs built from the internal host)
router.register('', RoleViewSet, basename='role')

urlpatterns = router.urls
