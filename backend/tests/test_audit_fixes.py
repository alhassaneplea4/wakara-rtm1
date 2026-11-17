"""Fixes of the global security audit (docs/audit-securite-global.md): documents and the six-month rule,
lockout per address, and no way up through the administration rights."""
import datetime

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import CustomUser, LoginAttempt, Permission, Role, RolePermission
from core.permissions import ALL_PERMISSION_CODES
from declarations.models import Declaration

from .base import PASSWORD, WakaraTestCase, make_user

JPEG = b'\xff\xd8\xff\xe0' + b'x' * 200


def role_with(codename, *permissions):
    role = Role.objects.create(codename=codename, name=codename.title())
    for code in permissions:
        RolePermission.objects.create(role=role, permission=Permission.objects.get(codename=code))
    return role


class DocumentsAndDeadlineTests(WakaraTestCase):
    def overdue_dossier(self):
        uuid = self.create_declaration()['uuid']
        self.assertEqual(self.transition(self.agent, uuid, 'TRANSMITTED').status_code, 200)
        doc = self.upload(self.secretary, uuid)
        self.assertEqual(doc.status_code, 201, doc.content)
        Declaration.objects.filter(uuid=uuid).update(received_at=timezone.localdate() - datetime.timedelta(days=400))
        return uuid, doc.data['uuid']

    def upload(self, user, uuid):
        return self.client_for(user).post('/api/documents/', {
            'declaration': uuid, 'kind': 'OTHER', 'file': SimpleUploadedFile('piece.jpg', JPEG)}, format='multipart')

    def test_no_document_is_added_to_a_dossier_past_the_six_months(self):
        uuid, _doc = self.overdue_dossier()
        r = self.upload(self.secretary, uuid)
        self.assertEqual(r.status_code, 403)
        self.assertIn('tribunaux', r.data['detail'])

    def test_no_document_is_archived_on_a_dossier_past_the_six_months(self):
        uuid, doc = self.overdue_dossier()
        r = self.client_for(self.secretary).delete(f'/api/documents/{doc}/')
        self.assertEqual(r.status_code, 403)
        self.assertIn('tribunaux', r.data['detail'])

    def test_the_administrator_keeps_the_hand_on_the_documents(self):
        uuid, doc = self.overdue_dossier()
        self.assertEqual(self.upload(self.admin, uuid).status_code, 201)
        self.assertEqual(self.client_for(self.admin).delete(f'/api/documents/{doc}/').status_code, 204)

    def test_documents_still_work_inside_the_deadline(self):
        uuid = self.create_declaration()['uuid']
        self.assertEqual(self.upload(self.agent, uuid).status_code, 201)


@override_settings(LOGIN_MAX_FAILED_ATTEMPTS=3, LOGIN_LOCKOUT_MINUTES=15, LOGIN_LOCKED_SOURCES_BEFORE_ACCOUNT_LOCK=3)
class LockoutPerAddressTests(WakaraTestCase):
    def login(self, username, password, ip):
        return APIClient().post('/api/auth/login/', {'username': username, 'password': password}, format='json', REMOTE_ADDR=ip)

    def test_a_stranger_guessing_passwords_does_not_lock_the_owner_out(self):
        for _ in range(4):
            self.login('admin', 'wrong', '203.0.113.9')
        self.assertEqual(self.login('admin', PASSWORD, '203.0.113.9').status_code, 403)   # the attacker is locked out
        self.assertEqual(self.login('admin', PASSWORD, '198.51.100.7').status_code, 200)  # the administrator is not
        self.assertFalse(CustomUser.objects.get(username='admin').is_locked)

    def test_the_lockout_cannot_be_reset_by_more_guesses_and_does_not_reveal_the_password(self):
        for _ in range(3):
            self.login('agent', 'wrong', '203.0.113.9')
        for _ in range(5):
            self.assertEqual(self.login('agent', 'wrong', '203.0.113.9').status_code, 403)
        self.assertEqual(self.login('agent', PASSWORD, '203.0.113.9').status_code, 403)

    def test_an_attack_from_several_addresses_locks_the_account_itself(self):
        for n in range(3):
            for _ in range(3):
                self.login('agent', 'wrong', f'203.0.113.{n + 1}')
        self.assertTrue(CustomUser.objects.get(username='agent').is_locked)
        self.assertEqual(self.login('agent', PASSWORD, '198.51.100.7').status_code, 403)

    def test_a_successful_sign_in_forgets_the_mistakes_of_that_address(self):
        self.login('agent', 'wrong', '198.51.100.7')
        self.login('agent', 'wrong', '198.51.100.7')
        self.assertEqual(self.login('agent', PASSWORD, '198.51.100.7').status_code, 200)
        self.assertFalse(LoginAttempt.objects.filter(user=self.agent).exists())
        self.login('agent', 'wrong', '198.51.100.7')
        self.login('agent', 'wrong', '198.51.100.7')
        self.assertEqual(self.login('agent', PASSWORD, '198.51.100.7').status_code, 200)  # the count started again

    def test_old_mistakes_are_forgotten_after_the_window(self):
        self.login('agent', 'wrong', '198.51.100.7')
        self.login('agent', 'wrong', '198.51.100.7')
        LoginAttempt.objects.filter(user=self.agent).update(updated_at=timezone.now() - datetime.timedelta(minutes=16))
        self.login('agent', 'wrong', '198.51.100.7')
        self.assertEqual(self.login('agent', PASSWORD, '198.51.100.7').status_code, 200)

    def test_the_administrator_unlocks_an_account(self):
        for _ in range(3):
            self.login('agent', 'wrong', '203.0.113.9')
        self.assertEqual(self.client_for(self.admin).post(f'/api/users/{self.agent.uuid}/activate/').status_code, 200)
        self.assertEqual(self.login('agent', PASSWORD, '203.0.113.9').status_code, 200)


