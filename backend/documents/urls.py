from rest_framework.routers import DefaultRouter

from .views import DocumentViewSet

router = DefaultRouter()
router.include_root_view = False   # no index of routes (and no absolute URLs built from the internal host)
router.register('', DocumentViewSet, basename='document')

urlpatterns = router.urls
