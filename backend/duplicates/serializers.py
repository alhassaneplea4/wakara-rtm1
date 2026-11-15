"""Read serializers of the duplicate-control API (explicit and light: no write model is exposed directly)."""
from rest_framework import serializers

from core.permissions import user_has_perm
from duplicates.models import (
    AnomalyType, Decision, DuplicateCase, DuplicateDecision, DuplicateEvidence,
    DuplicateMatch, DuplicateReviewHistory, RiskLevel,
)

RISK_LABELS = dict(RiskLevel.CHOICES)
ANOMALY_LABELS = dict(AnomalyType.CHOICES)


def _name(user):
    return (user.get_full_name() or user.username) if user else ''


def _mother_name(declaration):
    for p in declaration.parents.all():
        if p.parent_type == 'MOTHER' and not p.is_archived:
            return f"{p.first_names} {p.last_name}".strip()
    return ''


def declaration_brief(d) -> dict:
    child = getattr(d, 'child', None)
    acte = getattr(d, 'acte', None)
    return {
        'uuid': str(d.uuid), 'reference': d.reference, 'status': d.status, 'status_label': d.get_status_display(),
        'child_name': str(child) if child else '', 'birth_date': d.birth_date,
        'mother_name': _mother_name(d), 'agent_name': _name(d.created_by),
        'hospital_name': d.hospital.name if d.hospital else '',
        'official_number': acte.numero_acte if acte else None, 'is_archived': d.is_archived,
        'is_synced': d.device_created_at is not None, 'created_at': d.created_at,
    }


class CaseListSerializer(serializers.ModelSerializer):
    risk_label = serializers.SerializerMethodField()
    status_label = serializers.CharField(source='get_status_display', read_only=True)
    anomaly_label = serializers.SerializerMethodField()
    decision_label = serializers.CharField(source='get_final_decision_display', read_only=True)
    declaration = serializers.SerializerMethodField()
    other_declaration = serializers.SerializerMethodField()
    assigned_to_name = serializers.SerializerMethodField()
    data_quality = serializers.IntegerField(source='match.data_quality', read_only=True)
    twin_suspected = serializers.SerializerMethodField()

    class Meta:
        model = DuplicateCase
        fields = ['uuid', 'reference', 'status', 'status_label', 'risk_level', 'risk_label', 'score',
                  'data_quality', 'anomaly_type', 'anomaly_label', 'detected_at', 'resolved_at',
                  'final_decision', 'decision_label', 'declaration', 'other_declaration', 'assigned_to_name',
                  'twin_suspected']

    def get_risk_label(self, obj):
        return RISK_LABELS.get(obj.risk_level, obj.risk_level)

    def get_anomaly_label(self, obj):
        return ANOMALY_LABELS.get(obj.anomaly_type, obj.anomaly_type)

    def get_declaration(self, obj):
        return declaration_brief(obj.declaration)

    def get_other_declaration(self, obj):
        return declaration_brief(obj.other_declaration)

    def get_assigned_to_name(self, obj):
        return _name(obj.assigned_to)

    def get_twin_suspected(self, obj):
        return bool((obj.match.flags or {}).get('twin_suspected'))


class EvidenceSerializer(serializers.ModelSerializer):
    kind_label = serializers.CharField(source='get_kind_display', read_only=True)
    document = serializers.SerializerMethodField()
    declaration = serializers.SerializerMethodField()

    class Meta:
        model = DuplicateEvidence
        fields = ['uuid', 'kind', 'kind_label', 'title', 'content', 'document', 'declaration', 'added_by_name',
                  'added_at']

    def get_document(self, obj):
        return str(obj.document.uuid) if obj.document_id else None

    def get_declaration(self, obj):
        return obj.declaration.reference if obj.declaration_id else ''


class DecisionSerializer(serializers.ModelSerializer):
    decision_label = serializers.CharField(source='get_decision_display', read_only=True)
    principal = serializers.SerializerMethodField()
    duplicate = serializers.SerializerMethodField()

    class Meta:
        model = DuplicateDecision
        fields = ['uuid', 'decision', 'decision_label', 'reason', 'decided_by_name', 'decided_at',
                  'principal', 'duplicate', 'resulting_status']

    def get_principal(self, obj):
        return obj.principal_declaration.reference if obj.principal_declaration_id else ''

    def get_duplicate(self, obj):
        return obj.duplicate_declaration.reference if obj.duplicate_declaration_id else ''


