"""Serializers for the accounts app."""
from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from rest_framework import serializers

from core.permissions import get_user_permissions

from hospitals.models import Hospital

from .models import Permission, Role, UserPermission, UserRole

User = get_user_model()


class LoginSerializer(serializers.Serializer):
    username = serializers.CharField(max_length=254)
    password = serializers.CharField(write_only=True, trim_whitespace=False)


class ChangePasswordSerializer(serializers.Serializer):
    old_password = serializers.CharField(write_only=True, trim_whitespace=False)
    new_password = serializers.CharField(write_only=True, trim_whitespace=False)

    def validate_new_password(self, value):
        validate_password(value, self.context['request'].user)
        return value


class RoleBriefSerializer(serializers.ModelSerializer):
    class Meta:
        model = Role
        fields = ['id', 'codename', 'name']


class HospitalSlugField(serializers.SlugRelatedField):
    def __init__(self, **kwargs):
        kwargs.setdefault('slug_field', 'uuid')
        if not kwargs.get('read_only'):
            kwargs.setdefault('queryset', Hospital.objects.all())
            kwargs.setdefault('required', False)
            kwargs.setdefault('allow_null', True)
        super().__init__(**kwargs)


class UserListSerializer(serializers.ModelSerializer):
    hospital = HospitalSlugField(read_only=True)
    roles = serializers.SerializerMethodField()
    hospital_name = serializers.CharField(source='hospital.name', read_only=True, default=None)

    class Meta:
        model = User
        fields = [
            'uuid', 'username', 'email', 'first_name', 'last_name', 'phone',
            'is_active', 'hospital', 'hospital_name', 'roles', 'date_joined',
            'last_login', 'is_locked',
        ]
        read_only_fields = fields

    def get_roles(self, obj):
        return [
            {'codename': ur.role.codename, 'name': ur.role.name}
            for ur in obj.user_roles.all()
            if ur.is_active and ur.role.is_active
        ]


class UserDetailSerializer(UserListSerializer):
    permission_overrides = serializers.SerializerMethodField()
    effective_permissions = serializers.SerializerMethodField()

    class Meta(UserListSerializer.Meta):
        fields = UserListSerializer.Meta.fields + [
            'address', 'must_change_password', 'permission_overrides', 'effective_permissions',
        ]
        read_only_fields = fields

    def get_permission_overrides(self, obj):
        return [
            {'codename': o.permission.codename, 'granted': o.granted}
            for o in obj.permission_overrides.select_related('permission')
        ]

    def get_effective_permissions(self, obj):
        return sorted(get_user_permissions(obj))


class UserCreateSerializer(serializers.ModelSerializer):
    """Role assignment is NOT accepted here — it goes through the audited roles action."""
    hospital = HospitalSlugField()
    password = serializers.CharField(write_only=True, trim_whitespace=False)

    class Meta:
        model = User
        fields = [
            'uuid', 'username', 'email', 'first_name', 'last_name',
            'phone', 'address', 'hospital', 'password',
        ]
        read_only_fields = ['uuid']

    def validate_email(self, value):
        if value and User.objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError("Cette adresse e-mail est déjà utilisée.")
        return value

    def validate(self, attrs):
        temp = User(**{k: v for k, v in attrs.items() if k != 'password'})
        validate_password(attrs['password'], temp)
        return attrs

    def create(self, validated_data):
        password = validated_data.pop('password')
        user = User(**validated_data)
        user.set_password(password)
        user.must_change_password = True
        user.save()
        return user


class UserUpdateSerializer(serializers.ModelSerializer):
    hospital = HospitalSlugField()

    class Meta:
        model = User
        fields = ['email', 'first_name', 'last_name', 'phone', 'address', 'hospital']

    def validate_email(self, value):
        qs = User.objects.filter(email__iexact=value).exclude(pk=self.instance.pk)
        if value and qs.exists():
            raise serializers.ValidationError("Cette adresse e-mail est déjà utilisée.")
        return value


class MeSerializer(serializers.ModelSerializer):
    hospital = HospitalSlugField(read_only=True)
    roles = serializers.SerializerMethodField()
    permissions = serializers.SerializerMethodField()
    hospital_name = serializers.CharField(source='hospital.name', read_only=True, default=None)

    class Meta:
        model = User
        fields = [
            'uuid', 'username', 'email', 'first_name', 'last_name', 'phone', 'address',
            'hospital', 'hospital_name', 'roles', 'permissions', 'must_change_password',
            'date_joined', 'last_login',
        ]
        read_only_fields = [
            'uuid', 'username', 'hospital', 'roles', 'permissions',
            'must_change_password', 'date_joined', 'last_login',
        ]

    def get_roles(self, obj):
        return [
            {'codename': ur.role.codename, 'name': ur.role.name}
            for ur in obj.user_roles.select_related('role')
            if ur.is_active and ur.role.is_active
        ]

    def get_permissions(self, obj):
        return sorted(get_user_permissions(obj))


class PermissionSerializer(serializers.ModelSerializer):
    class Meta:
        model = Permission
        fields = ['id', 'codename', 'name', 'category', 'description']
        read_only_fields = fields


class RoleSerializer(serializers.ModelSerializer):
    permissions = serializers.SerializerMethodField()
    user_count = serializers.SerializerMethodField()

    class Meta:
        model = Role
        fields = [
            'id', 'codename', 'name', 'description', 'is_active', 'is_system',
            'permissions', 'user_count',
        ]
        read_only_fields = ['id', 'is_system', 'permissions', 'user_count']

    def get_permissions(self, obj):
        return sorted(
            rp.permission.codename for rp in obj.role_permissions.select_related('permission')
        )

    def get_user_count(self, obj):
        return obj.user_roles.filter(is_active=True).count()

    def validate_codename(self, value):
        if self.instance and self.instance.codename != value:
            raise serializers.ValidationError("Le code d'un rôle ne peut pas être modifié.")
        return value


class UserRoleSerializer(serializers.ModelSerializer):
    role_codename = serializers.CharField(source='role.codename', read_only=True)
    role_name = serializers.CharField(source='role.name', read_only=True)

    class Meta:
        model = UserRole
        fields = ['id', 'role', 'role_codename', 'role_name', 'is_active', 'assigned_at']
        read_only_fields = fields


class UserPermissionSerializer(serializers.ModelSerializer):
    codename = serializers.CharField(source='permission.codename', read_only=True)

    class Meta:
        model = UserPermission
        fields = ['codename', 'granted']
