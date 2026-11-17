/**
 * What the agent sees of a dossier = the last state received from the server + the operations still queued
 * on this device, replayed in order. Nothing else is stored: there is no second, hand-maintained copy that
 * could drift from the queue.
 *
 * Pure functions (no storage, no network) — unit-tested in offline.spec.ts.
 */
import { DeclarationDetail, STATUS_LABELS, Status, StatusHistoryEntry } from '../models';
import { HospitalRef, LocalDeclaration, Op, OpError, SyncState } from './types';

export const EDITABLE: Status[] = ['DRAFT', 'TO_CORRECT_COLLECTION'];
/** Statuses in which the secretariat corrects the declaration and completes the acte (core/workflow.py). */
export const SECRETARIAT_EDITABLE: Status[] = ['TRANSMITTED', 'IN_COMPLETION', 'TO_CORRECT_SECRETARIAT'];
export const FROZEN: Status[] = ['VALIDATED', 'REJECTED', 'DELIVERED'];
const SIMPLE = ['hospital', 'hospital_document_ref', 'doctor_name', 'midwife_name', 'birth_date', 'birth_time', 'birth_place', 'notes'];
const SECTIONS = ['child', 'mother', 'father', 'declarant'];
const NULLABLE = ['hospital', 'birth_time'];

export type CanFn = (permission: string) => boolean;

export interface ViewContext {
  userName: string; canUpdate: boolean; canTransmit: boolean; hospitals: HospitalRef[];
  /** Permissions of the signed-in user (secretariat, validator…). Without it: the collection agent's two rights. */
  can?: CanFn;
  /** Today, yyyy-mm-dd (tests) — the six-month rule is judged on it. */
  today?: string;
  /** Who is working, and whether the rules forbid validating one's own submission. */
  userUuid?: string;
  separateDuties?: boolean;
}

/**
 * The workflow of the server (core/workflow.py), mirrored so that every role sees on the device the steps it could
 * take online. The server stays the authority: it checks again each one when the operation is synchronised.
 */
export interface WorkflowStep { source: Status; target: Status; permission: string; reason_required: boolean; }
export const WORKFLOW: WorkflowStep[] = [
  { source: 'DRAFT', target: 'TRANSMITTED', permission: 'declaration.transmit', reason_required: false },
  { source: 'TRANSMITTED', target: 'PENDING_VALIDATION', permission: 'acte.submit', reason_required: false },
  { source: 'IN_COMPLETION', target: 'PENDING_VALIDATION', permission: 'acte.submit', reason_required: false },
  { source: 'PENDING_VALIDATION', target: 'VALIDATED', permission: 'dossier.validate', reason_required: false },
  { source: 'PENDING_VALIDATION', target: 'TO_CORRECT_COLLECTION', permission: 'dossier.reject', reason_required: true },
  { source: 'PENDING_VALIDATION', target: 'TO_CORRECT_SECRETARIAT', permission: 'dossier.reject', reason_required: true },
  { source: 'PENDING_VALIDATION', target: 'REJECTED', permission: 'dossier.reject', reason_required: true },
  { source: 'TO_CORRECT_COLLECTION', target: 'TRANSMITTED', permission: 'declaration.transmit', reason_required: false },
  { source: 'TO_CORRECT_SECRETARIAT', target: 'PENDING_VALIDATION', permission: 'acte.submit', reason_required: false },
];
// (TRANSMITTED → IN_COMPLETION « prendre en charge » is no longer offered; DELIVERED goes through a delivery)

export const SEPARATION_MESSAGE = "Séparation des tâches : un dossier ne peut pas être validé par la personne qui l'a soumis à validation. Un autre responsable doit prendre la décision.";

/** Who last sent the dossier to validation (the history is newest first). */
export function submittedBy(d: any): string | null {
  const entry = (d?.status_history ?? []).find((h: any) => h.to_status === 'PENDING_VALIDATION');
  return entry?.changed_by ?? null;
}

/** The rights a context gives; the agent-only context (no permission list) is the collection agent. */
export function canOf(ctx: ViewContext): CanFn {
  if (ctx.can) return ctx.can;
  return p => (p === 'declaration.update' ? ctx.canUpdate : p === 'declaration.transmit' ? ctx.canTransmit : false);
}

export function isFrozenStatus(status: string): boolean { return (FROZEN as string[]).includes(status); }

/** Six-month rule: the deadline is past, the dossier is still to be treated, and this user may not override it. */
export function isLockedByDeadline(d: any, can: CanFn, today: string): boolean {
  const limit = d?.deadline?.deadline_date as string | null | undefined;
  if (!limit || isFrozenStatus(d.status) || can('dossier.override_deadline')) return false;
  return today > limit;
}

