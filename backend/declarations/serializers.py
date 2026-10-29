"""Serializers for the declarations app."""
from rest_framework import serializers

from core.workflow import Status
from hospitals.models import Hospital

from .models import Child, Declarant, Declaration, Parent, StatusHistory
from .services import can_edit_data, user_transitions


class ChildSerializer(serializers.ModelSerializer):
    class Meta:
        model = Child
        fields = ['first_names', 'last_name', 'gender', 'birth_weight', 'birth_length']


class ParentSerializer(serializers.ModelSerializer):
    class Meta:
        model = Parent
        fields = ['first_names', 'last_name', 'date_of_birth', 'birth_place', 'age',
                  'nationality', 'profession', 'address', 'phone', 'id_type', 'id_number']


class DeclarantSerializer(serializers.ModelSerializer):
    class Meta:
        model = Declarant
        fields = ['first_names', 'last_name', 'relationship', 'profession', 'phone',
                  'address', 'id_type', 'id_number']


class StatusHistorySerializer(serializers.ModelSerializer):
    changed_by_name = serializers.SerializerMethodField()

    class Meta:
        model = StatusHistory
        fields = ['from_status', 'to_status', 'changed_by_name', 'changed_at', 'reason']

    def get_changed_by_name(self, obj):
        u = obj.changed_by
        return (u.get_full_name() or u.username) if u else ''


def _full_name(user):
    return (user.get_full_name() or user.username) if user else ''


class DeclarationListSerializer(serializers.ModelSerializer):
    hospital = serializers.SlugRelatedField(slug_field='uuid', read_only=True)
    hospital_name = serializers.CharField(source='hospital.name', read_only=True, default=None)
    child_name = serializers.SerializerMethodField()
    status_label = serializers.CharField(source='get_status_display', read_only=True)
    assigned_to_name = serializers.SerializerMethodField()
    official_number = serializers.SerializerMethodField()

    class Meta:
        model = Declaration
        fields = [
            'uuid', 'reference', 'status', 'status_label', 'hospital', 'hospital_name',
            'birth_date', 'received_at', 'child_name', 'assigned_to_name', 'official_number',
            'updated_at', 'created_at',
        ]

    def get_child_name(self, obj):
        child = getattr(obj, 'child', None)
        return str(child) if child else ''

    def get_assigned_to_name(self, obj):
        return _full_name(obj.assigned_to)

    def get_official_number(self, obj):
        acte = getattr(obj, 'acte', None)
        return acte.numero_acte if acte else None


class DeclarationDetailSerializer(DeclarationListSerializer):
    child = serializers.SerializerMethodField()
    mother = serializers.SerializerMethodField()
    father = serializers.SerializerMethodField()
    declarant = serializers.SerializerMethodField()
    acte_uuid = serializers.SerializerMethodField()
    status_history = StatusHistorySerializer(many=True, read_only=True)
    created_by_name = serializers.SerializerMethodField()
    validated_by_name = serializers.SerializerMethodField()
    available_transitions = serializers.SerializerMethodField()
    can_edit = serializers.SerializerMethodField()

    class Meta(DeclarationListSerializer.Meta):
        fields = DeclarationListSerializer.Meta.fields + [
            'hospital_document_ref', 'doctor_name', 'midwife_name', 'birth_time', 'birth_place',
            'notes', 'last_decision_reason', 'transmitted_at', 'validated_at',
            'validated_by_name', 'child', 'mother', 'father', 'declarant', 'acte_uuid',
            'status_history', 'created_by_name', 'available_transitions', 'can_edit',
        ]

    def get_child(self, obj):
        child = getattr(obj, 'child', None)
        return ChildSerializer(child).data if child else None

    def _parent(self, obj, kind):
        for p in obj.parents.all():
            if p.parent_type == kind and not p.is_archived:
                return ParentSerializer(p).data
        return None

    def get_mother(self, obj):
        return self._parent(obj, Parent.MOTHER)

    def get_father(self, obj):
        return self._parent(obj, Parent.FATHER)

    def get_declarant(self, obj):
        d = getattr(obj, 'declarant', None)
        return DeclarantSerializer(d).data if d else None

    def get_acte_uuid(self, obj):
        acte = getattr(obj, 'acte', None)
        return str(acte.uuid) if acte else None

    def get_created_by_name(self, obj):
        return _full_name(obj.created_by)

    def get_validated_by_name(self, obj):
        return _full_name(obj.validated_by)

    def get_available_transitions(self, obj):
        user = self.context['request'].user
        return [
            {'target': t.target, 'reason_required': t.reason_required, 'permission': t.permission}
            for t in user_transitions(user, obj)
        ]

    def get_can_edit(self, obj):
        return can_edit_data(self.context['request'].user, obj)


class DeclarationWriteSerializer(serializers.ModelSerializer):
    """Create/update payload. Nested sections are optional; status and references are never writable."""
    child = ChildSerializer(required=False)
    mother = ParentSerializer(required=False, allow_null=True)
    father = ParentSerializer(required=False, allow_null=True)
    declarant = DeclarantSerializer(required=False, allow_null=True)
    hospital = serializers.SlugRelatedField(
        slug_field='uuid', queryset=Hospital.objects.all(), required=False, allow_null=True)

    class Meta:
        model = Declaration
        fields = [
            'hospital', 'hospital_document_ref', 'doctor_name', 'midwife_name',
            'birth_date', 'birth_time', 'birth_place', 'notes',
            'child', 'mother', 'father', 'declarant',
        ]

    def validate_hospital(self, hospital):
        if hospital is not None and not hospital.is_active:
            raise serializers.ValidationError("Cet établissement est désactivé.")
        return hospital

    def validate_birth_date(self, value):
        from django.utils import timezone
        if value > timezone.localdate():
            raise serializers.ValidationError("La date de naissance ne peut pas être dans le futur.")
        return value

    def validate(self, attrs):
        if self.instance is None and 'birth_date' not in attrs:
            raise serializers.ValidationError({'birth_date': "La date de naissance est requise."})
        return attrs


class TransitionSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=Status.ALL)
    reason = serializers.CharField(required=False, allow_blank=True, default='', max_length=2000)
    # Optional, used when validating (official numbering inputs)
    annee = serializers.IntegerField(required=False, min_value=1900, max_value=2200)
    registre = serializers.CharField(required=False, allow_blank=True, max_length=50)
    feuillet = serializers.CharField(required=False, allow_blank=True, max_length=50)
    numero_acte = serializers.CharField(required=False, allow_blank=True, max_length=50)
