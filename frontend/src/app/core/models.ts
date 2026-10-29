/** API types — mirror the backend serializers. */

export interface Page<T> { count: number; next: string | null; previous: string | null; results: T[]; }

export interface RoleBrief { codename: string; name: string; }

export interface Me {
  uuid: string; username: string; email: string; first_name: string; last_name: string;
  phone: string; address: string; hospital: string | null; hospital_name?: string | null;
  roles: RoleBrief[]; permissions: string[]; must_change_password: boolean;
  date_joined: string; last_login: string | null;
}

export type Status =
  | 'DRAFT' | 'TRANSMITTED' | 'IN_COMPLETION' | 'PENDING_VALIDATION' | 'TO_CORRECT_COLLECTION'
  | 'TO_CORRECT_SECRETARIAT' | 'VALIDATED' | 'REJECTED' | 'DELIVERED';

export const STATUS_LABELS: Record<Status, string> = {
  DRAFT: 'Brouillon', TRANSMITTED: 'Transmis au secrétariat', IN_COMPLETION: 'En complément',
  PENDING_VALIDATION: 'En attente de validation', TO_CORRECT_COLLECTION: 'À corriger — collecte',
  TO_CORRECT_SECRETARIAT: 'À corriger — secrétariat', VALIDATED: 'Validé définitivement',
  REJECTED: 'Rejeté', DELIVERED: 'Acte délivré',
};

export const STATUS_TONE: Record<Status, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  DRAFT: 'neutral', TRANSMITTED: 'info', IN_COMPLETION: 'warning', PENDING_VALIDATION: 'warning',
  TO_CORRECT_COLLECTION: 'danger', TO_CORRECT_SECRETARIAT: 'danger', VALIDATED: 'success',
  REJECTED: 'danger', DELIVERED: 'success',
};

export interface DeclarationListItem {
  uuid: string; reference: string; status: Status; status_label: string; hospital: string | null;
  hospital_name: string | null; birth_date: string; received_at: string; child_name: string;
  assigned_to_name: string; official_number: string | null; updated_at: string; created_at: string;
}

export interface Child { first_names: string; last_name: string; gender: 'M' | 'F' | ''; birth_weight?: string | null; birth_length?: string | null; }
export interface Person {
  first_names: string; last_name: string; date_of_birth?: string | null; birth_place?: string; age?: number | null;
  nationality?: string; profession?: string; address?: string; phone?: string; id_type?: string; id_number?: string;
}
export interface Declarant {
  first_names: string; last_name: string; relationship?: string; profession?: string; phone?: string;
  address?: string; id_type?: string; id_number?: string;
}
export interface StatusHistoryEntry { from_status: string; to_status: string; changed_by_name: string; changed_at: string; reason: string; }
export interface AvailableTransition { target: Status; reason_required: boolean; permission: string; }

export interface DeclarationDetail extends DeclarationListItem {
  hospital_document_ref: string; doctor_name: string; midwife_name: string; birth_time: string | null;
  birth_place: string; notes: string; last_decision_reason: string; transmitted_at: string | null;
  validated_at: string | null; validated_by_name: string; child: Child | null; mother: Person | null;
  father: Person | null; declarant: Declarant | null; acte_uuid: string | null;
  status_history: StatusHistoryEntry[]; created_by_name: string;
  available_transitions: AvailableTransition[]; can_edit: boolean;
}

export interface Hospital {
  uuid: string; code: string; name: string; facility_type: string; facility_type_label: string; region: string;
  commune: string; address: string; contact_name: string; phone: string; email: string; is_active: boolean;
  is_archived: boolean; declaration_count: number; created_at: string;
}

export interface Acte {
  uuid: string; declaration_uuid: string; reference: string; status: Status; status_label: string;
  child_name: string; hospital_name: string | null; annee: number | null; registre: string; feuillet: string;
  numero_acte: string | null; updated_at: string; region: string; prefecture: string; commune: string;
  centre: string; declaration_date: string | null; officer_name: string; mentions: string; can_edit: boolean;
}

export interface ActeDocument {
  is_official: boolean; status: Status; reference: string; official_number: string | null; annee: number | null;
  registre: string; feuillet: string; region: string; prefecture: string; commune: string; centre: string;
  declaration_date: string | null; child: { first_names: string; last_name: string; gender: string; birth_date: string; birth_time: string | null; birth_place: string };
  father: Person | null; mother: Person | null; declarant: (Person & { relationship: string }) | null;
  hospital: string; mentions: string; officer_name: string; validated_at: string | null;
}

export interface Delivery {
  uuid: string; acte_uuid: string; reference: string; official_number: string | null; child_name: string;
  delivered_at: string; recipient_name: string; recipient_relationship: string; is_duplicate: boolean;
  notes: string; delivered_by_name: string;
}

export interface UserRow {
  uuid: string; username: string; email: string; first_name: string; last_name: string; phone: string;
  is_active: boolean; hospital: string | null; hospital_name: string | null; roles: RoleBrief[];
  date_joined: string; last_login: string | null; is_locked: boolean;
  // detail only
  address?: string; must_change_password?: boolean; permission_overrides?: { codename: string; granted: boolean }[];
  effective_permissions?: string[];
}

export interface Role { id: number; codename: string; name: string; description: string; is_active: boolean; is_system: boolean; permissions: string[]; user_count: number; }
export interface PermissionDef { id: number; codename: string; name: string; category: string; }

export interface AuditEntry {
  id: number; created_at: string; username: string; action: string; object_type: string; object_id: string;
  object_repr: string; changes: Record<string, unknown>; reason: string; ip_address: string | null;
}

export interface SupportingDocument {
  uuid: string; declaration: string; kind: string; original_name: string; content_type: string; size: number;
  sha256: string; description: string; uploaded_by_name: string; created_at: string;
}

export interface Dashboard {
  period: { year: number; date_from: string; date_to: string };
  kpis: { births_declared: number; declarations_received: number; in_progress: number; pending_validation: number; validated: number; rejected: number; delivered: number };
  monthly: { month: string; received: number; validated: number }[];
  by_hospital: { name: string; count: number }[];
  by_status: { status: Status; label: string; count: number }[];
  by_gender: { M: number; F: number; unknown: number } | null;
  delays: { avg_days_transmission_to_validation: number | null };
}

export interface Inbox { total: number; items: { code: string; label: string; count: number; status: Status }[]; }
