"""Authentication, role/permission enforcement and anti-privilege-escalation rules."""
from django.test import override_settings
from rest_framework.test import APIClient

from accounts.models import CustomUser, Permission, Role, UserPermission, UserRole
from audit.models import AuditLog
from core.permissions import get_user_permissions

from .base import PASSWORD, WakaraTestCase, make_user


class AuthenticationTests(WakaraTestCase):
    def login(self, username, password=PASSWORD):
        return APIClient().post('/api/auth/login/', {'username': username, 'password': password},
                                format='json')

    def test_login_returns_tokens_and_profile(self):
        r = self.login('secretary')
        self.assertEqual(r.status_code, 200)
        self.assertIn('access', r.data)
        self.assertIn('acte.update', r.data['user']['permissions'])
        self.assertEqual(r.data['user']['roles'][0]['codename'], 'secretary')

    def test_login_by_email(self):
        self.assertEqual(self.login('secretary@example.test').status_code, 200)

    def test_wrong_password_is_generic_401_and_audited(self):
        r = self.login('secretary', 'nope')
        self.assertEqual(r.status_code, 401)
        r2 = self.login('ghost', 'nope')
        self.assertEqual(r.data, r2.data)  # no account enumeration
        self.assertTrue(AuditLog.objects.filter(action='login_failed').count() >= 2)

    @override_settings(LOGIN_MAX_FAILED_ATTEMPTS=3, LOGIN_LOCKOUT_MINUTES=15)
    def test_account_locks_after_repeated_failures(self):
        for _ in range(3):
            self.login('agent', 'bad')
        r = self.login('agent', PASSWORD)  # correct password, but locked
        self.assertEqual(r.status_code, 403)
        self.assertIn('verrouillé', r.data['detail'])

    def test_inactive_account_cannot_login_nor_use_existing_token(self):
        token = self.login('agent').data['access']
        self.agent.is_active = False
        self.agent.save()
        self.assertEqual(self.login('agent').status_code, 403)
        c = APIClient()
        c.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        self.assertEqual(c.get('/api/auth/me/').status_code, 401)  # deactivation is immediate

    def test_logout_blacklists_refresh_token(self):
        data = self.login('agent').data
        c = APIClient()
        c.credentials(HTTP_AUTHORIZATION=f"Bearer {data['access']}")
        self.assertEqual(c.post('/api/auth/logout/', {'refresh': data['refresh']}, format='json').status_code, 204)
        r = APIClient().post('/api/auth/refresh/', {'refresh': data['refresh']}, format='json')
        self.assertEqual(r.status_code, 401)

    def test_anonymous_gets_401_everywhere(self):
        c = APIClient()
        for url in ['/api/declarations/', '/api/users/', '/api/hospitals/', '/api/stats/dashboard/',
                    '/api/audit/', '/api/actes/', '/api/inbox/']:
            self.assertEqual(c.get(url).status_code, 401, url)

    def test_must_change_password_blocks_business_api_until_changed(self):
        u = make_user('newbie', 'secretary', must_change_password=True)
        c = self.client_for(u)
        self.assertEqual(c.get('/api/declarations/').status_code, 403)
        r = c.post('/api/auth/change-password/', {'old_password': PASSWORD, 'new_password': 'An0ther-Str0ng-One!'},
                   format='json')
        self.assertEqual(r.status_code, 200)
        u = CustomUser.objects.get(pk=u.pk)
        self.assertEqual(self.client_for(u).get('/api/declarations/').status_code, 200)

    def test_weak_new_password_rejected(self):
        r = self.client_for(self.agent).post(
            '/api/auth/change-password/', {'old_password': PASSWORD, 'new_password': '12345678'}, format='json')
        self.assertEqual(r.status_code, 400)

    def test_passwords_never_written_to_audit_log(self):
        self.client_for(self.admin).post('/api/users/', {
            'username': 'fresh', 'password': 'Sup3r-Secret-Pass!', 'email': 'f@example.test'}, format='json')
        self.login('agent', 'Sup3r-Secret-Pass!')
        for entry in AuditLog.objects.all():
            self.assertNotIn('Sup3r-Secret-Pass', str(entry.changes) + entry.reason + entry.object_repr)


class PermissionTests(WakaraTestCase):
    def test_django_superuser_has_no_business_permissions(self):
        """The framework super-admin is NOT the Wakara administrator."""
        su = CustomUser.objects.create_superuser('root', 'r@example.test', PASSWORD)
        self.assertEqual(get_user_permissions(su), set())
        c = self.client_for(su)
        self.assertEqual(c.get('/api/users/').status_code, 403)
        self.assertEqual(c.get('/api/declarations/').status_code, 403)

    def test_admin_role_is_not_django_superuser(self):
        self.assertFalse(self.admin.is_superuser)
        self.assertFalse(self.admin.is_staff)
        self.assertEqual(self.client_for(self.admin).get('/api/users/').status_code, 200)

    def test_each_role_gets_only_its_own_permissions(self):
        c = self.client_for(self.agent)
        self.assertEqual(c.get('/api/users/').status_code, 403)
        self.assertEqual(c.get('/api/audit/').status_code, 403)
        self.assertEqual(c.get('/api/stats/dashboard/').status_code, 403)
        self.assertEqual(c.post('/api/hospitals/', {'code': 'X', 'name': 'X'}, format='json').status_code, 403)
        self.assertEqual(self.client_for(self.secretary).get('/api/users/').status_code, 403)
        self.assertEqual(self.client_for(self.nobody).get('/api/declarations/').status_code, 403)

    def test_viewset_is_fail_closed_for_unmapped_actions(self):
        from core.permissions import HasWakaraPermission

        class V:
            action = 'something_new'
            permission_map = {'list': 'declaration.view'}

        class R:
            user = self.admin

        self.assertFalse(HasWakaraPermission().has_permission(R, V))

    def test_user_override_can_grant_and_deny(self):
        perm = Permission.objects.get(codename='audit.view')
        UserPermission.objects.create(user=self.agent, permission=perm, granted=True)
        self.assertEqual(self.client_for(CustomUser.objects.get(pk=self.agent.pk)).get('/api/audit/').status_code, 200)
        deny = Permission.objects.get(codename='declaration.create')
        UserPermission.objects.create(user=self.agent, permission=deny, granted=False)
        c = self.client_for(CustomUser.objects.get(pk=self.agent.pk))
        self.assertEqual(c.post('/api/declarations/', self.declaration_payload(), format='json').status_code, 403)

    def test_inactive_role_gives_no_permission(self):
        Role.objects.filter(codename='collection_agent').update(is_active=False)
        self.assertEqual(self.client_for(CustomUser.objects.get(pk=self.agent.pk)).get('/api/declarations/').status_code, 403)