class NoWayUpTests(WakaraTestCase):
    def test_role_manage_cannot_add_rights_its_holder_does_not_have(self):
        role = role_with('helper', 'role.view', 'role.manage')
        helper = self.client_for(make_user('helper', 'helper'))
        r = helper.put(f'/api/roles/{role.id}/permissions/', {'permissions': ALL_PERMISSION_CODES}, format='json')
        self.assertEqual(r.status_code, 403)
        self.assertIn('ne détenez pas', r.data['detail'])
        # ... on another role either (an accomplice's)
        other = Role.objects.get(codename='collection_agent')
        current = list(RolePermission.objects.filter(role=other).values_list('permission__codename', flat=True))
        r = helper.put(f'/api/roles/{other.id}/permissions/', {'permissions': current + ['user.reset_password']}, format='json')
        self.assertEqual(r.status_code, 403)
        # a right he holds may be handed out
        r = helper.put(f'/api/roles/{other.id}/permissions/', {'permissions': current + ['role.view']}, format='json')
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_administrator_still_manages_every_role(self):
        role = Role.objects.get(codename='secretary')
        current = list(RolePermission.objects.filter(role=role).values_list('permission__codename', flat=True))
        r = self.client_for(self.admin).put(f'/api/roles/{role.id}/permissions/', {'permissions': current + ['data.export']}, format='json')
        self.assertEqual(r.status_code, 200, r.content)

    def test_nobody_resets_the_password_of_an_account_with_more_rights(self):
        role_with('support', 'user.view', 'user.reset_password', 'user.update', 'user.manage_status')
        support = self.client_for(make_user('support', 'support'))
        r = support.post(f'/api/users/{self.admin.uuid}/reset-password/')
        self.assertEqual(r.status_code, 403)
        self.assertNotIn('temporary_password', r.data)
        self.assertEqual(support.patch(f'/api/users/{self.admin.uuid}/', {'email': 'pirate@example.test'}, format='json').status_code, 403)
        self.assertEqual(support.post(f'/api/users/{self.admin.uuid}/deactivate/').status_code, 403)
        # a deactivated administrator is still an administrator's account
        CustomUser.objects.filter(pk=self.admin.pk).update(is_active=False)
        self.assertEqual(support.post(f'/api/users/{self.admin.uuid}/reset-password/').status_code, 403)
        self.assertEqual(support.post(f'/api/users/{self.admin.uuid}/activate/').status_code, 403)

    def test_support_still_helps_the_accounts_below(self):
        role_with('support', 'user.view', 'user.reset_password', 'declaration.view', 'declaration.create',
                  'declaration.update', 'declaration.transmit', 'document.view', 'document.upload', 'hospital.view')
        support = self.client_for(make_user('support', 'support'))
        r = support.post(f'/api/users/{self.agent.uuid}/reset-password/')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn('temporary_password', r.data)

    def test_roles_and_overrides_are_only_handed_out_by_somebody_who_holds_them(self):
        role_with('hr', 'user.view', 'user.assign_roles')
        hr = self.client_for(make_user('hr', 'hr'))
        admin_role = Role.objects.get(codename='admin')
        self.assertEqual(hr.post(f'/api/users/{self.agent.uuid}/roles/', {'role': admin_role.id}, format='json').status_code, 403)
        self.assertEqual(hr.post(f'/api/users/{self.agent.uuid}/permissions/', {'codename': 'role.manage', 'granted': True}, format='json').status_code, 403)
        self.assertEqual(hr.post(f'/api/users/{self.admin.uuid}/roles/remove/', {'role': admin_role.id}, format='json').status_code, 403)
        self.assertFalse(self.agent.user_roles.filter(role=admin_role, is_active=True).exists())
        # the administrator still assigns any role
        self.assertEqual(self.client_for(self.admin).post(
            f'/api/users/{self.agent.uuid}/roles/', {'role': admin_role.id}, format='json').status_code, 201)

    def test_malformed_bodies_are_refused_cleanly(self):
        adm = self.client_for(self.admin)
        role = Role.objects.get(codename='secretary')
        self.assertEqual(adm.patch('/api/settings/', [1, 2], format='json').status_code, 400)
        self.assertEqual(adm.put(f'/api/roles/{role.id}/permissions/', {'permissions': [{'a': 1}]}, format='json').status_code, 400)
        self.assertEqual(adm.post(f'/api/users/{self.agent.uuid}/roles/', {'role': 'abc'}, format='json').status_code, 400)
