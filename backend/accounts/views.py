"""Views for the accounts app: authentication, users, roles, permissions."""
import secrets
import string
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken

from audit import service as audit
from audit.models import AuditAction
from core.permissions import ALL_PERMISSION_CODES, PROTECTED_ADMIN_PERMISSIONS, HasWakaraPermission

from .models import Permission, Role, RolePermission, UserPermission, UserRole
from .serializers import (
    ChangePasswordSerializer, LoginSerializer, MeSerializer, PermissionSerializer,
    RoleSerializer, UserCreateSerializer, UserDetailSerializer, UserListSerializer,
    UserPermissionSerializer, UserRoleSerializer, UserUpdateSerializer,
)

User = get_user_model()

INVALID_CREDENTIALS = {"detail": "Identifiant ou mot de passe incorrect."}


class LoginRateThrottle(AnonRateThrottle):
    scope = 'login'


def _find_user(identifier: str):
    """Match on username, or on e-mail when it is unambiguous."""
    user = User.objects.filter(username__iexact=identifier).first()
    if user or '@' not in identifier:
        return user
    matches = list(User.objects.filter(email__iexact=identifier)[:2])
    return matches[0] if len(matches) == 1 else None


# ── Authentication ────────────────────────────────

class LoginView(APIView):
    """POST /api/auth/login/ — returns a JWT pair and the user profile."""
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [LoginRateThrottle]
    serializer_class = LoginSerializer

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        identifier = serializer.validated_data['username'].strip()
        password = serializer.validated_data['password']

        user = _find_user(identifier)
        if user is None:
            audit.log(AuditAction.LOGIN_FAILED, username=identifier[:150],
                      object_type='User', reason='Identifiant inconnu')
            return Response(INVALID_CREDENTIALS, status=status.HTTP_401_UNAUTHORIZED)

        if user.is_locked:
            audit.log(AuditAction.LOGIN_FAILED, user=user, obj=user, reason='Compte verrouillé')
            return Response(
                {"detail": "Compte temporairement verrouillé après plusieurs échecs. Réessayez plus tard."},
                status=status.HTTP_403_FORBIDDEN,
            )

        if not user.check_password(password):
            user.failed_login_count += 1
            update = ['failed_login_count']
            if user.failed_login_count >= settings.LOGIN_MAX_FAILED_ATTEMPTS:
                user.locked_until = timezone.now() + timedelta(minutes=settings.LOGIN_LOCKOUT_MINUTES)
                user.failed_login_count = 0
                update.append('locked_until')
            user.save(update_fields=update)
            audit.log(AuditAction.LOGIN_FAILED, user=user, obj=user, reason='Mot de passe incorrect')
            return Response(INVALID_CREDENTIALS, status=status.HTTP_401_UNAUTHORIZED)

        if not user.is_active:
            audit.log(AuditAction.LOGIN_FAILED, user=user, obj=user, reason='Compte désactivé')
            return Response({"detail": "Ce compte est désactivé."}, status=status.HTTP_403_FORBIDDEN)

        user.failed_login_count = 0
        user.locked_until = None
        user.last_login = timezone.now()
        user.save(update_fields=['failed_login_count', 'locked_until', 'last_login'])
        audit.log(AuditAction.LOGIN, user=user, obj=user)

        refresh = RefreshToken.for_user(user)
        return Response({
            'access': str(refresh.access_token),
            'refresh': str(refresh),
            'user': MeSerializer(user).data,
        })


