from rest_framework.routers import DefaultRouter

from .views import HospitalViewSet

router = DefaultRouter()
router.include_root_view = False   # no index of routes (and no absolute URLs built from the internal host)
router.register('', HospitalViewSet, basename='hospital')

urlpatterns = router.urls
