from rest_framework.routers import DefaultRouter

from .views import ActeViewSet, DeliveryViewSet

router = DefaultRouter()
router.register('deliveries', DeliveryViewSet, basename='delivery')
router.register('', ActeViewSet, basename='acte')

urlpatterns = router.urls
