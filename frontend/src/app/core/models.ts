/** API types — mirror the backend serializers. */

export interface Page<T> { count: number; next: string | null; previous: string | null; results: T[]; }

export interface RoleBrief { codename: string; name: string; }

export interface Me {
  uuid: string; username: string; email: string; first_name: string; last_name: string;
  phone: string; address: string; hospital: string | null; hospital_name?: string | null;
  roles: RoleBrief[]; permissions: string[]; must_change_password: boolean;
  /** Second factor (authentication application): set up, and required of this account but not set up yet. */
  two_factor_enabled?: boolean; must_set_up_two_factor?: boolean;
  date_joined: string; last_login: string | null;
}

export type Status =
  | 'DRAFT' | 'TRANSMITTED' | 'IN_COMPLETION' | 'PENDING_VALIDATION' | 'TO_CORRECT_COLLECTION'
  | 'TO_CORRECT_SECRETARIAT' | 'VALIDATED' | 'REJECTED' | 'DELIVERED';

export const STATUS_LABELS: Record<Status, string> = {
  DRAFT: 'Brouillon', TRANSMITTED: 'Transmis au secrétariat', IN_COMPLETION: 'Acte incomplet',
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
  hospital_name: string | null; hospital_code?: string | null; birth_date: string; received_at: string; child_name: string;
  assigned_to_name: string; official_number: string | null; can_edit?: boolean; updated_at: string; created_at: string;
  /** Offline mode: the last transmission / the entry was made on an agent's device (absent on dossiers prepared locally). */
  transmitted_offline?: boolean; entered_offline?: boolean; device_transmitted_at?: string | null;
  /** Six-month rule: past the deadline and still to be treated (goes to the courts). */
  overdue?: boolean;
}

export interface Child { first_names: string; last_name: string; gender: 'M' | 'F' | ''; nationality?: string; npi?: string; birth_rank?: number | null; }
export interface Person {
  first_names: string; last_name: string; date_of_birth?: string | null; birth_place?: string; age?: number | null;
  nationality?: string; npi?: string; marital_status?: string; profession?: string; address?: string; phone?: string;
}
export interface Declarant {
  first_names: string; last_name: string; relationship?: string; nationality?: string; npi?: string; marital_status?: string; profession?: string; phone?: string;
  address?: string;
}
export interface StatusHistoryEntry { from_status: string; to_status: string; changed_by?: string | null; changed_by_name: string; changed_at: string; reason: string; }
export interface AvailableTransition { target: Status; reason_required: boolean; permission: string; }

export interface DeclarationDetail extends DeclarationListItem {
  hospital_document_ref: string; doctor_name: string; midwife_name: string; birth_time: string | null;
  birth_place: string; notes: string; last_decision_reason: string; transmitted_at: string | null;
  validated_at: string | null; validated_by_name: string; child: Child | null; mother: Person | null;
  father: Person | null; declarant: Declarant | null; acte_uuid: string | null;
  status_history: StatusHistoryEntry[]; created_by_name: string;
  available_transitions: AvailableTransition[]; can_edit: boolean;
  duplicate_alert?: DuplicateAlert;
  deadline?: DossierDeadline;
}

export interface DossierDeadline {
  months: number; reference_date: string | null; deadline_date: string | null; applies: boolean; overdue: boolean;
  days_over: number; message: string; can_override: boolean;
}

/** Duplicate-control status of a dossier (the case itself is only detailed for the control centre). */
export interface DuplicateAlert {
  blocked: boolean;
  open_cases: { uuid?: string; reference?: string; risk_level: RiskLevel; status: CaseStatus; score?: number }[];
  designated_duplicate: { uuid?: string; reference?: string; principal_reference?: string }[];
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
  commune_type: string; centre_type: string;
  centre: string; declaration_date: string | null; officer_name: string; mentions: string; can_edit: boolean;
}

export interface Delivery {
  uuid: string; acte_uuid: string; declaration_uuid: string; reference: string; official_number: string | null; child_name: string;
  hospital_name: string | null; delivered_at: string; recipient_name: string; recipient_relationship: string;
  recipient_id_type: string; recipient_id_number: string; is_duplicate: boolean;
  notes: string; delivered_by_name: string; validated_by_name: string; print_count: number;
}

