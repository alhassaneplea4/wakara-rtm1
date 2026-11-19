from rest_framework.routers import DefaultRouter

from .views import AuditLogViewSet

router = DefaultRouter()
router.include_root_view = False   # no index of routes (and no absolute URLs built from the internal host)
router.register('', AuditLogViewSet, basename='audit')

urlpatterns = router.urls
