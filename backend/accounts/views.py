"""Views for the accounts app: authentication, users, roles, permissions."""
import secrets
import string
from datetime import datetime, timedelta, timezone as dt_timezone
import hashlib

from django.conf import settings
from django.core.cache import cache
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import F
from django.utils import timezone
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle, UserRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken

from . import two_factor
from .authentication import DEVICE_REVOKED_MESSAGE, device_of_token, is_device_revoked
from .tokens import tokens_for

from audit import service as audit
from audit.models import AuditAction
from audit.middleware import client_ip
from core.permissions import (
    ALL_PERMISSION_CODES, PROTECTED_ADMIN_PERMISSIONS, HasWakaraPermission, get_user_permissions, permissions_of,
)

from .models import LoginAttempt, RevokedAccessToken, Permission, Role, RolePermission, UserPermission, UserRole
from .serializers import (
    ChangePasswordSerializer, LoginSerializer, MeSerializer, PermissionSerializer,
    RoleSerializer, UserCreateSerializer, UserDetailSerializer, UserListSerializer,
    UserPermissionSerializer, UserRoleSerializer, UserUpdateSerializer,
)

User = get_user_model()

INVALID_CREDENTIALS = {"detail": "Identifiant ou mot de passe incorrect."}
LOCKED = {"detail": "Trop de tentatives depuis cette adresse ou sur ce compte. Réessayez plus tard."}