/** declarations.services.can_edit_data */
export function canEditData(status: string, can: CanFn, locked: boolean): boolean {
  if (locked) return false;
  if ((EDITABLE as string[]).includes(status) && can('declaration.update')) return true;
  if ((SECRETARIAT_EDITABLE as string[]).includes(status) && can('acte.update')) return true;
  return status === 'PENDING_VALIDATION' && can('acte.update') && can('dossier.validate');
}

/** actes.services.can_edit_acte */
export function canEditActe(status: string, can: CanFn, locked: boolean): boolean {
  if (locked || !can('acte.update')) return false;
  return (SECRETARIAT_EDITABLE as string[]).includes(status) || (status === 'PENDING_VALIDATION' && can('dossier.validate'));
}

/** declarations.services.user_transitions */
export function userTransitions(status: string, can: CanFn, locked: boolean) {
  if (locked) return [];
  return WORKFLOW.filter(t => t.source === status && can(t.permission))
    .map(t => ({ target: t.target, reason_required: t.reason_required, permission: t.permission }));
}

/** Reference shown while the server has not attributed the real one (WKR-AAAA-NNNN) yet. */
export function localReference(uuid: string): string { return `LOCAL-${uuid.slice(0, 4).toUpperCase()}`; }

/**
 * Two successive write payloads of the same dossier folded into one (a later edit of a creation / an edit that
 * has not left the device yet). A section sent as null or left out keeps what the earlier payload said.
 */
export function mergeWrite(prev: Record<string, any>, next: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) continue;
    if (k === 'acte') { if (v) out.acte = { ...(prev['acte'] ?? {}), ...(v as object) }; continue; }  // registry header (secretariat)
    if (SECTIONS.includes(k)) {
      if (v !== null) out[k] = { ...(prev[k] ?? {}), ...v };
      else if (!(k in out)) out[k] = null;
    } else out[k] = v;
  }
  return out;
}

/** Applies a write payload to a dossier the way the API does (declarations.services.update_declaration). */
export function applyWrite(d: any, payload: Record<string, any>) {
  for (const k of SIMPLE) {
    if (k in payload) d[k] = payload[k] ?? (NULLABLE.includes(k) ? null : '');
  }
  for (const k of SECTIONS) {
    if (payload[k]) d[k] = { ...(d[k] ?? {}), ...payload[k] };
  }
}

/** The registry header written by the secretariat / the validator (nested ``acte`` of an update). */
export function applyActe(d: any, acte: Record<string, any> | null | undefined) {
  if (!acte) return;
  d.acte = { ...(d.acte ?? {}), ...acte };
  if ('numero_acte' in acte) d.official_number = (acte['numero_acte'] ?? '').toString().trim() || null;
}

function fromCreate(uuid: string, op: Op, ctx: ViewContext): any {
  const day = localDay(op.createdAt);
  const d: any = {
    uuid, reference: localReference(uuid), status: 'DRAFT', hospital: null, hospital_document_ref: '', doctor_name: '',
    midwife_name: '', birth_date: '', birth_time: null, birth_place: '', notes: '', received_at: day,
    child: { first_names: '', last_name: '', gender: '', nationality: '', npi: '', birth_rank: null },
    mother: null, father: null, declarant: null, acte_uuid: null, official_number: null,
    last_decision_reason: '', transmitted_at: null, validated_at: null, validated_by_name: '',
    created_by_name: ctx.userName, assigned_to_name: ctx.userName, created_at: op.createdAt, updated_at: op.updatedAt,
    status_history: [{ from_status: '', to_status: 'DRAFT', changed_by_name: ctx.userName, changed_at: op.createdAt, reason: '' }],
  };
  applyWrite(d, op.payload ?? {});
  return d;
}

