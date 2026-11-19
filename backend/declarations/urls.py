from rest_framework.routers import DefaultRouter

from .views import DeclarationViewSet

router = DefaultRouter()
router.include_root_view = False   # no index of routes (and no absolute URLs built from the internal host)
router.register('', DeclarationViewSet, basename='declaration')

urlpatterns = router.urls