class LogoutView(APIView):
    """POST /api/auth/logout/ — blacklists the refresh token."""
    permission_classes = [IsAuthenticated]

    def post(self, request):
        token = request.data.get('refresh')
        if token:
            try:
                RefreshToken(token).blacklist()
            except TokenError:
                pass
        audit.log(AuditAction.LOGOUT, user=request.user, obj=request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeView(APIView):
    """GET/PATCH /api/auth/me/ — current user profile (limited self-service fields)."""
    permission_classes = [IsAuthenticated]
    SELF_FIELDS = ['email', 'first_name', 'last_name', 'phone', 'address']

    def get(self, request):
        return Response(MeSerializer(request.user).data)

    def patch(self, request):
        before = audit.snapshot(request.user, self.SELF_FIELDS)
        serializer = MeSerializer(request.user, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        changes = audit.diff(before, audit.snapshot(request.user, self.SELF_FIELDS))
        if changes:
            audit.log(AuditAction.UPDATE, user=request.user, obj=request.user, changes=changes)
        return Response(serializer.data)


class ChangePasswordView(APIView):
    """POST /api/auth/change-password/"""
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = ChangePasswordSerializer(data=request.data, context={'request': request})
        serializer.is_valid(raise_exception=True)
        if not request.user.check_password(serializer.validated_data['old_password']):
            return Response({"detail": "Ancien mot de passe incorrect."},
                            status=status.HTTP_400_BAD_REQUEST)
        request.user.set_password(serializer.validated_data['new_password'])
        request.user.must_change_password = False
        request.user.save(update_fields=['password', 'must_change_password', 'updated_at'])
        audit.log(AuditAction.PASSWORD_CHANGED, user=request.user, obj=request.user)
        return Response({"detail": "Mot de passe modifié avec succès."})


# ── Users ─────────────────────────────────────────

USER_AUDIT_FIELDS = ['username', 'email', 'first_name', 'last_name', 'phone',
                     'address', 'hospital', 'is_active']


class UserViewSet(mixins.CreateModelMixin, mixins.RetrieveModelMixin, mixins.UpdateModelMixin,
                  mixins.ListModelMixin, viewsets.GenericViewSet):
    """Users are never deleted: they are deactivated."""
    queryset = User.objects.select_related('hospital').prefetch_related('user_roles__role')
    permission_classes = [HasWakaraPermission]
    lookup_field = 'uuid'
    http_method_names = ['get', 'post', 'patch', 'head', 'options']
    filterset_fields = ['is_active', 'hospital']
    search_fields = ['username', 'first_name', 'last_name', 'email']
    ordering_fields = ['username', 'date_joined', 'last_login']
    permission_map = {
        'list': 'user.view', 'retrieve': 'user.view',
        'create': 'user.create', 'partial_update': 'user.update',
        'activate': 'user.manage_status', 'deactivate': 'user.manage_status',
        'roles': 'user.assign_roles', 'remove_role': 'user.assign_roles',
        'permission_overrides': 'user.assign_roles',
        'reset_password': 'user.reset_password',
    }

    def get_serializer_class(self):
        return {
            'create': UserCreateSerializer,
            'partial_update': UserUpdateSerializer,
            'retrieve': UserDetailSerializer,
        }.get(self.action, UserListSerializer)

    def get_queryset(self):
        qs = super().get_queryset()
        role = self.request.query_params.get('role')
        if role:
            qs = qs.filter(user_roles__role__codename=role, user_roles__is_active=True)
        return qs

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save(created_by=request.user)
        audit.log(AuditAction.CREATE, user=request.user, obj=user,
                  changes=audit.snapshot(user, USER_AUDIT_FIELDS))
        return Response(UserDetailSerializer(user).data, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        user = self.get_object()
        before = audit.snapshot(user, USER_AUDIT_FIELDS)
        serializer = self.get_serializer(user, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        changes = audit.diff(before, audit.snapshot(user, USER_AUDIT_FIELDS))
        if changes:
            audit.log(AuditAction.UPDATE, user=request.user, obj=user, changes=changes)
        return Response(UserDetailSerializer(user).data)

    @staticmethod
    def _forbid_self(request, user, what):
        if user.pk == request.user.pk:
            raise PermissionDenied(f"Action impossible sur votre propre compte : {what}.")

    @action(detail=True, methods=['post'])
    def activate(self, request, uuid=None):
        user = self.get_object()
        user.is_active = True
        user.failed_login_count = 0
        user.locked_until = None
        user.save(update_fields=['is_active', 'failed_login_count', 'locked_until', 'updated_at'])
        audit.log(AuditAction.ACCOUNT_ACTIVATED, user=request.user, obj=user)
        return Response(UserDetailSerializer(user).data)

    @action(detail=True, methods=['post'])
    def deactivate(self, request, uuid=None):
        user = self.get_object()
        self._forbid_self(request, user, "désactivation")
        user.is_active = False
        user.save(update_fields=['is_active', 'updated_at'])
        audit.log(AuditAction.ACCOUNT_DEACTIVATED, user=request.user, obj=user,
                  reason=str(request.data.get('reason', '')))
        return Response(UserDetailSerializer(user).data)

    @action(detail=True, methods=['get', 'post'], url_path='roles')
    def roles(self, request, uuid=None):
        user = self.get_object()
        if request.method == 'GET':
            return Response(UserRoleSerializer(UserRole.objects.filter(user=user), many=True).data)
        self._forbid_self(request, user, "modification des rôles")
        role = Role.objects.filter(pk=request.data.get('role'), is_active=True).first()
        if role is None:
            raise ValidationError({'role': "Rôle introuvable ou inactif."})
        ur, created = UserRole.objects.get_or_create(
            user=user, role=role, defaults={'assigned_by': request.user})
        if not created:
            if ur.is_active:
                return Response(UserRoleSerializer(ur).data)
            ur.is_active = True
            ur.assigned_by = request.user
            ur.assigned_at = timezone.now()
            ur.save(update_fields=['is_active', 'assigned_by', 'assigned_at', 'updated_at'])
        audit.log(AuditAction.ROLE_ASSIGNED, user=request.user, obj=user,
                  changes={'role': role.codename})
        return Response(UserRoleSerializer(ur).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'], url_path='roles/remove')
    def remove_role(self, request, uuid=None):
        user = self.get_object()
        self._forbid_self(request, user, "modification des rôles")
        ur = UserRole.objects.filter(
            user=user, role_id=request.data.get('role'), is_active=True).select_related('role').first()
        if ur is None:
            raise ValidationError({'role': "Attribution introuvable."})
        ur.is_active = False
        ur.save(update_fields=['is_active', 'updated_at'])
        audit.log(AuditAction.ROLE_REMOVED, user=request.user, obj=user,
                  changes={'role': ur.role.codename})
        return Response({"detail": "Rôle retiré."})

    @action(detail=True, methods=['get', 'post', 'delete'], url_path='permissions')
    def permission_overrides(self, request, uuid=None):
        """GET lists overrides; POST {codename, granted}; DELETE {codename} removes one."""
        user = self.get_object()
        if request.method == 'GET':
            return Response(UserPermissionSerializer(user.permission_overrides.all(), many=True).data)
        self._forbid_self(request, user, "modification des permissions")
        perm = Permission.objects.filter(codename=request.data.get('codename')).first()
        if perm is None:
            raise ValidationError({'codename': "Permission inconnue."})
        if request.method == 'POST':
            granted = request.data.get('granted', True) in (True, 'true', 'True', 1, '1')
            UserPermission.objects.update_or_create(
                user=user, permission=perm, defaults={'granted': granted, 'set_by': request.user})
            audit.log(AuditAction.PERMISSION_CHANGED, user=request.user, obj=user,
                      changes={perm.codename: 'accordée' if granted else 'refusée'},
                      reason=str(request.data.get('reason', '')))
        else:
            UserPermission.objects.filter(user=user, permission=perm).delete()
            audit.log(AuditAction.PERMISSION_CHANGED, user=request.user, obj=user,
                      changes={perm.codename: 'surcharge retirée'})
        return Response(UserPermissionSerializer(user.permission_overrides.all(), many=True).data)

    @action(detail=True, methods=['post'], url_path='reset-password')
    def reset_password(self, request, uuid=None):
        """Sets a temporary password (returned once) and forces a change at next login."""
        user = self.get_object()
        self._forbid_self(request, user, "réinitialisation du mot de passe")
        alphabet = string.ascii_letters + string.digits
        temp = ''.join(secrets.choice(alphabet) for _ in range(12)) + '!1'
        user.set_password(temp)
        user.must_change_password = True
        user.failed_login_count = 0
        user.locked_until = None
        user.save(update_fields=['password', 'must_change_password', 'failed_login_count',
                                 'locked_until', 'updated_at'])
        audit.log(AuditAction.PASSWORD_RESET, user=request.user, obj=user)
        return Response({'temporary_password': temp})


# ── Roles & permissions ───────────────────────────

def role_permission_codes(role) -> set:
    return set(RolePermission.objects.filter(role=role).values_list('permission__codename', flat=True))


class RoleViewSet(viewsets.ModelViewSet):
    """Roles are deactivated, never deleted. A role codename is immutable."""
    queryset = Role.objects.prefetch_related('role_permissions__permission')
    serializer_class = RoleSerializer
    permission_classes = [HasWakaraPermission]
    http_method_names = ['get', 'post', 'patch', 'put', 'head', 'options']
    permission_map = {
        'list': 'role.view', 'retrieve': 'role.view',
        'create': 'role.manage', 'update': 'role.manage', 'partial_update': 'role.manage',
        'set_permissions': 'role.manage',
    }

    def perform_create(self, serializer):
        role = serializer.save()
        audit.log(AuditAction.CREATE, user=self.request.user, obj=role,
                  changes=audit.snapshot(role, ['codename', 'name', 'description', 'is_active']))

    def perform_update(self, serializer):
        fields = ['name', 'description', 'is_active']
        before = audit.snapshot(serializer.instance, fields)
        if serializer.instance.is_system and serializer.validated_data.get('is_active') is False:
            raise ValidationError({'is_active': "Un rôle système ne peut pas être désactivé."})
        role = serializer.save()
        changes = audit.diff(before, audit.snapshot(role, fields))
        if changes:
            audit.log(AuditAction.UPDATE, user=self.request.user, obj=role, changes=changes)

    @action(detail=True, methods=['put'], url_path='permissions')
    @transaction.atomic
    def set_permissions(self, request, pk=None):
        """PUT {permissions: [codename, ...], reason} — replaces the role's permission set."""
        role = self.get_object()
        wanted = request.data.get('permissions')
        if not isinstance(wanted, list):
            raise ValidationError({'permissions': "Une liste de codes est attendue."})
        unknown = set(wanted) - set(ALL_PERMISSION_CODES)
        if unknown:
            raise ValidationError({'permissions': f"Permissions inconnues : {', '.join(sorted(unknown))}"})
        wanted = set(wanted)
        current = role_permission_codes(role)

        if role.codename == 'admin':
            missing = set(PROTECTED_ADMIN_PERMISSIONS) - wanted
            if missing:
                raise ValidationError({'permissions': (
                    "Le rôle administrateur doit conserver : " + ', '.join(sorted(missing)))})
        # Nobody can strip permissions from a role that grants them their own access.
        if role.user_roles.filter(user=request.user, is_active=True).exists() and current - wanted:
            raise PermissionDenied("Vous ne pouvez pas retirer des permissions à votre propre rôle.")

        for codename in current - wanted:
            RolePermission.objects.filter(role=role, permission__codename=codename).delete()
        for codename in wanted - current:
            RolePermission.objects.create(role=role, permission=Permission.objects.get(codename=codename))
        if current != wanted:
            audit.log(AuditAction.PERMISSION_CHANGED, user=request.user, obj=role,
                      changes={'added': sorted(wanted - current), 'removed': sorted(current - wanted)},
                      reason=str(request.data.get('reason', '')))
        return Response(RoleSerializer(self.get_object()).data)


class PermissionViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Permission.objects.all()
    serializer_class = PermissionSerializer
    permission_classes = [HasWakaraPermission]
    pagination_class = None
    permission_map = {'list': 'role.view', 'retrieve': 'role.view'}