export interface DeliveryDetail extends Delivery {
  acte: {
    status: Status; status_label: string; numero_acte: string | null; annee: number | null; registre: string; feuillet: string;
    declaration_date: string | null; officer_name: string; numero_assigned_by_name: string; numero_assigned_at: string | null;
    validated_at: string | null; created_by_name: string; birth_date: string; birth_place: string; child_gender: string; child_npi: string;
  };
  history: StatusHistoryEntry[];
  prints: { printed_at: string; copy_number: number; printed_by_name: string }[];
  other_deliveries: { uuid: string; delivered_at: string; recipient_name: string; is_duplicate: boolean; delivered_by_name: string }[];
}

export interface DeliverySummary { total: number; first: number; duplicates: number; today: number; this_month: number; }

export interface UserRow {
  uuid: string; username: string; email: string; first_name: string; last_name: string; phone: string;
  is_active: boolean; hospital: string | null; hospital_name: string | null; roles: RoleBrief[];
  date_joined: string; last_login: string | null; is_locked: boolean; two_factor_enabled?: boolean;
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
  kpis: { births_declared: number; declarations_received: number; in_progress: number; pending_validation: number; to_correct: number; validated: number; rejected: number; delivered: number };
  offline?: { transmitted: number; entered: number; received: number; latest_device_transmission: string | null };
  monthly: { month: string; received: number; validated: number }[];
  by_hospital: { name: string; count: number }[];
  by_status: { status: Status; label: string; count: number }[];
  by_gender: { M: number; F: number; unknown: number } | null;
  delays: { avg_days_transmission_to_validation: number | null };
}

export interface Inbox { total: number; items: { code: string; label: string; count: number; status: Status | 'OVERDUE' | 'DUPLICATES' }[]; badges: Record<string, number>; }

/* ── Historiques des actes (administrator) ───────── */

export interface HistoryRow {
  uuid: string; reference: string; child_name: string; status: Status; status_label: string; hospital_name: string;
  official_number: string | null; created_by_name: string; created_at: string; is_archived: boolean;
  last_event_at: string; event_count: number; last_actor: string; last_action: string;
}

export interface HistoryEvent {
  id: number; at: string; kind: string; icon: string; tone: 'info' | 'success' | 'warning' | 'danger'; title: string; milestone: string;
  who: string; username: string; roles: string[]; reason: string; ip: string | null; object: string;
  details: { label: string; from?: string; to?: string; value?: string }[];
}

export interface HistoryDetail {
  dossier: {
    uuid: string; reference: string; child_name: string; status: Status; status_label: string; hospital_name: string; birth_date: string;
    official_number: string | null; annee: number | null; registre: string; acte_uuid: string | null; is_archived: boolean;
    created_by_name: string; created_at: string; validated_by_name: string; validated_at: string | null;
  };
  events: HistoryEvent[];
  people: { name: string; username: string; roles: string[]; count: number; first_at: string; last_at: string; kinds: { kind: string; label: string; count: number }[] }[];
  kinds: { kind: string; label: string; count: number }[];
}

export interface HistorySummary { events_today: number; dossiers_today: number; users_today: number; changes_today: number; deliveries_today: number; }
/* ── Duplicate control ───────────────────────────── */
export type RiskLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export type CaseStatus = 'OPEN' | 'IN_REVIEW' | 'AWAITING_INFO' | 'RESOLVED';
export type DecisionCode = 'CONFIRMED_DUPLICATE' | 'DISTINCT_CHILDREN' | 'MULTIPLE_BIRTH' | 'DATA_ENTRY_ERROR' | 'INSUFFICIENT_INFO' | 'FURTHER_VERIFICATION';

export const RISK_TONE: Record<RiskLevel, 'danger' | 'warning' | 'neutral'> = { HIGH: 'danger', MEDIUM: 'warning', LOW: 'neutral' };
export const RISK_LABELS: Record<RiskLevel, string> = { HIGH: 'Risque élevé', MEDIUM: 'Risque moyen', LOW: 'Risque faible' };
export const CASE_STATUS_TONE: Record<CaseStatus, 'danger' | 'info' | 'warning' | 'success'> = { OPEN: 'danger', IN_REVIEW: 'info', AWAITING_INFO: 'warning', RESOLVED: 'success' };

