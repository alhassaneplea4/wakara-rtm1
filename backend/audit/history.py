"""
« Historiques des actes » — traceability of the dossiers, for the technical administrator.

Everything that touches a dossier is written in the append-only audit log, but spread over three kinds of objects:
the declaration, its acte (number, printing, delivery) and its supporting documents. This module gathers them per
dossier and writes each event as a plain French sentence: WHO did WHAT, WHEN, with the before/after of every field
that was changed. Read-only; reserved to ``audit.view`` (administrator).
"""
import re
from collections import defaultdict

from django.core.exceptions import ValidationError
from django.db.models import Count, Max, Q
from django.utils import timezone
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound
from rest_framework.response import Response

from accounts.models import UserRole
from actes.models import Acte
from core.pagination import StandardPagination
from core.permissions import HasWakaraPermission
from core.workflow import Status
from declarations.models import Declaration
from declarations.services import FIELD_LABELS
from documents.models import SupportingDocument

from .models import AuditAction as A
from .models import AuditLog

TYPES = ('Declaration', 'Acte', 'SupportingDocument')
STATUS_LABELS = dict(Status.CHOICES)

# Filter « type d'action » → what it keeps in the log
KIND_FILTERS = {
    'creation': Q(action=A.CREATE),
    'modification': Q(action=A.UPDATE),
    'circuit': Q(action__in=[A.TRANSMIT, A.TRANSITION, A.RETURN, A.REJECT, A.VALIDATE]),
    'numero': Q(action=A.NUMBER_ASSIGNED),
    'impression': Q(action=A.PRINT),
    'delivrance': Q(action=A.DELIVER),
    'piece': Q(object_type='SupportingDocument'),
    'archivage': Q(action__in=[A.ARCHIVE, A.RESTORE]) & ~Q(object_type='SupportingDocument'),
}
KIND_LABELS = {
    'creation': 'Création', 'modification': 'Modifications', 'circuit': 'Circuit du dossier', 'numero': 'Numérotation',
    'impression': 'Impressions', 'delivrance': 'Délivrances', 'piece': 'Pièces jointes', 'archivage': 'Archivage',
}

# ── Words ────────────────────────────────────────────────────────────────

GROUPS = {'child': 'Enfant', 'mother': 'Mère', 'father': 'Père', 'declarant': 'Déclarant'}
FIELDS = {
    'first_names': 'Prénoms', 'last_name': 'Nom', 'gender': 'Sexe', 'nationality': 'Nationalité', 'npi': 'NPI',
    'birth_rank': 'Rang de naissance', 'age': 'Âge', 'profession': 'Profession', 'address': 'Domicile',
    'phone': 'Téléphone', 'date_of_birth': 'Date de naissance', 'birth_place': 'Lieu de naissance',
    'id_type': 'Type de pièce', 'id_number': 'N° de pièce', 'relationship': "Lien avec l'enfant",
}
TOP_FIELDS = {
    'hospital': 'Établissement', 'hospital_document_ref': 'Réf. hospitalière', 'doctor_name': 'Médecin',
    'midwife_name': 'Sage-femme', 'birth_date': "Date de naissance de l'enfant", 'birth_time': "Heure de naissance",
    'birth_place': "Lieu de naissance de l'enfant", 'notes': 'Observations',
    # acte
    'annee': 'Année', 'registre': 'Registre', 'feuillet': 'Feuillet', 'region': 'Région', 'prefecture': 'Préfecture',
    'commune': 'Commune', 'centre': 'Centre', 'declaration_date': 'Date de déclaration',
    'officer_name': "Officier d'état civil", 'mentions': 'Mentions',
}
DATE_RE = re.compile(r'^(\d{4})-(\d{2})-(\d{2})$')


def field_label(key):
    if '.' in key:
        group, name = key.split('.', 1)
        return f"{GROUPS.get(group, group)} · {FIELDS.get(name, name)}"
    return TOP_FIELDS.get(key) or FIELDS.get(key, key)


def fmt(value, key=''):
    """A value as the administrator reads it."""
    if value in (None, '', []):
        return '—'
    if value is True:
        return 'Oui'
    if value is False:
        return 'Non'
    text = str(value)
    if key.endswith('gender'):
        return {'M': 'Masculin', 'F': 'Féminin'}.get(text, text)
    if key == 'status':
        return STATUS_LABELS.get(text, text)
    m = DATE_RE.match(text)
    return f"{m.group(3)}/{m.group(2)}/{m.group(1)}" if m else text


def person_name(user):
    return (user.get_full_name() or user.username) if user else ''


def _changed_fields(changes):
    rows = []
    for key, val in (changes or {}).items():
        if isinstance(val, dict) and 'from' in val and 'to' in val:
            rows.append({'label': field_label(key), 'from': fmt(val['from'], key), 'to': fmt(val['to'], key)})
    return rows


