from rest_framework import serializers

from .models import Hospital


class HospitalSerializer(serializers.ModelSerializer):
    declaration_count = serializers.IntegerField(read_only=True, default=0)
    facility_type_label = serializers.CharField(source='get_facility_type_display', read_only=True)

    class Meta:
        model = Hospital
        fields = [
            'uuid', 'code', 'name', 'facility_type', 'facility_type_label', 'region', 'commune',
            'address', 'contact_name', 'phone', 'email', 'is_active', 'is_archived',
            'declaration_count', 'created_at', 'updated_at',
        ]
        read_only_fields = ['uuid', 'is_archived', 'created_at', 'updated_at']

    def validate_code(self, value):
        value = value.strip().upper()
        qs = Hospital.all_objects.filter(code=value)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("Ce code est déjà utilisé.")
        return value
