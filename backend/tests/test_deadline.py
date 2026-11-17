"""Six-month rule: a dossier not treated six months after its declaration goes to the courts; only the admin may act."""
from django.utils import timezone
import datetime

from core.deadline import add_months, cutoff
from declarations.models import Declaration

from .base import WakaraTestCase


def months_ago(n, extra_days=0):
    return add_months(timezone.localdate(), -n) - datetime.timedelta(days=extra_days)


class MonthArithmeticTests(WakaraTestCase):
    def test_add_months_keeps_the_end_of_month_inside_the_month(self):
        self.assertEqual(add_months(datetime.date(2026, 8, 31), -6), datetime.date(2026, 2, 28))
        self.assertEqual(add_months(datetime.date(2028, 8, 31), -6), datetime.date(2028, 2, 29))
        self.assertEqual(add_months(datetime.date(2026, 1, 15), -6), datetime.date(2025, 7, 15))
        self.assertEqual(add_months(datetime.date(2026, 11, 16), 6), datetime.date(2027, 5, 16))

    def test_cutoff_is_six_months_before_today(self):
        self.assertEqual(cutoff(datetime.date(2026, 11, 16)), datetime.date(2026, 5, 16))


class DeadlineTests(WakaraTestCase):
    def old(self, received, status=None, **overrides):
        """A dossier whose declaration date is ``received`` (set directly: the API always dates it today)."""
        uuid = self.create_declaration(**overrides)['uuid']
        fields = {'received_at': received}
        if status:
            fields['status'] = status
        Declaration.objects.filter(uuid=uuid).update(**fields)
        return uuid

    def detail(self, user, uuid):
        r = self.client_for(user).get(f'/api/declarations/{uuid}/')
        self.assertEqual(r.status_code, 200, r.content)
        return r.data

    def test_a_recent_dossier_is_not_concerned(self):
        uuid = self.old(months_ago(5))
        d = self.detail(self.agent, uuid)
        self.assertFalse(d['deadline']['overdue'])
        self.assertTrue(d['can_edit'])
        self.assertEqual(d['deadline']['message'], '')

    def test_the_day_after_six_months_the_dossier_is_overdue_with_a_message(self):
        on_the_day = self.old(months_ago(6), status='TRANSMITTED')
        self.assertFalse(self.detail(self.secretary, on_the_day)['deadline']['overdue'])
        late = self.old(months_ago(6, extra_days=1), status='TRANSMITTED')
        d = self.detail(self.secretary, late)
        self.assertTrue(d['deadline']['overdue'])
        self.assertEqual(d['deadline']['days_over'], 1)
        self.assertIn('tribunaux', d['deadline']['message'])
        self.assertTrue(d['overdue'])

    def test_overdue_dossier_is_blocked_for_everyone_but_the_admin(self):
        uuid = self.old(months_ago(7), status='TRANSMITTED')
        sec = self.client_for(self.secretary)
        d = self.detail(self.secretary, uuid)
        self.assertFalse(d['can_edit'])
        self.assertEqual(d['available_transitions'], [])
        self.assertFalse(d['deadline']['can_override'])
        # data, acte references and status changes are all refused, with the explanation
        r = sec.patch(f'/api/declarations/{uuid}/', {'doctor_name': 'Dr Autre'}, format='json')
        self.assertEqual(r.status_code, 403)
        self.assertIn('tribunaux', r.data['detail'])
        r = sec.patch(f"/api/actes/{d['acte_uuid']}/", {'registre': 'R9'}, format='json') if d['acte_uuid'] else None
        if r is not None:
            self.assertEqual(r.status_code, 403)
        self.assertEqual(self.transition(self.secretary, uuid, 'IN_COMPLETION').status_code, 403)
        self.assertEqual(Declaration.objects.get(uuid=uuid).status, 'TRANSMITTED')
        # the admin still can
        a = self.detail(self.admin, uuid)
        self.assertTrue(a['deadline']['can_override'])
        self.assertTrue(a['can_edit'])
        self.assertEqual(self.client_for(self.admin).patch(
            f'/api/declarations/{uuid}/', {'doctor_name': 'Dr Admin'}, format='json').status_code, 200)
        self.assertEqual(self.transition(self.admin, uuid, 'IN_COMPLETION').status_code, 200)

    def test_the_agent_cannot_edit_or_transmit_an_overdue_draft(self):
        uuid = self.old(months_ago(8))
        self.assertFalse(self.detail(self.agent, uuid)['can_edit'])
        self.assertEqual(self.client_for(self.agent).patch(
            f'/api/declarations/{uuid}/', {'doctor_name': 'Dr X'}, format='json').status_code, 403)
        self.assertEqual(self.transition(self.agent, uuid, 'TRANSMITTED').status_code, 403)

    def test_a_later_declaration_date_on_the_acte_does_not_give_the_dossier_a_second_life(self):
        uuid = self.old(months_ago(7), status='TRANSMITTED')
        self.assertEqual(self.client_for(self.admin).patch(
            f'/api/declarations/{uuid}/', {'acte': {'declaration_date': timezone.localdate().isoformat()}},
            format='json').status_code, 200)
        self.assertTrue(self.detail(self.secretary, uuid)['deadline']['overdue'])

    def test_a_treated_dossier_is_not_concerned(self):
        for status in ('VALIDATED', 'REJECTED'):
            uuid = self.old(months_ago(12), status=status)
            self.assertFalse(self.detail(self.secretary, uuid)['deadline']['overdue'], status)

    def test_list_filter_and_notification(self):
        late = self.old(months_ago(7), status='TRANSMITTED')
        fresh = self.old(months_ago(1), status='TRANSMITTED')
        sec = self.client_for(self.secretary)
        listed = {x['uuid'] for x in sec.get('/api/declarations/', {'overdue': 'true'}).data['results']}
        self.assertEqual(listed, {late})
        flags = {x['uuid']: x['overdue'] for x in sec.get('/api/declarations/').data['results']}
        self.assertEqual((flags[late], flags[fresh]), (True, False))
        inbox = sec.get('/api/inbox/').data
        item = next(i for i in inbox['items'] if i['code'] == 'overdue')
        self.assertEqual(item['count'], 1)
        self.assertIn('tribunaux', item['label'])
        # nothing overdue → no notification
        Declaration.objects.filter(uuid=late).update(received_at=months_ago(1))
        self.assertFalse([i for i in sec.get('/api/inbox/').data['items'] if i['code'] == 'overdue'])

    def test_the_override_is_a_permission_the_admin_can_hand_out(self):
        from accounts.models import Permission, RolePermission
        self.assertTrue(RolePermission.objects.filter(role__codename='admin',
                                                      permission__codename='dossier.override_deadline').exists())
        self.assertFalse(RolePermission.objects.filter(role__codename='secretary',
                                                       permission__codename='dossier.override_deadline').exists())
        self.assertTrue(Permission.objects.filter(codename='dossier.override_deadline').exists())