def _as_int(value):
    """A role identifier sent by the client, or None when it is not a number (never an error 500)."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def revoke_user_tokens(user):
    """Blacklist every outstanding refresh token of ``user`` (password change/reset, deactivation).

    The access tokens already issued are refused too: the version of the sessions goes up and every token carries
    the version it was issued under (claim ``sv``), so a token of an older version is rejected on its next request.
    """
    User.objects.filter(pk=user.pk).update(session_version=F('session_version') + 1)
    user.session_version = User.objects.values_list('session_version', flat=True).get(pk=user.pk)
    for token in OutstandingToken.objects.filter(user=user):
        BlacklistedToken.objects.get_or_create(token=token)


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

        ip = client_ip(request) or ''
        if serializer.validated_data.get('website'):
            # a bot filled the hidden field: it is answered like a wrong password, and counted
            audit.log(AuditAction.LOGIN_FAILED, username='robot', object_type='User', reason='Champ piège rempli')
            return self._unknown_identifier(identifier, ip)
        user = _find_user(identifier)
        if user is None:
            return self._unknown_identifier(identifier, ip)

        # Lockout per (account, address): a stranger guessing passwords locks HIS address out, not the owner of the
        # account. The account itself is locked only while several addresses are locked together (distributed attack).
        attempt = LoginAttempt.objects.filter(user=user, ip_address=ip).first()
        if user.is_locked or (attempt is not None and attempt.is_locked):
            audit.log(AuditAction.LOGIN_FAILED, user=user, obj=user, reason='Compte verrouillé')
            return Response(LOCKED, status=status.HTTP_403_FORBIDDEN)

        if not user.check_password(password):
            self._record_failure(user, ip)
            audit.log(AuditAction.LOGIN_FAILED, user=user, obj=user, reason='Mot de passe incorrect')
            return Response(INVALID_CREDENTIALS, status=status.HTTP_401_UNAUTHORIZED)

        if not user.is_active:
            audit.log(AuditAction.LOGIN_FAILED, user=user, obj=user, reason='Compte désactivé')
            return Response({"detail": "Ce compte est désactivé."}, status=status.HTTP_403_FORBIDDEN)

        device_id = serializer.validated_data.get('device_id')
        if is_device_revoked(user.pk, device_id):
            audit.log(AuditAction.LOGIN_FAILED, user=user, obj=user, reason='Appareil révoqué')
            return Response({'code': 'device_revoked', 'detail': DEVICE_REVOKED_MESSAGE + " Contactez l'administrateur."},
                            status=status.HTTP_403_FORBIDDEN)

        if user.two_factor_enabled:
            code = (serializer.validated_data.get('code') or '').strip()
            if not code:
                # the password is right: the client now asks for the code (nothing is counted as a failure)
                return Response({'code': 'two_factor_required',
                                 'detail': "Saisissez le code de votre application d'authentification."},
                                status=status.HTTP_403_FORBIDDEN)
            if not two_factor.verify_login_code(user, code):
                self._record_failure(user, ip)       # a wrong code counts like a wrong password
                audit.log(AuditAction.TWO_FACTOR_FAILED, user=user, obj=user, reason='Code de vérification incorrect')
                return Response({'code': 'two_factor_invalid', 'detail': "Code de vérification incorrect ou déjà utilisé."},
                                status=status.HTTP_401_UNAUTHORIZED)

        LoginAttempt.objects.filter(user=user, ip_address=ip).delete()
        user.failed_login_count = 0
        user.locked_until = None
        user.last_login = timezone.now()
        user.save(update_fields=['failed_login_count', 'locked_until', 'last_login'])
        audit.log(AuditAction.LOGIN, user=user, obj=user)

        refresh = tokens_for(user, device_id)
        return Response({
            'access': str(refresh.access_token),
            'refresh': str(refresh),
            'user': MeSerializer(user).data,
        })


    @staticmethod
    def _unknown_identifier(identifier, ip):
        """
        An identifier that matches no account behaves EXACTLY like a real one: the same count of mistakes per address,
        the same lockout, the same answers (nobody learns which identifiers exist). The audit log keeps only a short
        fingerprint of what was typed, never the text itself (a password typed in the identifier field stays secret).
        """
        fingerprint = hashlib.sha256(identifier.lower().encode()).hexdigest()[:12]
        key = 'login-unknown:' + hashlib.sha256(f'{identifier.lower()}|{ip}'.encode()).hexdigest()
        window = settings.LOGIN_LOCKOUT_MINUTES * 60
        if cache.get(key + ':locked'):
            audit.log(AuditAction.LOGIN_FAILED, username=f'inconnu:{fingerprint}', object_type='User', reason='Identifiant inconnu')
            return Response(LOCKED, status=status.HTTP_403_FORBIDDEN)
        cache.add(key, 0, window)
        try:
            count = cache.incr(key)
        except ValueError:
            count = 1
        if count >= settings.LOGIN_MAX_FAILED_ATTEMPTS:
            cache.set(key + ':locked', True, window)
            cache.delete(key)
        audit.log(AuditAction.LOGIN_FAILED, username=f'inconnu:{fingerprint}', object_type='User', reason='Identifiant inconnu')
        return Response(INVALID_CREDENTIALS, status=status.HTTP_401_UNAUTHORIZED)

    @staticmethod
    def _record_failure(user, ip):
        """
        One more wrong password of ``user`` from ``ip``. The row is locked while it is counted: parallel guesses are
        serialised, so none is lost and the lockout cannot be outrun by sending the attempts at the same time.
        """
        now = timezone.now()
        window = timedelta(minutes=settings.LOGIN_LOCKOUT_MINUTES)
        with transaction.atomic():
            LoginAttempt.objects.get_or_create(user=user, ip_address=ip)
            row = LoginAttempt.objects.select_for_update().get(user=user, ip_address=ip)
            if row.updated_at < now - window:
                row.failed_count = 0                      # old mistakes are forgotten
            row.failed_count += 1
            if row.failed_count >= settings.LOGIN_MAX_FAILED_ATTEMPTS:
                row.locked_until, row.failed_count = now + window, 0
            row.save()
            User.objects.filter(pk=user.pk).update(failed_login_count=row.failed_count)
            # several addresses locked at once on the same account: it is being attacked from many places
            sources = LoginAttempt.objects.filter(user=user, locked_until__gt=now).count()
            if sources >= settings.LOGIN_LOCKED_SOURCES_BEFORE_ACCOUNT_LOCK:
                User.objects.filter(pk=user.pk).update(locked_until=now + window, failed_login_count=0)


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
        self._revoke_access_token(request.auth)
        audit.log(AuditAction.LOGOUT, user=request.user, obj=request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


    @staticmethod
    def _revoke_access_token(token):
        """The access token used to sign out stops working now, not when it expires."""
        try:
            jti, exp = token['jti'], int(token['exp'])
        except (KeyError, TypeError, ValueError):
            return
        now = timezone.now()
        RevokedAccessToken.objects.filter(expires_at__lt=now).delete()
        RevokedAccessToken.objects.get_or_create(
            jti=jti, defaults={'expires_at': datetime.fromtimestamp(exp, tz=dt_timezone.utc)})


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
        if serializer.validated_data['old_password'] == serializer.validated_data['new_password']:
            return Response({"detail": "Le nouveau mot de passe doit être différent de l'ancien."},
                            status=status.HTTP_400_BAD_REQUEST)
        request.user.set_password(serializer.validated_data['new_password'])
        request.user.must_change_password = False
        request.user.save(update_fields=['password', 'must_change_password', 'updated_at'])
        # Every session opened with the old password ends; this session gets a fresh token pair.
        revoke_user_tokens(request.user)
        refresh = tokens_for(request.user, device_of_token(request.auth))  # the new session stays on the same device
        audit.log(AuditAction.PASSWORD_CHANGED, user=request.user, obj=request.user)
        return Response({"detail": "Mot de passe modifié avec succès.",
                         "access": str(refresh.access_token), "refresh": str(refresh)})


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
        'reset_two_factor': 'user.reset_two_factor',
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
        self._forbid_superior(request, user, "Modification impossible")
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

    @staticmethod
    def _require_own(request, codes, what):
        """Nobody hands out a right he does not hold himself (no way up through the administration screens)."""
        missing = set(codes) - get_user_permissions(request.user)
        if missing:
            raise PermissionDenied(f"{what} : vous ne détenez pas vous-même {', '.join(sorted(missing))}.")

    @classmethod
    def _forbid_superior(cls, request, user, what):
        """
        Nobody acts on an account that holds rights he does not have: resetting the password of an administrator,
        changing his e-mail, his roles or his status would be a way to take his account over.
        """
        if user.pk != request.user.pk and permissions_of(user) - get_user_permissions(request.user):
            raise PermissionDenied(f"{what} : ce compte a des droits que vous n'avez pas.")

    @action(detail=True, methods=['post'])
    def activate(self, request, uuid=None):
        user = self.get_object()
        self._forbid_superior(request, user, "Activation impossible")
        user.is_active = True
        user.failed_login_count = 0
        user.locked_until = None
        user.save(update_fields=['is_active', 'failed_login_count', 'locked_until', 'updated_at'])
        LoginAttempt.objects.filter(user=user).delete()
        audit.log(AuditAction.ACCOUNT_ACTIVATED, user=request.user, obj=user)
        return Response(UserDetailSerializer(user).data)

    @action(detail=True, methods=['post'])
    def deactivate(self, request, uuid=None):
        user = self.get_object()
        self._forbid_self(request, user, "désactivation")
        self._forbid_superior(request, user, "Désactivation impossible")
        user.is_active = False
        user.save(update_fields=['is_active', 'updated_at'])
        revoke_user_tokens(user)
        audit.log(AuditAction.ACCOUNT_DEACTIVATED, user=request.user, obj=user,
                  reason=str(request.data.get('reason', '')))
        return Response(UserDetailSerializer(user).data)

    @action(detail=True, methods=['get', 'post'], url_path='roles')
    def roles(self, request, uuid=None):
        user = self.get_object()
        if request.method == 'GET':
            return Response(UserRoleSerializer(UserRole.objects.filter(user=user), many=True).data)
        self._forbid_self(request, user, "modification des rôles")
        role = Role.objects.filter(pk=_as_int(request.data.get('role')), is_active=True).first()
        if role is None:
            raise ValidationError({'role': "Rôle introuvable ou inactif."})
        self._forbid_superior(request, user, "Attribution impossible")
        self._require_own(request, role_permission_codes(role), "Attribution impossible")
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
        self._forbid_superior(request, user, "Retrait impossible")
        ur = UserRole.objects.filter(
            user=user, role_id=_as_int(request.data.get('role')), is_active=True).select_related('role').first()
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
        self._forbid_superior(request, user, "Modification impossible")
        codename = request.data.get('codename')
        perm = Permission.objects.filter(codename=codename).first() if isinstance(codename, str) else None
        if perm is None:
            raise ValidationError({'codename': "Permission inconnue."})
        # granting a right, or lifting a refusal, both need the right itself
        self._require_own(request, [perm.codename], "Modification impossible")
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

    @action(detail=True, methods=['post'], url_path='reset-two-factor')
    def reset_two_factor(self, request, uuid=None):
        """The second factor of an account whose phone is lost: switched off, the sessions end, the user sets it up again."""
        user = self.get_object()
        self._forbid_self(request, user, "réinitialisation de la double authentification (demandez à un autre administrateur)")
        self._forbid_superior(request, user, "Réinitialisation impossible")
        reason = str(request.data.get('reason') or '').strip()
        if len(reason) < 10:
            raise ValidationError({'reason': "Indiquez le motif (10 caractères au moins) : il est inscrit au journal d'audit."})
        if not user.two_factor_enabled and not user.totp_secret:
            raise ValidationError({'detail': "La double authentification n'est pas activée sur ce compte."})
        two_factor.clear(user)
        revoke_user_tokens(user)
        audit.log(AuditAction.TWO_FACTOR_RESET, user=request.user, obj=user, reason=reason)
        return Response({'detail': "Double authentification réinitialisée : le compte devra la configurer de nouveau."})

    @action(detail=True, methods=['post'], url_path='reset-password')
    def reset_password(self, request, uuid=None):
        """Sets a temporary password (returned once) and forces a change at next login."""
        user = self.get_object()
        self._forbid_self(request, user, "réinitialisation du mot de passe")
        self._forbid_superior(request, user, "Réinitialisation impossible")
        alphabet = string.ascii_letters + string.digits
        temp = ''.join(secrets.choice(alphabet) for _ in range(12)) + '!1'
        user.set_password(temp)
        user.must_change_password = True
        user.failed_login_count = 0
        user.locked_until = None
        user.save(update_fields=['password', 'must_change_password', 'failed_login_count',
                                 'locked_until', 'updated_at'])
        LoginAttempt.objects.filter(user=user).delete()
        revoke_user_tokens(user)
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
        if not isinstance(wanted, list) or not all(isinstance(code, str) for code in wanted):
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
        # ... nor add to any role (his own included) a right he does not hold: no way up through role.manage
        beyond = (wanted - current) - get_user_permissions(request.user)
        if beyond:
            raise PermissionDenied(
                "Vous ne pouvez pas accorder un droit que vous ne détenez pas : " + ', '.join(sorted(beyond)))

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


# ── Second factor (self-service) ──────────────────

class TwoFactorRateThrottle(UserRateThrottle):
    scope = 'two_factor'


class _TwoFactorView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [TwoFactorRateThrottle]
    allow_two_factor_setup_pending = True


def _two_factor_state(user):
    return {
        'enabled': user.two_factor_enabled,
        'required': two_factor.required_for(user),
        'enabled_at': user.two_factor_enabled_at,
        'backup_codes_left': two_factor.backup_codes_left(user) if user.two_factor_enabled else 0,
    }


class TwoFactorStatusView(_TwoFactorView):
    """GET /api/auth/two-factor/ — is the second factor on, is it required of this account, how many backup codes are left."""

    def get(self, request):
        return Response(_two_factor_state(request.user))


class TwoFactorSetupView(_TwoFactorView):
    """POST /api/auth/two-factor/setup/ {password} — a new secret (to type or scan into the application) waits for its first code."""

    def post(self, request):
        user = request.user
        if user.two_factor_enabled:
            return Response({'detail': "La double authentification est déjà activée."}, status=status.HTTP_400_BAD_REQUEST)
        if not user.check_password(str(request.data.get('password') or '')):
            return Response({'code': 'wrong_password', 'detail': "Mot de passe incorrect."}, status=status.HTTP_403_FORBIDDEN)
        secret = two_factor.begin_setup(user)
        return Response({'secret': ' '.join(secret[i:i + 4] for i in range(0, len(secret), 4)),
                         'otpauth_uri': two_factor.otpauth_uri(user, secret)})


class TwoFactorEnableView(_TwoFactorView):
    """POST /api/auth/two-factor/enable/ {code} — the first code from the application turns the second factor on."""

    def post(self, request):
        user = request.user
        if user.two_factor_enabled or not two_factor.pending_secret(user):
            return Response({'detail': "Aucune configuration en attente : recommencez la configuration."},
                            status=status.HTTP_400_BAD_REQUEST)
        backup = two_factor.confirm_setup(user, str(request.data.get('code') or ''))
        if backup is None:
            audit.log(AuditAction.TWO_FACTOR_FAILED, user=user, obj=user, reason="Code incorrect à l'activation")
            return Response({'code': 'two_factor_invalid', 'detail': "Code incorrect. Vérifiez l'heure de votre téléphone et réessayez."},
                            status=status.HTTP_400_BAD_REQUEST)
        audit.log(AuditAction.TWO_FACTOR_ENABLED, user=user, obj=user)
        return Response({'backup_codes': backup, **_two_factor_state(user)})


class _ConfirmedTwoFactorView(_TwoFactorView):
    """A change of the second factor asks for the password AND a current code."""

    def confirmed(self, request):
        user = request.user
        if not user.check_password(str(request.data.get('password') or '')):
            return Response({'code': 'wrong_password', 'detail': "Mot de passe incorrect."}, status=status.HTTP_403_FORBIDDEN)
        if not two_factor.verify_login_code(user, str(request.data.get('code') or '')):
            audit.log(AuditAction.TWO_FACTOR_FAILED, user=user, obj=user, reason='Code de vérification incorrect')
            return Response({'code': 'two_factor_invalid', 'detail': "Code de vérification incorrect ou déjà utilisé."},
                            status=status.HTTP_400_BAD_REQUEST)
        return None


class TwoFactorDisableView(_ConfirmedTwoFactorView):
    """POST /api/auth/two-factor/disable/ {password, code} — refused when the roles of the account must use it."""

    def post(self, request):
        user = request.user
        if not user.two_factor_enabled:
            return Response({'detail': "La double authentification n'est pas activée."}, status=status.HTTP_400_BAD_REQUEST)
        if two_factor.required_for(user):
            return Response({'code': 'two_factor_required',
                             'detail': "La double authentification est exigée pour votre rôle : elle ne peut pas être désactivée."},
                            status=status.HTTP_403_FORBIDDEN)
        refusal = self.confirmed(request)
        if refusal:
            return refusal
        two_factor.clear(user)
        audit.log(AuditAction.TWO_FACTOR_DISABLED, user=user, obj=user)
        return Response(_two_factor_state(user))


class TwoFactorBackupCodesView(_ConfirmedTwoFactorView):
    """POST /api/auth/two-factor/backup-codes/ {password, code} — eight new one-time codes; the old ones stop working."""

    def post(self, request):
        user = request.user
        if not user.two_factor_enabled:
            return Response({'detail': "La double authentification n'est pas activée."}, status=status.HTTP_400_BAD_REQUEST)
        refusal = self.confirmed(request)
        if refusal:
            return refusal
        return Response({'backup_codes': two_factor.generate_backup_codes(user), **_two_factor_state(user)})
