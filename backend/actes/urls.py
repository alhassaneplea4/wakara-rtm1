from rest_framework.routers import DefaultRouter

from .views import ActeViewSet, DeliveryViewSet

router = DefaultRouter()
router.include_root_view = False   # no index of routes (and no absolute URLs built from the internal host)
router.register('deliveries', DeliveryViewSet, basename='delivery')
router.register('', ActeViewSet, basename='acte')

urlpatterns = router.urls
