from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .models import CustomUser, Permission, Role, RolePermission, UserPermission, UserRole


@admin.register(CustomUser)
class CustomUserAdmin(UserAdmin):
    """Django Admin = technical maintenance only (reserved to the Django superuser)."""
    list_display = ['username', 'email', 'first_name', 'last_name', 'is_active', 'hospital']
    list_filter = ['is_active', 'is_staff', 'is_superuser', 'hospital']
    fieldsets = UserAdmin.fieldsets + (
        ('Wakara', {'fields': ('phone', 'address', 'hospital', 'must_change_password')}),
    )

    def has_delete_permission(self, request, obj=None):
        return False


class NoDeleteAdmin(admin.ModelAdmin):
    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(Role)
class RoleAdmin(NoDeleteAdmin):
    list_display = ['codename', 'name', 'is_active', 'is_system']


@admin.register(Permission)
class PermissionAdmin(NoDeleteAdmin):
    list_display = ['codename', 'name', 'category']
    list_filter = ['category']


@admin.register(RolePermission)
class RolePermissionAdmin(admin.ModelAdmin):
    list_display = ['role', 'permission']


@admin.register(UserRole)
class UserRoleAdmin(admin.ModelAdmin):
    list_display = ['user', 'role', 'is_active', 'assigned_at']


@admin.register(UserPermission)
class UserPermissionAdmin(admin.ModelAdmin):
    list_display = ['user', 'permission', 'granted']
