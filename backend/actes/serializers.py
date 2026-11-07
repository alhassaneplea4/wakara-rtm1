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


def _person_name(user):
    return (user.get_full_name() or user.username) if user else ''


class DeliverySerializer(serializers.ModelSerializer):
    delivered_by_name = serializers.SerializerMethodField()
    reference = serializers.CharField(source='acte.declaration.reference', read_only=True)
    official_number = serializers.CharField(source='acte.numero_acte', read_only=True)
    child_name = serializers.SerializerMethodField()
    acte_uuid = serializers.UUIDField(source='acte.uuid', read_only=True)
    declaration_uuid = serializers.UUIDField(source='acte.declaration.uuid', read_only=True)
    hospital_name = serializers.CharField(source='acte.declaration.hospital.name', read_only=True, default=None)
    validated_by_name = serializers.SerializerMethodField()
    print_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Delivery
        fields = ['uuid', 'acte_uuid', 'declaration_uuid', 'reference', 'official_number', 'child_name',
                  'hospital_name', 'delivered_at', 'recipient_name', 'recipient_relationship',
                  'recipient_id_type', 'recipient_id_number', 'is_duplicate', 'notes', 'delivered_by_name',
                  'validated_by_name', 'print_count']
        read_only_fields = ['uuid', 'is_duplicate']

    def get_validated_by_name(self, obj):
        return _person_name(obj.acte.declaration.validated_by)

    def get_delivered_by_name(self, obj):
        return _person_name(obj.delivered_by)

    def get_child_name(self, obj):
        child = getattr(obj.acte.declaration, 'child', None)
        return str(child) if child else ''


class DeliveryDetailSerializer(DeliverySerializer):
    """One delivery with everything needed to understand what was done: the act, the path of the dossier,
    the printed copies and the other deliveries of the same act."""
    acte = serializers.SerializerMethodField()
    history = serializers.SerializerMethodField()
    prints = serializers.SerializerMethodField()
    other_deliveries = serializers.SerializerMethodField()

    class Meta(DeliverySerializer.Meta):
        fields = DeliverySerializer.Meta.fields + ['acte', 'history', 'prints', 'other_deliveries']

    def get_acte(self, obj):
        a = obj.acte
        d = a.declaration
        child = getattr(d, 'child', None)
        return {
            'status': d.status, 'status_label': d.get_status_display(),
            'numero_acte': a.numero_acte, 'annee': a.annee, 'registre': a.registre, 'feuillet': a.feuillet,
            'declaration_date': a.declaration_date, 'officer_name': a.officer_name,
            'numero_assigned_by_name': _person_name(a.numero_assigned_by), 'numero_assigned_at': a.numero_assigned_at,
            'validated_at': d.validated_at, 'created_by_name': _person_name(d.created_by),
            'birth_date': d.birth_date, 'birth_place': d.birth_place,
            'child_gender': child.gender if child else '', 'child_npi': child.npi if child else '',
        }

    def get_history(self, obj):
        from declarations.serializers import StatusHistorySerializer
        rows = obj.acte.declaration.status_history.select_related('changed_by')
        return StatusHistorySerializer(rows, many=True).data

    def get_prints(self, obj):
        return PrintLogSerializer(obj.acte.print_logs.select_related('printed_by'), many=True).data

    def get_other_deliveries(self, obj):
        others = Delivery.objects.filter(acte=obj.acte).exclude(pk=obj.pk).select_related('delivered_by')
        return [{'uuid': str(o.uuid), 'delivered_at': o.delivered_at, 'recipient_name': o.recipient_name,
                 'is_duplicate': o.is_duplicate, 'delivered_by_name': _person_name(o.delivered_by)} for o in others]


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
