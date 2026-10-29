from rest_framework.routers import DefaultRouter

from .views import DeclarationViewSet

router = DefaultRouter()
router.register('', DeclarationViewSet, basename='declaration')

urlpatterns = router.urls