def describe(entry, doc_names):
    """One audit entry → ``(kind, icon, tone, title, milestone, details)`` in plain French."""
    a, t, ch = entry.action, entry.object_type, entry.changes or {}
    if t == 'SupportingDocument':
        name = ch.get('name') or doc_names.get(entry.object_id, 'une pièce')
        if a == A.DOCUMENT_UPLOADED:
            sha = str(ch.get('sha256', ''))
            details = [{'label': 'Fichier', 'value': name}] + ([{'label': 'Empreinte SHA-256', 'value': sha[:16] + '…'}] if sha else [])
            return 'piece', 'upload', 'info', f"Pièce ajoutée : {name}", '', details
        if a == A.DOCUMENT_DOWNLOADED:
            return 'piece', 'eye', 'info', f"Pièce consultée : {name}", '', []
        if a == A.ARCHIVE:
            return 'piece', 'x', 'warning', f"Pièce archivée : {name}", '', []
        return 'piece', 'file', 'info', f"Pièce jointe ({a})", '', []

    where = 'Déclaration' if t == 'Declaration' else 'Acte'
    if a == A.CREATE:
        if t == 'Acte':
            return 'creation', 'paper', 'info', "Dossier d'acte ouvert", 'acte_opened', []
        return 'creation', 'file', 'info', 'Déclaration créée', 'created', []
    if a == A.UPDATE:
        rows = _changed_fields(ch)
        n = len(rows)
        subject, verb = ("Informations de la déclaration", 'modifiées') if t == 'Declaration' else ('Acte', 'modifié')
        return 'modification', 'edit', 'warning', f"{subject} {verb} ({n} champ{'s' if n > 1 else ''})", '', rows
    if a == A.TRANSMIT:
        return 'circuit', 'arrow', 'info', 'Transmise au secrétariat', 'transmitted', []
    if a == A.RETURN:
        to = (ch.get('status') or {}).get('to')
        text = ('Renvoyée à la collecte pour correction' if to == Status.TO_CORRECT_COLLECTION
                else 'Renvoyée au secrétariat pour correction')
        return 'circuit', 'history', 'warning', text, 'returned', []
    if a == A.REJECT:
        return 'circuit', 'x', 'danger', 'Dossier rejeté', 'rejected', []
    if a == A.VALIDATE:
        missing = ch.get('incomplete_fields') or []
        details = [{'label': 'Champs non renseignés', 'value': ', '.join(FIELD_LABELS.get(m, m) for m in missing)}] if missing else []
        title = 'Validée définitivement' + (' malgré des champs non renseignés' if missing else '')
        return 'circuit', 'check', 'success', title, 'validated', details
    if a == A.TRANSITION:
        to = (ch.get('status') or {}).get('to')
        if to == Status.IN_COMPLETION:
            return 'circuit', 'paper', 'info', 'Prise en charge par le secrétariat', 'in_completion', []
        if to == Status.PENDING_VALIDATION:
            return 'circuit', 'shield', 'warning', 'Envoyée à la validation', 'pending_validation', []
        return 'circuit', 'arrow', 'info', f"Statut : {STATUS_LABELS.get(to, to)}", '', []
    if a == A.NUMBER_ASSIGNED:
        details = [{'label': label, 'value': fmt(ch.get(key))} for key, label in (('numero_acte', 'N° officiel'), ('annee', 'Année'), ('registre', 'Registre'))]
        return 'numero', 'certificate', 'success', f"Numéro officiel attribué : {ch.get('numero_acte', '—')}", 'number', details
    if a == A.PRINT:
        return 'impression', 'print', 'info', f"Exemplaire n° {ch.get('copy_number', '?')} imprimé", 'printed', []
    if a == A.DELIVER:
        dup = bool(ch.get('duplicate'))
        title = f"Acte remis à {ch.get('recipient', '—')}" + (' (duplicata)' if dup else '')
        return 'delivrance', 'download', 'success', title, 'delivered', [{'label': 'Remis à', 'value': fmt(ch.get('recipient'))}, {'label': 'Type', 'value': 'Duplicata' if dup else 'Première délivrance'}]
    if a == A.ARCHIVE:
        return 'archivage', 'x', 'warning', f"{where} archivée" if t == 'Declaration' else 'Acte archivé', '', []
    if a == A.RESTORE:
        return 'archivage', 'history', 'info', f"{where} restaurée" if t == 'Declaration' else 'Acte restauré', '', []
    return 'creation', 'history', 'info', f"{a} ({where})", '', []


# ── Gathering ────────────────────────────────────────────────────────────

def _owner_maps():
    """object uuid → declaration uuid, for the actes and the supporting documents."""
    actes = {str(a): str(d) for a, d in Acte.all_objects.values_list('uuid', 'declaration__uuid')}
    docs = {str(u): str(d) for u, d in SupportingDocument.all_objects.values_list('uuid', 'declaration__uuid')}
    return actes, docs