/** yyyy-mm-dd in the device's own time zone (the day of the entry, as the agent lived it). */
export function localDay(iso: string): string {
  const t = new Date(iso);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** Sync state of a dossier from the operations that have not been confirmed by the server. */
export function syncStateOf(onServer: boolean, live: Pick<Op, 'status'>[]): SyncState {
  if (live.some(o => o.status === 'conflict')) return 'conflict';
  if (live.some(o => o.status === 'rejected')) return 'error';
  if (live.some(o => o.status === 'sending')) return 'sending';
  if (live.length) return onServer ? 'pending' : 'local';
  return 'synced';
}

export function firstError(live: Op[]): OpError | null {
  const bad = live.find(o => o.status === 'conflict') ?? live.find(o => o.status === 'rejected');
  return bad ? (bad.error ?? { code: bad.errorCode, detail: '' }) : null;
}

/**
 * The dossier as the agent must see it now. ``ops`` are all the operations of this dossier, oldest first.
 * Returns null when nothing is known about it on this device.
 */
export function materialize(uuid: string, server: DeclarationDetail | null, ops: Op[], ctx: ViewContext): LocalDeclaration | null {
  const live = ops.filter(o => o.status !== 'applied');
  const writes = live.filter(o => o.type !== 'document.upload');
  let d: any = server ? JSON.parse(JSON.stringify(server)) : null;
  const create = writes.find(o => o.type === 'declaration.create');
  if (!d && create) d = fromCreate(uuid, create, ctx);
  if (!d) return null;

  const can = canOf(ctx);
  // the operations replayed in the order they were made: edits first show as typed, a step waiting on the device
  // already shows as taken (a refused one does not — the dossier stays where the server left it)
  for (const op of writes) {
    if (op.type === 'declaration.update' && op.payload) { applyWrite(d, op.payload); applyActe(d, op.payload['acte']); continue; }
    if (op.status !== 'pending' && op.status !== 'sending') continue;
    const target = (op.type === 'declaration.transmit' ? 'TRANSMITTED' : op.type === 'declaration.transition' ? op.payload?.['status'] : null) as Status | null;
    if (target && WORKFLOW.some(t => t.source === d.status && t.target === target)) stepTo(d, target, op, ctx);
  }

  const hospital = ctx.hospitals.find(h => h.uuid === d.hospital);
  if (hospital) { d.hospital_name = hospital.name; d.hospital_code = hospital.code; }
  else if (!d.hospital) { d.hospital_name = null; d.hospital_code = null; }
  d.hospital_name ??= null;
  d.child_name = `${d.child?.first_names ?? ''} ${d.child?.last_name ?? ''}`.trim();
  d.status_label = STATUS_LABELS[d.status as Status] ?? d.status;
  if (live.length) d.updated_at = [d.updated_at, ...live.map(o => o.updatedAt)].filter(Boolean).sort().pop();

  const state = syncStateOf(!!server, live);
  d.sync_state = state;
  d.sync_error = firstError(live);
  const today = ctx.today ?? localDay(new Date().toISOString());
  const locked = isLockedByDeadline(d, can, today);
  d.overdue = !!d.deadline?.deadline_date && !isFrozenStatus(d.status) && today > d.deadline.deadline_date;
  d.can_edit = canEditData(d.status, can, locked) && state !== 'conflict';
  // separation of duties: whoever sent the dossier to validation does not validate it (the server checks it again)
  const mustNotValidate = !!ctx.separateDuties && !!ctx.userUuid && d.status === 'PENDING_VALIDATION' && submittedBy(d) === ctx.userUuid;
  d.validation_blocked = mustNotValidate;
  d.available_transitions = state === 'conflict' ? [] : userTransitions(d.status, can, locked).filter(t => !(mustNotValidate && t.target === 'VALIDATED'));
  if (d.acte) d.acte.can_edit = canEditActe(d.status, can, locked) && state !== 'conflict';
  return d as LocalDeclaration;
}

/** What a step waiting to be sent changes in the dossier as the user sees it. */
function stepTo(d: any, target: Status, op: Op, ctx: ViewContext) {
  const reason = (op.payload?.['reason'] as string | undefined)?.trim();
  const step: StatusHistoryEntry = {
    from_status: d.status, to_status: target, changed_by: ctx.userUuid ?? null, changed_by_name: ctx.userName, changed_at: op.deviceTime,
    reason: reason || "En attente d'envoi au serveur.",
  };
  d.status_history = [step, ...(d.status_history ?? [])];
  d.status = target;
  if (target === 'TRANSMITTED') d.transmitted_at = op.deviceTime;
  if (target === 'VALIDATED') {
    d.validated_at = op.deviceTime; d.validated_by_name = ctx.userName;
    const numero = (op.payload?.['numero_acte'] as string | undefined)?.trim();
    if (numero) applyActe(d, { numero_acte: numero, ...(op.payload?.['annee'] ? { annee: op.payload['annee'] } : {}), registre: op.payload?.['registre'] ?? d.acte?.registre ?? '', feuillet: op.payload?.['feuillet'] ?? d.acte?.feuillet ?? '' });
  }
  if (reason && WORKFLOW.some(t => t.target === target && t.reason_required)) d.last_decision_reason = reason;
}

/* ── Transmission rule, mirrored from the API (which stays the authority) ── */

export const FIELD_LABELS: Record<string, string> = {
  birth_date: 'date de naissance', birth_time: 'heure de naissance', birth_place: 'lieu de naissance', hospital: 'établissement',
  'child.gender': "sexe de l'enfant", 'child.name': "nom de l'enfant", 'child.first_names': "prénoms de l'enfant",
  'child.last_name': "nom de l'enfant", 'child.nationality': "nationalité de l'enfant",
  'mother.name': 'nom de la mère', 'father.name': 'nom du père', 'declarant.name': 'nom du déclarant',
  'acte.declaration_date': 'date de déclaration', 'child.birth_rank': "rang de naissance de l'enfant",
  'mother.date_of_birth': 'date de naissance de la mère', 'mother.birth_place': 'lieu de naissance de la mère',
  'mother.nationality': 'nationalité de la mère', 'mother.profession': 'profession de la mère', 'mother.address': 'domicile de la mère',
  'father.date_of_birth': 'date de naissance du père', 'father.birth_place': 'lieu de naissance du père',
  'father.nationality': 'nationalité du père', 'father.profession': 'profession du père', 'father.address': 'domicile du père',
  'declarant.relationship': "lien du déclarant avec l'enfant", 'acte.registre': 'registre', 'acte.feuillet': 'feuillet',
  'acte.annee': 'année du registre', 'acte.officer_name': "officier d'état civil",
  'mother.first_names': 'prénoms de la mère', 'mother.last_name': 'nom de la mère', 'mother.age': 'âge de la mère', 'mother.phone': 'téléphone de la mère',
  'father.first_names': 'prénoms du père', 'father.last_name': 'nom du père', 'father.age': 'âge du père', 'father.phone': 'téléphone du père',
  'declarant.first_names': 'prénoms du déclarant', 'declarant.last_name': 'nom du déclarant', 'declarant.nationality': 'nationalité du déclarant',
  'declarant.profession': 'profession du déclarant', 'declarant.address': 'domicile du déclarant', 'declarant.phone': 'téléphone du déclarant',
  'father.marital_status': 'situation matrimoniale du père', 'mother.marital_status': 'situation matrimoniale de la mère',
  'declarant.marital_status': 'situation matrimoniale du déclarant', 'acte.region': 'région administrative', 'acte.prefecture': 'préfecture',
  'acte.commune': 'commune', 'acte.commune_type': 'type de commune (urbaine ou rurale)', 'acte.centre': 'centre',
  'acte.centre_type': 'type de centre (principal ou secondaire)',
};

function filled(d: any, spec: string): boolean {
  const [scope, field] = spec.includes('.') ? spec.split('.') : ['', spec];
  if (!scope) return !!d[field];
  if (scope === 'acte') {
    if (field === 'declaration_date') return true;  // the server dates the declaration today when the secretariat left it empty
    return !!d.acte?.[field];
  }
  const section = d[scope];
  if (!section) return false;
  if (field === 'name') return !!(section.first_names || section.last_name);
  return !!section[field];
}

export function missingForTransmission(d: any, specs: string[]): string[] {
  return specs.filter(s => !filled(d, s));
}

/* ── List of the dossiers kept on the device (used without connection) ── */

export interface ListQuery {
  search: string; statuses: string[]; hospital: string; from: string; to: string; ordering: string;
  birthFrom?: string; birthTo?: string; assignedTo?: string; overdue?: boolean | null;
}

export function matchesQuery(d: LocalDeclaration, q: ListQuery): boolean {
  if (q.statuses.length && !q.statuses.includes(d.status)) return false;
  if (q.hospital && d.hospital !== q.hospital) return false;
  if (q.from && d.received_at < q.from) return false;
  if (q.to && d.received_at > q.to) return false;
  if (q.birthFrom && (d.birth_date ?? '') < q.birthFrom) return false;
  if (q.birthTo && (d.birth_date ?? '') > q.birthTo) return false;
  if (q.assignedTo && (d as any).assigned_to_uuid && (d as any).assigned_to_uuid !== q.assignedTo) return false;
  if (q.overdue === true && !(d as any).overdue) return false;
  if (q.overdue === false && (d as any).overdue) return false;
  if (q.search) {
    const needle = q.search.trim().toLowerCase();
    const hay = [d.reference, d.child?.first_names, d.child?.last_name, d.hospital_document_ref, d.official_number].join(' ').toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export function sortViews(rows: LocalDeclaration[], ordering: string): LocalDeclaration[] {
  const desc = ordering.startsWith('-');
  const field = (desc ? ordering.slice(1) : ordering) || 'updated_at';
  const value = (d: any) => String(d[field] ?? '');
  return [...rows].sort((a, b) => (desc ? value(b).localeCompare(value(a)) : value(a).localeCompare(value(b))));
}

/** Columns of the declarations list, out of a full dossier. */
export function toListItem(d: LocalDeclaration) {
  return {
    uuid: d.uuid, reference: d.reference, status: d.status, status_label: d.status_label, hospital: d.hospital,
    hospital_name: d.hospital_name, hospital_code: d.hospital_code ?? null, birth_date: d.birth_date, received_at: d.received_at,
    child_name: d.child_name, assigned_to_name: d.assigned_to_name, official_number: d.official_number, can_edit: d.can_edit,
    updated_at: d.updated_at, created_at: d.created_at, sync_state: d.sync_state, sync_error: d.sync_error ?? null,
    overdue: !!(d as any).overdue,
  };
}
