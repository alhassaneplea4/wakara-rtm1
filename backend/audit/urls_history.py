from rest_framework.routers import DefaultRouter

from .history import DossierHistoryViewSet

router = DefaultRouter()
router.include_root_view = False   # no index of routes (and no absolute URLs built from the internal host)
router.register('', DossierHistoryViewSet, basename='history')

urlpatterns = router.urls
