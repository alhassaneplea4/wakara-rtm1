"""Duplicate prevention: detection, scoring, cases, decisions, blocking, offline synchronisation (fictional data)."""
import datetime
import uuid as uuid_lib
from unittest import mock

from django.db import IntegrityError

from actes.models import Acte
from audit.models import AuditLog
from core.mixins import HardDeleteForbidden
from declarations.models import Declaration
from duplicates import text
from duplicates.config import default_config
from duplicates.models import (
    BirthIdentity, CaseStatus, DuplicateCase, DuplicateCheck, DuplicateMatch,
    DuplicateReviewHistory,
)
from duplicates.services.identity import BirthIdentityService
from duplicates.services.scoring import DuplicateScoringService

from .base import WakaraTestCase, make_user
from .test_offline_sync import DEVICE, SyncTestCase

BIRTH = (datetime.date.today() - datetime.timedelta(days=5)).isoformat()


class DuplicateBase(WakaraTestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.investigator = cls.secretary          # secretary: consult + investigate (default role)

    def payload(self, mother=('Fatoumata', 'Bah'), child=('Aminata', 'Diallo'), father=None, date=BIRTH,
                time='08:30', place='Ratoma', gender='F', rank=None, hospital_ref='H-100', hospital=True,
                mother_extra=None, **extra):
        data = {
            'birth_date': date, 'birth_place': place,
            'doctor_name': 'Dr Test',
            'child': {'first_names': child[0], 'last_name': child[1], 'gender': gender,
                      **({'birth_rank': rank} if rank else {})},
            'mother': {'first_names': mother[0], 'last_name': mother[1], **(mother_extra or {})},
        }
        if time:
            data['birth_time'] = time
        if hospital:
            data['hospital'] = str(self.hospital.uuid)
        if hospital_ref:
            data['hospital_document_ref'] = hospital_ref
        if father:
            data['father'] = {'first_names': father[0], 'last_name': father[1]}
        data.update(extra)
        return data

    def mk(self, agent=None, **kwargs):
        data = self.payload(**kwargs)
        if not (data.get('birth_time') and data.get('birth_place') and data['child'].get('gender')):
            # the API now requires time, place and sex: partial records (older paper forms, imports) go through the service
            from declarations import services
            data['hospital'] = self.hospital if data.get('hospital') else None
            data['birth_date'] = datetime.date.fromisoformat(data['birth_date'])
            if data.get('birth_time'):
                data['birth_time'] = datetime.time.fromisoformat(data['birth_time'])
            d = services.create_declaration(agent or self.agent, data)
            return {'uuid': str(d.uuid), 'hospital_document_ref': d.hospital_document_ref}
        r = self.client_for(agent or self.agent).post('/api/declarations/', data, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        return r.data

    def case_for(self, *uuids):
        qs = DuplicateCase.objects.filter(declaration__uuid__in=uuids, other_declaration__uuid__in=uuids)
        return qs.first()

    def to_pending(self, uuid):
        """Like advance_to_pending, but the dossier is transmitted by the agent who owns it."""
        owner = Declaration.objects.get(uuid=uuid).created_by
        self.assertEqual(self.transition(owner, uuid, 'TRANSMITTED').status_code, 200)
        self.assertEqual(self.transition(self.secretary, uuid, 'IN_COMPLETION').status_code, 200)
        det = self.client_for(self.secretary).get(f'/api/declarations/{uuid}/').data
        c = self.client_for(self.secretary)
        self.assertEqual(c.patch(f'/api/actes/{det["acte_uuid"]}/', {
            'declaration_date': datetime.date.today().isoformat(), 'registre': 'R1'}, format='json').status_code, 200)
        self.assertEqual(c.patch(f'/api/declarations/{uuid}/', {'declarant': {
            'first_names': 'Mamadou', 'last_name': 'Diallo', 'relationship': 'Père'}}, format='json').status_code, 200)
        self.assertEqual(self.transition(self.secretary, uuid, 'PENDING_VALIDATION').status_code, 200)

    def validate(self, user, uuid, number):
        return self.transition(user, uuid, 'VALIDATED', annee=2026, registre='R1', numero_acte=number,
                               accept_incomplete=True)

    def decide(self, user, case, decision, reason='Motif de test', **extra):
        return self.client_for(user).post(f'/api/duplicates/cases/{case.uuid}/decide/',
                                          {'decision': decision, 'reason': reason, **extra}, format='json')


# ── 1-6 : detection ──────────────────────────────

class DetectionTests(DuplicateBase):
    def test_1_strictly_identical_declarations_raise_a_high_risk_case(self):
        a = self.mk(self.agent)
        b = self.mk(self.agent2)
        case = self.case_for(a['uuid'], b['uuid'])
        self.assertIsNotNone(case)
        self.assertEqual(case.risk_level, 'HIGH')
        self.assertGreaterEqual(case.score, 85)
        self.assertEqual(case.status, CaseStatus.OPEN)
        # nothing was merged, deleted or blocked in the normal circuit
        self.assertEqual(Declaration.objects.count(), 2)
        self.assertEqual(self.transition(self.agent2, b['uuid'], 'TRANSMITTED').status_code, 200)

    def test_2_spelling_differences_are_still_detected(self):
        a = self.mk(self.agent, mother=('Fatoumata', 'Kamara'), child=('Mamadou', 'Camara'))
        b = self.mk(self.agent2, mother=('Fatoumata', 'Camara'), child=('Mamadu', 'Kamara'),
                    hospital_ref='')
        case = self.case_for(a['uuid'], b['uuid'])
        self.assertIsNotNone(case, "Kamara/Camara et Mamadou/Mamadu doivent être rapprochés")
        self.assertIn(case.risk_level, ('MEDIUM', 'HIGH'))
        crit = case.match.criteria
        self.assertGreater(crit['mother']['similarity'], 0.85)
        self.assertFalse(crit['mother']['exact'])        # similar, not identical: shown as approximate

    def test_3_parents_partially_different_names(self):
        a = self.mk(self.agent, mother=('Fatoumata', 'Bah'), father=('Mamadou', 'Diallo'))
        b = self.mk(self.agent2, mother=('Fatou', 'Bah'), father=('Mamadou', 'Dialo'), hospital_ref='')
        case = self.case_for(a['uuid'], b['uuid'])
        self.assertIsNotNone(case)
        self.assertGreaterEqual(case.score, 60)
        # name inversion is handled too
        c = self.mk(self.agent, mother=('Bah', 'Fatoumata'), child=('Diallo', 'Aminata'))
        self.assertIsNotNone(self.case_for(a['uuid'], c['uuid']))

    def test_4_twins_same_day_same_place_are_flagged_not_declared_duplicates(self):
        a = self.mk(self.agent, child=('Aminata', 'Diallo'), gender='F', rank=1, time='08:30', hospital_ref='')
        b = self.mk(self.agent, child=('Mariama', 'Diallo'), gender='F', rank=2, time='08:41', hospital_ref='')
        case = self.case_for(a['uuid'], b['uuid'])
        self.assertIsNotNone(case, "jumeaux : un humain doit trancher, rien n'est écarté automatiquement")
        self.assertTrue(case.match.flags['twin_suspected'])
        self.assertNotEqual(case.risk_level, 'HIGH')
        self.assertEqual(case.anomaly_type, 'POSSIBLE_MULTIPLE_BIRTH')
        self.assertIn('Rang de naissance différent', case.match.flags['distinguishing'])
        # the responsible person records "naissance multiple": both dossiers can then be validated
        r = self.decide(self.admin, case, 'MULTIPLE_BIRTH', "Jumelles : rangs 1 et 2, heures différentes")
        self.assertEqual(r.status_code, 200, r.content)
        for d, n in ((a, '501'), (b, '502')):
            self.to_pending(d['uuid'])
            self.assertEqual(self.validate(self.admin, d['uuid'], n).status_code, 200)

    def test_same_mother_date_and_hospital_never_suffice_for_a_high_risk(self):
        a = self.mk(self.agent, child=('', ''), gender='', time='', hospital_ref='', place='Ratoma')
        b = self.mk(self.agent, child=('', ''), gender='', time='', hospital_ref='', place='Ratoma')
        case = self.case_for(a['uuid'], b['uuid'])
        self.assertIsNotNone(case)
        self.assertNotEqual(case.risk_level, 'HIGH')
        self.assertTrue(any('Seuls la mère' in c for c in case.match.flags['risk_caps']))

    def test_5_distinct_children_of_different_parents_raise_nothing(self):
        a = self.mk(self.agent, mother=('Fatoumata', 'Bah'), child=('Aminata', 'Diallo'))
        b = self.mk(self.agent2, mother=('Kadiatou', 'Soumah'), child=('Ibrahima', 'Sylla'), time='14:10',
                    hospital_ref='H-205')
        self.assertIsNone(self.case_for(a['uuid'], b['uuid']))
        self.assertEqual(DuplicateCase.objects.count(), 0)
        self.assertEqual(self.validate_ok(a['uuid'], '601'), 200)

    def validate_ok(self, uuid, number):
        self.to_pending(uuid)
        return self.validate(self.admin, uuid, number).status_code

    def test_6_declaration_without_hospital_reference_is_accepted_and_analysed(self):
        a = self.mk(self.agent, hospital_ref='', hospital=False)
        self.assertEqual(a['hospital_document_ref'], '')
        ident = BirthIdentity.objects.get(declaration__uuid=a['uuid'])
        self.assertIn('Établissement', ident.missing_fields)
        self.assertLess(ident.data_quality, 100)
        self.assertTrue(DuplicateCheck.objects.filter(declaration__uuid=a['uuid']).exists())

    def test_originals_are_never_altered_by_normalisation(self):
        a = self.mk(self.agent, mother=('FATOUMATA', 'Bâh'), child=('Aïssatou', 'DIALLO'))
        d = Declaration.objects.get(uuid=a['uuid'])
        self.assertEqual(d.parents.get(parent_type='MOTHER').first_names, 'FATOUMATA')
        self.assertEqual(d.child.first_names, 'Aïssatou')
        self.assertEqual(d.identity.mother_name_key, 'bah fatoumata')

    def test_archived_and_rejected_handling(self):
        a = self.mk(self.agent)
        d = Declaration.objects.get(uuid=a['uuid'])
        d.archive(user=self.admin)               # an old, archived declaration must still be found
        b = self.mk(self.agent2)
        self.assertIsNotNone(self.case_for(a['uuid'], b['uuid']))


# ── scoring unit tests ───────────────────────────

class ScoringTests(DuplicateBase):
    def ident(self, **kw):
        a = self.mk(**kw)
        return BirthIdentity.objects.get(declaration__uuid=a['uuid'])

    def test_missing_information_earns_no_artificial_points(self):
        full = self.ident(father=('Mamadou', 'Diallo'))
        sparse = self.ident(mother=('Kadiatou', 'Soumah'), child=('', ''), gender='', time='', hospital_ref='',
                            hospital=False, place='')
        cfg = default_config()
        res = DuplicateScoringService.score(full, sparse, cfg)
        keys = {k for k, c in res['criteria'].items() if c['comparable']}
        self.assertNotIn('birth_time', keys)
        self.assertNotIn('father', keys)
        self.assertLess(res['data_quality'], 100)       # comparable weight < 100 points
        self.assertEqual(sum(c['weight'] for c in res['criteria'].values() if c['comparable']),
                         res['comparable_points'])

    def test_thresholds_and_weights_are_configurable(self):
        a, b = self.ident(), self.ident(mother=('Fatoumata', 'Bah'))
        cfg = default_config()
        high = DuplicateScoringService.score(a, b, cfg)
        cfg['thresholds'] = {'high': 99.9, 'medium': 99.5}
        self.assertEqual(DuplicateScoringService.score(a, b, cfg)['risk_level'], 'HIGH' if high['score'] >= 99.9
                         else 'MEDIUM' if high['score'] >= 99.5 else 'LOW')
        self.assertEqual(sum(default_config()['weights'].values()), 100)

    def test_text_primitives(self):
        self.assertGreater(text.name_similarity('Fatoumata Bah', 'Bah Fatoumata'), 0.99)
        self.assertGreater(text.name_similarity('Kamara', 'Camara'), 0.9)
        self.assertLess(text.name_similarity('Fatoumata Bah', 'Mariama Diallo'), 0.4)
        self.assertEqual(text.phonetic_key('Kamara'), text.phonetic_key('Camara'))
        self.assertEqual(text.normalize_phone('+224 622 12 34 56'), '622123456')
        self.assertEqual(text.date_similarity(datetime.date(2026, 4, 3), datetime.date(2026, 3, 4)), 0.7)

    def test_config_endpoint_validates_and_is_audited(self):
        c = self.client_for(self.admin)
        bad = c.patch('/api/duplicates/config/', {'weights': {'mother': 50}}, format='json')
        self.assertEqual(bad.status_code, 400)
        cfg = default_config()
        cfg['thresholds'] = {'high': 90, 'medium': 70}
        ok = c.patch('/api/duplicates/config/', cfg, format='json')
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(c.get('/api/duplicates/config/').data['config']['thresholds']['high'], 90)
        self.assertEqual(self.client_for(self.secretary).patch('/api/duplicates/config/', cfg, format='json')
                         .status_code, 403)
        self.assertTrue(AuditLog.objects.filter(object_id='duplicates.config').exists())


# ── 7-8 : offline synchronisation (the ``sync`` app; duplicate control hooked on it) ──

DEVICE_B = '0b9c2a64-2b1c-4a38-8c3f-6a1f0d9e7c11'


class SyncTests(SyncTestCase, DuplicateBase):
    def test_7_two_agents_record_the_same_child_offline(self):
        data = self.payload()
        _, ra = self.pushed(self.agent, payload=data)
        op = self.create_op(payload=dict(data))
        r = self.push(self.agent2, [op], device=DEVICE_B)
        self.assertEqual(r.status_code, 200, r.content)
        rb = r.data['results'][0]
        self.assertEqual((ra['status'], rb['status']), ('applied', 'applied'))     # nothing refused, nothing lost
        self.assertFalse(ra.get('duplicate_cases'))
        self.assertEqual(len(rb['duplicate_cases']), 1)
        self.assertEqual(Declaration.objects.count(), 2)
        case = DuplicateCase.objects.get()
        self.assertEqual(case.anomaly_type, 'SYNC_CONFLICT')
        self.assertEqual(case.match.analysis.trigger, 'SYNC')
        da = Declaration.objects.get(uuid=ra['entity_uuid'])
        self.assertIsNotNone(da.device_created_at)
        # the answer carries the dossier with its alert; neither dossier can get an official number yet
        self.assertTrue(rb['declaration']['duplicate_alert']['blocked'])
        for uuid_, number in ((ra['entity_uuid'], '700'), (rb['entity_uuid'], '701')):
            self.to_pending(uuid_)
            res = self.validate(self.admin, uuid_, number)
            self.assertEqual(res.status_code, 400)
            self.assertEqual(res.data['code'], 'duplicate_block')
        self.assertFalse(Acte.objects.exclude(numero_acte=None).exists())

    def test_8_replayed_or_repeated_synchronisations_open_no_second_case(self):
        data = self.payload()
        self.pushed(self.agent, payload=data)
        op = self.create_op(payload=dict(data))
        first = self.push(self.agent2, [op], device=DEVICE_B).data['results'][0]
        again = self.push(self.agent2, [op], device=DEVICE_B).data['results'][0]      # same operation re-sent
        self.assertEqual(again['status'], 'duplicate')
        self.assertEqual(Declaration.objects.count(), 2)
        self.assertEqual(DuplicateCase.objects.count(), 1)
        # the answer was lost and the device retries under a NEW operation id with the same dossier uuid
        retry = self.create_op(payload=dict(data), entity=first['entity_uuid'])
        third = self.push(self.agent2, [retry], device=DEVICE_B).data['results'][0]
        self.assertEqual(third['entity_uuid'], first['entity_uuid'])
        self.assertEqual(Declaration.objects.count(), 2)
        self.assertEqual(DuplicateCase.objects.count(), 1)

    def test_offline_edit_that_makes_two_dossiers_alike_is_detected(self):
        _, ra = self.pushed(self.agent, payload=self.payload())
        other = self.create_op(payload=self.payload(mother=('Kadiatou', 'Soumah'), child=('Ibrahima', 'Sylla'),
                                                    time='15:20', hospital_ref='H-300'))
        rb = self.push(self.agent2, [other], device=DEVICE_B).data['results'][0]
        self.assertEqual(DuplicateCase.objects.count(), 0)
        edit = self.op('update', entity=rb['entity_uuid'], base_version=Declaration.objects.get(uuid=rb['entity_uuid']).sync_version,
                       payload={'mother': {'first_names': 'Fatoumata', 'last_name': 'Bah'},
                                'child': {'first_names': 'Aminata', 'last_name': 'Diallo', 'gender': 'F'},
                                'birth_time': '08:30', 'hospital_document_ref': 'H-100'})
        r = self.push(self.agent2, [edit], device=DEVICE_B)
        self.assertEqual(r.data['results'][0]['status'], 'applied', r.content)
        self.assertEqual(DuplicateCase.objects.count(), 1)


# ── 9-12 : validation guard and decisions ────────

class ValidationGuardTests(DuplicateBase):
    def test_9_two_validations_cannot_produce_two_acts_for_the_same_birth(self):
        a, b = self.mk(self.agent), self.mk(self.agent2)
        for d in (a, b):
            self.to_pending(d['uuid'])
        r1 = self.validate(self.admin, a['uuid'], '801')
        r2 = self.validate(self.admin, b['uuid'], '802')
        self.assertEqual((r1.status_code, r2.status_code), (400, 400))
        self.assertFalse(Acte.objects.exclude(numero_acte=None).exists())
        # after the decision only the principal dossier can be validated
        case = self.case_for(a['uuid'], b['uuid'])
        r = self.decide(self.admin, case, 'CONFIRMED_DUPLICATE', 'Même enfant saisi deux fois',
                        duplicate_declaration=b['uuid'])
        self.assertEqual(r.status_code, 200, r.content)
        from duplicates.services import detection
        with mock.patch('duplicates.services.detection.acquire_lock', wraps=detection.acquire_lock) as lock:
            self.assertEqual(self.validate(self.admin, a['uuid'], '801').status_code, 200)
        # the validation takes the numbering lock shared by every validation (serialises simultaneous ones)
        self.assertIn('official-numbering', [c.args[0] for c in lock.call_args_list])
        blocked = self.validate(self.admin, b['uuid'], '802')
        self.assertEqual(blocked.status_code, 400)
        self.assertEqual(blocked.data['code'], 'duplicate_block')
        self.assertEqual(Acte.objects.exclude(numero_acte=None).count(), 1)

    def test_10_declaration_similar_to_an_existing_official_act(self):
        a = self.mk(self.agent)
        self.to_pending(a['uuid'])
        self.assertEqual(self.validate(self.admin, a['uuid'], '901').status_code, 200)
        b = self.mk(self.agent2)
        case = self.case_for(a['uuid'], b['uuid'])
        self.assertIsNotNone(case)
        self.assertEqual(case.anomaly_type, 'ACTE_EXISTS')
        self.to_pending(b['uuid'])
        self.assertEqual(self.validate(self.admin, b['uuid'], '902').status_code, 400)
        self.assertEqual(Acte.objects.exclude(numero_acte=None).count(), 1)
        # the act already established is untouched, whatever the decision
        acte = Acte.objects.get(numero_acte='901')
        r = self.decide(self.admin, case, 'CONFIRMED_DUPLICATE', 'Doublon de la déclaration déjà validée',
                        duplicate_declaration=b['uuid'])
        self.assertEqual(r.status_code, 200)
        acte.refresh_from_db()
        self.assertEqual(acte.numero_acte, '901')
        self.assertEqual(Declaration.objects.get(uuid=a['uuid']).status, 'VALIDATED')

    def test_11_correction_after_a_first_analysis(self):
        a = self.mk(self.agent, mother=('Fatoumata', 'Bah'))
        b = self.mk(self.agent2, mother=('Kadiatou', 'Soumah'), child=('Ibrahima', 'Sylla'), time='15:20',
                    hospital_ref='H-300')
        self.assertIsNone(self.case_for(a['uuid'], b['uuid']))
        checks_before = DuplicateCheck.objects.filter(declaration__uuid=b['uuid']).count()
        # the agent "corrects" b into a lookalike: the analysis is re-run and a case opens
        r = self.client_for(self.agent2).patch(f"/api/declarations/{b['uuid']}/", {
            'mother': {'first_names': 'Fatoumata', 'last_name': 'Bah'},
            'child': {'first_names': 'Aminata', 'last_name': 'Diallo', 'gender': 'F'},
            'hospital_document_ref': 'H-100'}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertGreater(DuplicateCheck.objects.filter(declaration__uuid=b['uuid']).count(), checks_before)
        case = self.case_for(a['uuid'], b['uuid'])
        self.assertIsNotNone(case)
        # corrected back: the score falls but the case stays open until a human rules (no silent unblocking)
        self.client_for(self.agent2).patch(f"/api/declarations/{b['uuid']}/", {
            'mother': {'first_names': 'Kadiatou', 'last_name': 'Soumah'},
            'child': {'first_names': 'Ibrahima', 'last_name': 'Sylla'}, 'hospital_document_ref': 'H-777'},
            format='json')
        case.refresh_from_db()
        self.assertNotEqual(case.status, CaseStatus.RESOLVED)
        self.assertLess(case.score, 60)
        self.assertEqual(case.risk_level, 'HIGH')        # peak level kept: the block stays
        actions = set(case.history.values_list('action', flat=True))
        self.assertTrue({'CASE_OPENED', 'DATA_CHANGED', 'ANALYSIS_UPDATED'} <= actions, actions)

    def test_12_confirmed_duplicate_is_linked_not_deleted_and_fully_traced(self):
        a, b = self.mk(self.agent), self.mk(self.agent2)
        case = self.case_for(a['uuid'], b['uuid'])
        admin = self.client_for(self.admin)
        # a reason is mandatory
        r = admin.post(f'/api/duplicates/cases/{case.uuid}/decide/',
                       {'decision': 'CONFIRMED_DUPLICATE', 'reason': '', 'duplicate_declaration': b['uuid']},
                       format='json')
        self.assertEqual(r.status_code, 400)
        # the redundant dossier must be designated
        r = admin.post(f'/api/duplicates/cases/{case.uuid}/decide/',
                       {'decision': 'CONFIRMED_DUPLICATE', 'reason': 'ok'}, format='json')
        self.assertEqual(r.status_code, 400)
        r = self.decide(self.admin, case, 'CONFIRMED_DUPLICATE', 'Pièces identiques', duplicate_declaration=b['uuid'])
        self.assertEqual(r.status_code, 200, r.content)
        case.refresh_from_db()
        self.assertEqual(case.status, CaseStatus.RESOLVED)
        self.assertEqual(case.duplicate_declaration.uuid, uuid_lib.UUID(b['uuid']))
        self.assertEqual(case.principal_declaration.uuid, uuid_lib.UUID(a['uuid']))
        self.assertEqual(Declaration.objects.count(), 2)                   # nothing deleted or merged
        self.assertEqual(Declaration.objects.get(uuid=b['uuid']).status, 'DRAFT')   # no automatic legal change
        row = case.decisions.get()
        self.assertEqual((row.decided_by, row.reason), (self.admin, 'Pièces identiques'))
        self.assertIsNotNone(row.decided_at)
        # no second decision on a resolved case
        self.assertEqual(self.decide(self.admin, case, 'DISTINCT_CHILDREN').status_code, 400)
        # append-only: decisions and history cannot be modified or deleted
        row.reason = 'changé'
        with self.assertRaises(HardDeleteForbidden):
            row.save()
        with self.assertRaises(HardDeleteForbidden):
            row.delete()
        with self.assertRaises(HardDeleteForbidden):
            DuplicateReviewHistory.objects.all().update(note='x')
        self.assertTrue(AuditLog.objects.filter(action='duplicate_decision', object_id=str(case.uuid)).exists())
        # reopening is possible (motive required) and keeps the previous decision
        r = admin.post(f'/api/duplicates/cases/{case.uuid}/reopen/', {'reason': 'Nouvelle pièce'}, format='json')
        self.assertEqual(r.status_code, 200)
        case.refresh_from_db()
        self.assertEqual((case.status, case.decisions.count()), (CaseStatus.IN_REVIEW, 1))

    def test_distinct_children_decision_releases_both(self):
        a, b = self.mk(self.agent), self.mk(self.agent2)
        case = self.case_for(a['uuid'], b['uuid'])
        self.assertEqual(self.decide(self.admin, case, 'DISTINCT_CHILDREN', 'Actes de naissance des parents').status_code, 200)
        for d, n in ((a, '1001'), (b, '1002')):
            self.to_pending(d['uuid'])
            self.assertEqual(self.validate(self.admin, d['uuid'], n).status_code, 200)
        # a later re-analysis of exactly the same data does not reopen the question
        self.client_for(self.admin).post('/api/duplicates/analyze/', {'declaration': b['uuid']}, format='json')
        self.assertEqual(DuplicateCase.objects.exclude(status=CaseStatus.RESOLVED).count(), 0)

    def test_non_final_decisions_keep_the_dossier_blocked(self):
        a, b = self.mk(self.agent), self.mk(self.agent2)
        case = self.case_for(a['uuid'], b['uuid'])
        for decision in ('INSUFFICIENT_INFO', 'FURTHER_VERIFICATION'):
            self.assertEqual(self.decide(self.admin, case, decision, 'À compléter').status_code, 200)
            case.refresh_from_db()
            self.assertEqual(case.status, CaseStatus.AWAITING_INFO)
        self.to_pending(a['uuid'])
        self.assertEqual(self.validate(self.admin, a['uuid'], '1101').status_code, 400)
        self.assertEqual(case.decisions.count(), 2)                       # successive decisions kept

    def test_blocking_levels_are_configurable_and_low_risk_never_blocks(self):
        a = self.mk(self.agent, mother=('Fatoumata', 'Bah'), child=('Aminata', 'Diallo'))
        b = self.mk(self.agent2, mother=('Kadiatou', 'Soumah'), child=('Ibrahima', 'Sylla'), time='19:00')
        self.assertEqual(self.validate_ok(a['uuid'], '1201'), 200)
        self.assertEqual(self.validate_ok(b['uuid'], '1202'), 200)
        self.assertEqual(Acte.objects.exclude(numero_acte=None).count(), 2)

    def validate_ok(self, uuid, number):
        self.to_pending(uuid)
        return self.validate(self.admin, uuid, number).status_code


# ── permissions, traceability, API ───────────────

class PermissionAndApiTests(DuplicateBase):
    def setUp(self):
        super().setUp()
        self.a, self.b = self.mk(self.agent), self.mk(self.agent2)
        self.case = self.case_for(self.a['uuid'], self.b['uuid'])
        self.base = f'/api/duplicates/cases/{self.case.uuid}'

    def test_access_is_reserved_to_authorised_users(self):
        for user in (self.agent, self.nobody):
            c = self.client_for(user)
            self.assertEqual(c.get('/api/duplicates/cases/').status_code, 403)
            self.assertEqual(c.get(f'{self.base}/').status_code, 403)
            self.assertEqual(c.get(f'{self.base}/compare/').status_code, 403)
            self.assertEqual(c.get('/api/duplicates/matches/').status_code, 403)
            self.assertEqual(c.post('/api/duplicates/analyze/', {'declaration': self.a['uuid']}, format='json').status_code, 403)
        self.assertEqual(self.client.get('/api/duplicates/cases/').status_code, 401)

    def test_consult_investigate_and_decide_are_distinct_permissions(self):
        sec = self.client_for(self.secretary)
        self.assertEqual(sec.get(f'{self.base}/').status_code, 200)
        self.assertEqual(sec.post(f'{self.base}/take/').status_code, 200)
        self.assertEqual(sec.post(f'{self.base}/note/', {'content': 'Registre papier vérifié'}, format='json').status_code, 201)
        self.assertEqual(sec.post(f'{self.base}/request-verification/', {'content': 'Appeler la maternité'},
                                  format='json').status_code, 201)
        r = sec.post(f'{self.base}/decide/', {'decision': 'DISTINCT_CHILDREN', 'reason': 'x'}, format='json')
        self.assertEqual(r.status_code, 403)
        self.assertEqual(sec.post(f'{self.base}/reopen/', {'reason': 'x'}, format='json').status_code, 403)
        self.assertEqual(self.client_for(self.admin).post(f'{self.base}/take/').status_code, 200)

    def test_list_filters_summary_and_search(self):
        admin = self.client_for(self.admin)
        r = admin.get('/api/duplicates/cases/', {'risk_level': 'HIGH', 'state': 'unresolved'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data['count'], 1)
        row = r.data['results'][0]
        for key in ('reference', 'score', 'risk_level', 'status', 'detected_at', 'declaration', 'other_declaration'):
            self.assertIn(key, row)
        self.assertIn('mother_name', row['declaration'])
        self.assertEqual(admin.get('/api/duplicates/cases/', {'search': 'Bah'}).data['count'], 1)
        self.assertEqual(admin.get('/api/duplicates/cases/', {'risk_level': 'LOW'}).data['count'], 0)
        agent_uuid = str(self.agent.uuid)
        self.assertEqual(admin.get('/api/duplicates/cases/', {'agent': agent_uuid}).data['count'], 1)
        s = admin.get('/api/duplicates/cases/summary/').data
        self.assertEqual((s['total'], s['high'], s['awaiting_decision'], s['resolved']), (1, 1, 1, 0))
        opts = admin.get('/api/duplicates/cases/filter-options/').data
        self.assertEqual(len(opts['agents']), 2)

    def test_comparison_highlights_matches_and_is_traced(self):
        sec = self.client_for(self.secretary)
        r = sec.get(f'{self.base}/compare/')
        self.assertEqual(r.status_code, 200)
        statuses = {row['label']: row['status'] for s in r.data['sections'] if s['key'] == 'mother' for row in s['rows']}
        self.assertEqual(statuses['Nom'], 'same')
        self.assertIn('score', r.data)
        self.assertTrue(r.data['documents_visible'])
        self.assertTrue(DuplicateReviewHistory.objects.filter(case=self.case, action='COMPARISON_VIEWED').exists())
        self.assertTrue(AuditLog.objects.filter(action='duplicate_viewed', object_id=str(self.case.uuid)).exists())
        # free comparison of any two declarations
        r = sec.get('/api/duplicates/compare/', {'a': self.a['uuid'], 'b': self.b['uuid']})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(sec.get('/api/duplicates/compare/', {'a': self.a['uuid'], 'b': self.a['uuid']}).status_code, 400)

    def test_manual_analysis_and_alerts_list(self):
        c = self.client_for(self.secretary)
        r = c.post('/api/duplicates/analyze/', {'declaration': self.a['uuid']}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertGreaterEqual(r.data['check']['matches_found'], 1)
        self.assertTrue(DuplicateCheck.objects.filter(trigger='MANUAL').exists())
        alerts = c.get('/api/duplicates/matches/', {'min_score': 60})
        self.assertEqual(alerts.status_code, 200)
        self.assertEqual(alerts.data['count'], 1)
        self.assertEqual(DuplicateMatch.objects.count(), 1)        # one row per pair, not per direction

    def test_history_is_complete_and_ordered(self):
        sec = self.client_for(self.secretary)
        sec.post(f'{self.base}/take/')
        sec.post(f'{self.base}/note/', {'content': 'Observation'}, format='json')
        self.client_for(self.admin).post(f'{self.base}/decide/', {
            'decision': 'DISTINCT_CHILDREN', 'reason': 'Parents différents'}, format='json')
        h = sec.get(f'{self.base}/history/').data
        self.assertEqual([x['action'] for x in h], ['CASE_OPENED', 'TAKEN', 'OBSERVATION', 'DECISION'])
        self.assertEqual(h[0]['actor_name'], 'Système')
        detail = sec.get(f'{self.base}/').data
        self.assertEqual(len(detail['decisions']), 1)
        self.assertEqual(len(detail['evidence']), 1)
        self.assertFalse(detail['permissions']['decide'])

    def test_declaration_detail_exposes_the_duplicate_alert_to_those_who_see_it(self):
        r = self.client_for(self.agent).get(f"/api/declarations/{self.a['uuid']}/")
        self.assertEqual(r.status_code, 200, r.content)
        alert = r.data['duplicate_alert']
        self.assertTrue(alert['blocked'])
        self.assertEqual(alert['open_cases'][0]['risk_level'], 'HIGH')
        # the agent sees that the dossier is held, but not the case itself (no case uuid, no other dossier)
        self.assertNotIn('uuid', alert['open_cases'][0])
        self.transition(self.agent, self.a['uuid'], 'TRANSMITTED')       # drafts are visible to their author only
        sec = self.client_for(self.secretary).get(f"/api/declarations/{self.a['uuid']}/")
        self.assertIn('uuid', sec.data['duplicate_alert']['open_cases'][0])

    def test_one_unresolved_case_per_pair_is_enforced_by_the_database(self):
        dup = DuplicateCase(reference='DUP-X', pair_key=self.case.pair_key, match=self.case.match,
                            declaration=self.case.declaration, other_declaration=self.case.other_declaration,
                            risk_level='HIGH', anomaly_type='SIMILAR_IDENTITY')
        with self.assertRaises(IntegrityError):
            dup.save()

    def test_inbox_badge_for_the_control_centre(self):
        r = self.client_for(self.admin).get('/api/inbox/')
        self.assertEqual(r.data['badges'].get('/duplicates'), 1)
        self.assertNotIn('/duplicates', self.client_for(self.agent).get('/api/inbox/').data['badges'])