def _declaration_of(object_type, object_id, actes, docs):
    if object_type == 'Declaration':
        return object_id
    return (actes if object_type == 'Acte' else docs).get(object_id)


def _activity(qs, actes, docs):
    """Declaration uuid → {'last': datetime, 'n': events} for the audit entries of ``qs``."""
    out = {}
    for r in qs.filter(object_type__in=TYPES).values('object_type', 'object_id').annotate(last=Max('created_at'), n=Count('id')):
        decl = _declaration_of(r['object_type'], r['object_id'], actes, docs)
        if not decl:
            continue
        e = out.setdefault(decl, {'last': r['last'], 'n': 0})
        e['n'] += r['n']
        e['last'] = max(e['last'], r['last'])
    return out


def _roles(user_ids):
    out = defaultdict(list)
    rows = UserRole.objects.filter(user_id__in=user_ids, is_active=True, role__is_active=True).select_related('role')
    for r in rows:
        out[r.user_id].append(r.role.name)
    return out


def _search_q(term):
    q = Q()
    for word in term.split()[:6]:           # every word must be found somewhere in the dossier
        q &= (Q(reference__icontains=word) | Q(hospital_document_ref__icontains=word)
              | Q(child__first_names__icontains=word) | Q(child__last_name__icontains=word) | Q(child__npi__icontains=word)
              | Q(acte__numero_acte__icontains=word) | Q(hospital__name__icontains=word)
              | Q(parents__first_names__icontains=word) | Q(parents__last_name__icontains=word)
              | Q(declarant__first_names__icontains=word) | Q(declarant__last_name__icontains=word)
              | Q(created_by__username__icontains=word) | Q(created_by__first_name__icontains=word)
              | Q(created_by__last_name__icontains=word) | Q(acte__deliveries__recipient_name__icontains=word))
    return q


def _child_name(d):
    child = getattr(d, 'child', None)
    return str(child) if child else ''