class PrivilegeEscalationTests(WakaraTestCase):
    def test_admin_cannot_change_own_roles_or_permissions(self):
        c = self.client_for(self.admin)
        role = Role.objects.get(codename='secretary')
        self.assertEqual(c.post(f'/api/users/{self.admin.uuid}/roles/', {'role': role.pk}, format='json').status_code, 403)
        self.assertEqual(c.post(f'/api/users/{self.admin.uuid}/permissions/', {'codename': 'audit.view'},
                                format='json').status_code, 403)
        self.assertEqual(c.post(f'/api/users/{self.admin.uuid}/deactivate/').status_code, 403)

    def test_user_cannot_escalate_through_profile_endpoint(self):
        c = self.client_for(self.agent)
        r = c.patch('/api/auth/me/', {'is_superuser': True, 'is_staff': True, 'roles': ['admin'],
                                      'first_name': 'Changed'}, format='json')
        self.assertEqual(r.status_code, 200)
        u = CustomUser.objects.get(pk=self.agent.pk)
        self.assertFalse(u.is_superuser or u.is_staff)
        self.assertEqual(u.first_name, 'Changed')
        self.assertEqual(u.role_codenames, ['collection_agent'])

    def test_user_creation_ignores_privileged_flags(self):
        r = self.client_for(self.admin).post('/api/users/', {
            'username': 'sneaky', 'password': 'Sup3r-Secret-Pass!', 'is_superuser': True,
            'is_staff': True}, format='json')
        self.assertEqual(r.status_code, 201)
        u = CustomUser.objects.get(username='sneaky')
        self.assertFalse(u.is_superuser or u.is_staff)
        self.assertTrue(u.must_change_password)

    def test_admin_role_keeps_lockout_protection_permissions(self):
        other_admin = make_user('admin2', 'admin')
        role = Role.objects.get(codename='admin')
        perms = [p for p in role.role_permissions.values_list('permission__codename', flat=True)
                 if p != 'role.manage']
        r = self.client_for(other_admin).put(f'/api/roles/{role.pk}/permissions/',
                                             {'permissions': perms}, format='json')
        self.assertEqual(r.status_code, 400)

    def test_admin_can_adjust_other_roles_and_it_is_audited(self):
        role = Role.objects.get(codename='secretary')
        perms = list(role.role_permissions.values_list('permission__codename', flat=True)) + ['stats.view']
        r = self.client_for(self.admin).put(f'/api/roles/{role.pk}/permissions/',
                                            {'permissions': sorted(set(perms)) + ['data.export'],
                                             'reason': 'Besoin export'}, format='json')
        self.assertEqual(r.status_code, 200)
        self.assertIn('data.export', r.data['permissions'])
        log = AuditLog.objects.filter(action='permission_changed').latest('id')
        self.assertEqual(log.changes['added'], ['data.export'])
        self.assertEqual(log.reason, 'Besoin export')

    def test_assigning_role_to_other_user_works_and_is_audited(self):
        role = Role.objects.get(codename='secretary')
        r = self.client_for(self.admin).post(f'/api/users/{self.nobody.uuid}/roles/', {'role': role.pk}, format='json')
        self.assertEqual(r.status_code, 201)
        self.assertTrue(AuditLog.objects.filter(action='role_assigned', object_id=str(self.nobody.uuid)).exists())
        self.assertEqual(self.client_for(CustomUser.objects.get(pk=self.nobody.pk)).get('/api/declarations/').status_code, 200)

    def test_users_and_roles_cannot_be_deleted(self):
        c = self.client_for(self.admin)
        # refused (fail-closed permission check or 405): either way nothing is removed
        self.assertIn(c.delete(f'/api/users/{self.agent.uuid}/').status_code, (403, 405))
        self.assertIn(c.delete(f'/api/roles/{Role.objects.first().pk}/').status_code, (403, 405))
        self.assertTrue(CustomUser.objects.filter(pk=self.agent.pk).exists())
        self.assertTrue(Role.objects.filter(codename='collection_agent').exists())

    def test_reset_password_forces_change_and_hides_nothing_in_audit(self):
        r = self.client_for(self.admin).post(f'/api/users/{self.agent.uuid}/reset-password/')
        self.assertEqual(r.status_code, 200)
        temp = r.data['temporary_password']
        self.assertTrue(CustomUser.objects.get(pk=self.agent.pk).must_change_password)
        self.assertFalse(AuditLog.objects.filter(changes__icontains=temp).exists())
