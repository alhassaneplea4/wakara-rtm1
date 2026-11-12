from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import DeviceViewSet, DocumentPushView, PingView, PullView, PushView, SyncOperationViewSet

router = DefaultRouter()
router.register('operations', SyncOperationViewSet, basename='sync-operation')
router.register('devices', DeviceViewSet, basename='sync-device')

urlpatterns = [
    path('ping/', PingView.as_view(), name='sync-ping'),
    path('push/', PushView.as_view(), name='sync-push'),
    path('documents/', DocumentPushView.as_view(), name='sync-documents'),
    path('pull/', PullView.as_view(), name='sync-pull'),
] + router.urls