class DossierHistoryViewSet(viewsets.ViewSet):
    """GET /api/history/ (dossiers and their activity), /api/history/{uuid}/ (full story), /api/history/summary/."""
    permission_classes = [HasWakaraPermission]
    permission_map = {'list': 'audit.view', 'retrieve': 'audit.view', 'summary': 'audit.view'}

    # ── list ─────────────────────────────────────────────
    def list(self, request):
        p = request.query_params
        actes, docs = _owner_maps()
        everything = _activity(AuditLog.objects.all(), actes, docs)

        qs = Declaration.all_objects.select_related('child', 'hospital', 'created_by', 'acte')
        if p.get('q', '').strip():
            qs = qs.filter(_search_q(p['q'].strip()))
        if p.get('status'):
            qs = qs.filter(status__in=p['status'].split(','))
        if p.get('hospital'):
            qs = qs.filter(hospital__uuid=p['hospital'])

        # "who / what kind of action / when": keep the dossiers where such an event happened
        scope = AuditLog.objects.all()
        if p.get('user'):
            scope = scope.filter(user__uuid=p['user'])
        if p.get('kind') in KIND_FILTERS:
            scope = scope.filter(KIND_FILTERS[p['kind']])
        if p.get('from'):
            scope = scope.filter(created_at__date__gte=p['from'])
        if p.get('to'):
            scope = scope.filter(created_at__date__lte=p['to'])
        if scope.query.where:
            qs = qs.filter(uuid__in=list(_activity(scope, actes, docs)))

        rows = []
        for d in qs.distinct():
            act = everything.get(str(d.uuid))
            rows.append((act['last'] if act else d.created_at, d, act['n'] if act else 0))
        rows.sort(key=lambda r: r[0], reverse=True)

        pager = StandardPagination()
        page = pager.paginate_queryset(rows, request, view=self)
        latest = self._latest_events([r[1] for r in page], actes, docs)
        data = []
        for last, d, n in page:
            ev = latest.get(str(d.uuid))
            data.append({
                'uuid': str(d.uuid), 'reference': d.reference, 'child_name': _child_name(d), 'status': d.status,
                'status_label': d.get_status_display(), 'hospital_name': d.hospital.name if d.hospital else '',
                'official_number': d.acte.numero_acte if getattr(d, 'acte', None) else None,
                'created_by_name': person_name(d.created_by), 'created_at': d.created_at, 'is_archived': d.is_archived,
                'last_event_at': last, 'event_count': n,
                'last_actor': (ev['who'] if ev else ''), 'last_action': (ev['title'] if ev else ''),
            })
        return pager.get_paginated_response(data)

    def _latest_events(self, declarations, actes, docs):
        """The most recent event of each dossier of the page (who and what), in one query."""
        if not declarations:
            return {}
        by_decl = {str(d.uuid): d for d in declarations}
        ids = set(by_decl)
        ids |= {a for a, dd in actes.items() if dd in by_decl}
        ids |= {u for u, dd in docs.items() if dd in by_decl}
        entries = (AuditLog.objects.filter(object_type__in=TYPES, object_id__in=ids).select_related('user')
                   .order_by('-created_at', '-id'))
        doc_names = dict(SupportingDocument.all_objects.filter(declaration__in=declarations).values_list('uuid', 'original_name'))
        doc_names = {str(k): v for k, v in doc_names.items()}
        out = {}
        for e in entries:
            decl = _declaration_of(e.object_type, e.object_id, actes, docs)
            if decl in out or decl not in by_decl:
                continue
            out[decl] = {'who': e.user and person_name(e.user) or e.username or 'Système', 'title': describe(e, doc_names)[3]}
        return out

    # ── one dossier ──────────────────────────────────────
    def retrieve(self, request, pk=None):
        try:
            d = Declaration.all_objects.select_related('child', 'hospital', 'created_by', 'validated_by', 'acte').get(uuid=pk)
        except (Declaration.DoesNotExist, ValueError, ValidationError) as exc:   # unknown or malformed uuid
            raise NotFound("Dossier introuvable.") from exc
        acte = getattr(d, 'acte', None)
        documents = {str(u): name for u, name in SupportingDocument.all_objects.filter(declaration=d).values_list('uuid', 'original_name')}

        q = Q(object_type='Declaration', object_id=str(d.uuid))
        if acte:
            q |= Q(object_type='Acte', object_id=str(acte.uuid))
        if documents:
            q |= Q(object_type='SupportingDocument', object_id__in=list(documents))
        entries = list(AuditLog.objects.filter(q).select_related('user').order_by('created_at', 'id'))
        roles = _roles({e.user_id for e in entries if e.user_id})

        events, people = [], {}
        for e in entries:
            kind, icon, tone, title, milestone, details = describe(e, documents)
            who = person_name(e.user) or e.username or 'Système'
            events.append({
                'id': e.id, 'at': e.created_at, 'kind': kind, 'icon': icon, 'tone': tone, 'title': title,
                'milestone': milestone, 'who': who, 'username': e.username, 'roles': roles.get(e.user_id, []),
                'details': details, 'reason': e.reason, 'ip': e.ip_address,
                'object': {'Declaration': 'Déclaration', 'Acte': 'Acte', 'SupportingDocument': 'Pièce jointe'}[e.object_type],
            })
            who_key = e.user_id or who
            person = people.setdefault(who_key, {
                'name': who, 'username': e.username, 'roles': roles.get(e.user_id, []), 'count': 0,
                'first_at': e.created_at, 'last_at': e.created_at, 'kinds': defaultdict(int)})
            person['count'] += 1
            person['last_at'] = e.created_at
            person['kinds'][kind] += 1
        people_list = sorted(people.values(), key=lambda x: x['first_at'])
        for person in people_list:
            person['kinds'] = [{'kind': k, 'label': KIND_LABELS[k], 'count': n} for k, n in person['kinds'].items()]

        counts = defaultdict(int)
        for ev in events:
            counts[ev['kind']] += 1
        return Response({
            'dossier': {
                'uuid': str(d.uuid), 'reference': d.reference, 'child_name': _child_name(d), 'status': d.status,
                'status_label': d.get_status_display(), 'hospital_name': d.hospital.name if d.hospital else '',
                'birth_date': d.birth_date, 'official_number': acte.numero_acte if acte else None,
                'annee': acte.annee if acte else None, 'registre': acte.registre if acte else '',
                'acte_uuid': str(acte.uuid) if acte else None, 'is_archived': d.is_archived,
                'created_by_name': person_name(d.created_by), 'created_at': d.created_at,
                'validated_by_name': person_name(d.validated_by), 'validated_at': d.validated_at,
            },
            'events': events,
            'people': people_list,
            'kinds': [{'kind': k, 'label': KIND_LABELS[k], 'count': counts[k]} for k in KIND_LABELS if counts[k]],
        })

    # ── counters ─────────────────────────────────────────
    @action(detail=False, methods=['get'], url_path='summary')
    def summary(self, request):
        """What happened today across all dossiers."""
        today = timezone.localdate()
        actes, docs = _owner_maps()
        todays = AuditLog.objects.filter(object_type__in=TYPES, created_at__date=today)
        return Response({
            'events_today': todays.count(),
            'dossiers_today': len(_activity(todays, actes, docs)),
            'users_today': todays.exclude(user__isnull=True).values('user').distinct().count(),
            'changes_today': todays.filter(action=A.UPDATE).count(),
            'deliveries_today': todays.filter(action=A.DELIVER).count(),
        })
