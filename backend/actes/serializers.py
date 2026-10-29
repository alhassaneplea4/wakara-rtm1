from rest_framework import serializers

from .models import Acte, Delivery, PrintLog


class ActeListSerializer(serializers.ModelSerializer):
    declaration_uuid = serializers.UUIDField(source='declaration.uuid', read_only=True)
    reference = serializers.CharField(source='declaration.reference', read_only=True)
    status = serializers.CharField(source='declaration.status', read_only=True)
    status_label = serializers.CharField(source='declaration.get_status_display', read_only=True)
    child_name = serializers.SerializerMethodField()
    hospital_name = serializers.CharField(source='declaration.hospital.name', read_only=True, default=None)

    class Meta:
        model = Acte
        fields = ['uuid', 'declaration_uuid', 'reference', 'status', 'status_label', 'child_name',
                  'hospital_name', 'annee', 'registre', 'feuillet', 'numero_acte', 'updated_at']

    def get_child_name(self, obj):
        child = getattr(obj.declaration, 'child', None)
        return str(child) if child else ''


class ActeSerializer(ActeListSerializer):
    can_edit = serializers.SerializerMethodField()

    class Meta(ActeListSerializer.Meta):
        fields = ActeListSerializer.Meta.fields + [
            'region', 'prefecture', 'commune', 'centre', 'declaration_date',
            'officer_name', 'mentions', 'numero_assigned_at', 'can_edit',
        ]

    def get_can_edit(self, obj):
        from .services import can_edit_acte
        return can_edit_acte(self.context['request'].user, obj)


class ActeUpdateSerializer(serializers.ModelSerializer):
    """The official number is NOT editable here: it is attributed at validation."""

    class Meta:
        model = Acte
        fields = ['annee', 'registre', 'feuillet', 'region', 'prefecture', 'commune', 'centre',
                  'declaration_date', 'officer_name', 'mentions']


class DeliverySerializer(serializers.ModelSerializer):
    delivered_by_name = serializers.SerializerMethodField()
    reference = serializers.CharField(source='acte.declaration.reference', read_only=True)
    official_number = serializers.CharField(source='acte.numero_acte', read_only=True)
    child_name = serializers.SerializerMethodField()
    acte_uuid = serializers.UUIDField(source='acte.uuid', read_only=True)

    class Meta:
        model = Delivery
        fields = ['uuid', 'acte_uuid', 'reference', 'official_number', 'child_name', 'delivered_at',
                  'recipient_name', 'recipient_relationship', 'recipient_id_type',
                  'recipient_id_number', 'is_duplicate', 'notes', 'delivered_by_name']
        read_only_fields = ['uuid', 'is_duplicate']

    def get_delivered_by_name(self, obj):
        u = obj.delivered_by
        return (u.get_full_name() or u.username) if u else ''

    def get_child_name(self, obj):
        child = getattr(obj.acte.declaration, 'child', None)
        return str(child) if child else ''


class DeliveryCreateSerializer(serializers.ModelSerializer):
    delivered_at = serializers.DateTimeField(required=False)

    class Meta:
        model = Delivery
        fields = ['delivered_at', 'recipient_name', 'recipient_relationship',
                  'recipient_id_type', 'recipient_id_number', 'notes']


class PrintLogSerializer(serializers.ModelSerializer):
    printed_by_name = serializers.SerializerMethodField()

    class Meta:
        model = PrintLog
        fields = ['printed_at', 'copy_number', 'printed_by_name']

    def get_printed_by_name(self, obj):
        u = obj.printed_by
        return (u.get_full_name() or u.username) if u else ''