export interface DeclarationBrief {
  uuid: string; reference: string; status: Status; status_label: string; child_name: string; birth_date: string;
  mother_name: string; agent_name: string; hospital_name: string; official_number: string | null;
  is_archived: boolean; is_synced: boolean; created_at: string;
}

export interface DuplicateCase {
  uuid: string; reference: string; status: CaseStatus; status_label: string; risk_level: RiskLevel; risk_label: string;
  score: number; data_quality: number; anomaly_type: string; anomaly_label: string; detected_at: string;
  resolved_at: string | null; final_decision: DecisionCode | ''; decision_label: string;
  declaration: DeclarationBrief; other_declaration: DeclarationBrief; assigned_to_name: string; twin_suspected: boolean;
}

export interface CriterionPart { label: string; weight: number; similarity: number | null; detail: string; }
export interface Criterion {
  key: string; label: string; weight: number; comparable: boolean; similarity: number | null; points: number;
  exact: boolean; detail: string; parts: CriterionPart[];
}
export interface MatchFlags {
  twin_suspected?: boolean; distinguishing?: string[]; corroboration?: string[]; risk_caps?: string[];
  raw_risk?: RiskLevel; comparable_points?: number; raw_points?: number;
  official_act?: { declaration: boolean; candidate: boolean };
}
export interface CaseEvidence { uuid: string; kind: string; kind_label: string; title: string; content: string; document: string | null; declaration: string; added_by_name: string; added_at: string; }
export interface CaseDecision { uuid: string; decision: DecisionCode; decision_label: string; reason: string; decided_by_name: string; decided_at: string; principal: string; duplicate: string; resulting_status: CaseStatus; }
export interface CaseHistoryEntry { id: number; action: string; action_label: string; actor_name: string; at: string; note: string; detail: Record<string, unknown>; }

export interface DuplicateCaseDetail extends DuplicateCase {
  criteria: Record<string, Criterion>; flags: MatchFlags; evidence: CaseEvidence[]; decisions: CaseDecision[];
  history: CaseHistoryEntry[]; principal: string; duplicate: string; match_uuid: string;
  permissions: { investigate: boolean; decide: boolean; documents: boolean };
  warnings?: string[];
  /** What became of the redundant dossier after a decision: rejected / already_rejected / kept. */
  redundant_outcome?: 'rejected' | 'already_rejected' | 'kept' | '';
}

export interface CompareRow { label: string; a: string; b: string; status: 'same' | 'similar' | 'different' | 'missing'; }
export interface CompareSummary { uuid: string; reference: string; status: Status; status_label: string; child_name: string; birth_date: string; official_number: string | null; created_by_name: string; created_at: string; is_archived: boolean; }
export interface DuplicateComparison {
  a: CompareSummary; b: CompareSummary; sections: { key: string; title: string; rows: CompareRow[] }[];
  counts: Record<string, number>; documents: { a: CompareDoc[]; b: CompareDoc[] }; documents_visible: boolean;
  criteria?: Record<string, Criterion>; score?: number; risk_level?: RiskLevel; flags?: MatchFlags; data_quality?: number;
}
export interface CompareDoc { uuid: string; kind: string; kind_label: string; original_name: string; size: number; created_at: string; }

export interface DuplicateSummary {
  total: number; high: number; medium: number; low: number; in_review: number; awaiting_decision: number; resolved: number;
  confirmed_duplicates: number; distinct: number; multiple_birth: number; data_entry_error: number; unresolved: number;
  by_anomaly: Record<string, number>;
}

export interface DuplicateMatchRow {
  uuid: string; score: number; risk_level: RiskLevel; risk_label: string; data_quality: number; criteria: Record<string, Criterion>;
  flags: MatchFlags; detected_at: string; declaration: DeclarationBrief; candidate: DeclarationBrief;
  case: { uuid: string; reference: string; status: CaseStatus } | null;
}

export interface DuplicateFilterOptions {
  agents: { uuid: string; name: string }[]; investigators: { uuid: string; name: string }[];
  risk_levels: { value: string; label: string }[]; statuses: { value: string; label: string }[];
  anomaly_types: { value: string; label: string }[];
  decisions: { value: DecisionCode; label: string; final: boolean; designates_duplicate: boolean }[];
}

export interface DuplicateConfig {
  weights: Record<string, number>; thresholds: { high: number; medium: number }; min_quality_for_high: number;
  blocking_levels: string[]; date_window_days: number; min_recorded_score: number;
}
