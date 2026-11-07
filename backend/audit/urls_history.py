from rest_framework.routers import DefaultRouter

from .history import DossierHistoryViewSet

router = DefaultRouter()
router.register('', DossierHistoryViewSet, basename='history')

urlpatterns = router.urls