class HistorySerializer(serializers.ModelSerializer):
    action_label = serializers.CharField(source='get_action_display', read_only=True)

    class Meta:
        model = DuplicateReviewHistory
        fields = ['id', 'action', 'action_label', 'actor_name', 'at', 'note', 'detail']


class CaseDetailSerializer(CaseListSerializer):
    criteria = serializers.SerializerMethodField()
    flags = serializers.SerializerMethodField()
    evidence = serializers.SerializerMethodField()
    decisions = DecisionSerializer(many=True, read_only=True)
    history = HistorySerializer(many=True, read_only=True)
    principal = serializers.SerializerMethodField()
    duplicate = serializers.SerializerMethodField()
    permissions = serializers.SerializerMethodField()
    match_uuid = serializers.SerializerMethodField()

    class Meta(CaseListSerializer.Meta):
        fields = CaseListSerializer.Meta.fields + [
            'criteria', 'flags', 'evidence', 'decisions', 'history', 'principal', 'duplicate',
            'permissions', 'match_uuid']

    def get_criteria(self, obj):
        return obj.match.criteria

    def get_flags(self, obj):
        return {**(obj.match.flags or {}), 'comparable_points': obj.match.comparable_points,
                'raw_points': obj.match.raw_points}

    def get_evidence(self, obj):
        return EvidenceSerializer(obj.evidence.select_related('document', 'declaration'), many=True).data

    def get_principal(self, obj):
        return obj.principal_declaration.reference if obj.principal_declaration_id else ''

    def get_duplicate(self, obj):
        return obj.duplicate_declaration.reference if obj.duplicate_declaration_id else ''

    def get_match_uuid(self, obj):
        return str(obj.match.uuid)

    def get_permissions(self, obj):
        user = self.context['request'].user
        return {
            'investigate': user_has_perm(user, 'duplicate.investigate') and not obj.is_resolved,
            'decide': user_has_perm(user, 'duplicate.decide'),
            'documents': user_has_perm(user, 'document.view'),
        }


class MatchSerializer(serializers.ModelSerializer):
    risk_label = serializers.SerializerMethodField()
    declaration = serializers.SerializerMethodField()
    candidate = serializers.SerializerMethodField()
    case = serializers.SerializerMethodField()
    criteria = serializers.JSONField(read_only=True)
    flags = serializers.JSONField(read_only=True)

    class Meta:
        model = DuplicateMatch
        fields = ['uuid', 'score', 'risk_level', 'risk_label', 'data_quality', 'raw_points', 'comparable_points',
                  'criteria', 'flags', 'detected_at', 'updated_at', 'declaration', 'candidate', 'case']

    def get_risk_label(self, obj):
        return RISK_LABELS.get(obj.risk_level, obj.risk_level)

    def get_declaration(self, obj):
        return declaration_brief(obj.declaration)

    def get_candidate(self, obj):
        return declaration_brief(obj.candidate)

    def get_case(self, obj):
        cases = list(obj.cases.all())
        if not cases:
            return None
        c = sorted(cases, key=lambda c: (c.status == 'RESOLVED', -c.id))[0]
        return {'uuid': str(c.uuid), 'reference': c.reference, 'status': c.status}


class DecideSerializer(serializers.Serializer):
    decision = serializers.ChoiceField(choices=Decision.CHOICES)
    reason = serializers.CharField(max_length=4000, allow_blank=False)
    duplicate_declaration = serializers.UUIDField(required=False, allow_null=True)


class ReasonSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=4000, allow_blank=False)


class NoteSerializer(serializers.Serializer):
    content = serializers.CharField(max_length=4000, allow_blank=False)
    kind = serializers.ChoiceField(
        choices=['OBSERVATION', 'VERIFICATION_RESULT', 'EXTERNAL_REFERENCE'], default='OBSERVATION')
    declaration = serializers.UUIDField(required=False, allow_null=True)


class VerificationSerializer(serializers.Serializer):
    content = serializers.CharField(max_length=4000, allow_blank=False)
    declaration = serializers.UUIDField(required=False, allow_null=True)


class AttachDocumentSerializer(serializers.Serializer):
    document = serializers.UUIDField()
    note = serializers.CharField(max_length=2000, required=False, allow_blank=True, default='')


class AssignSerializer(serializers.Serializer):
    assignee = serializers.UUIDField()
