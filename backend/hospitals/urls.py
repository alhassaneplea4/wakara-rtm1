from rest_framework.routers import DefaultRouter

from .views import HospitalViewSet

router = DefaultRouter()
router.register('', HospitalViewSet, basename='hospital')

urlpatterns = router.urls
