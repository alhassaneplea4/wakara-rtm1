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
const SIMPLE = ['hospital', 'hospital_document_ref', 'doctor_name', 'midwife_name', 'birth_date', 'birth_time', 'birth_place', 'notes'];
const SECTIONS = ['child', 'mother', 'father', 'declarant'];
const NULLABLE = ['hospital', 'birth_time'];

export interface ViewContext { userName: string; canUpdate: boolean; canTransmit: boolean; hospitals: HospitalRef[]; }

/** Reference shown while the server has not attributed the real one (WKR-AAAA-NNNN) yet. */
export function localReference(uuid: string): string { return `LOCAL-${uuid.slice(0, 4).toUpperCase()}`; }

/**
 * Two successive write payloads of the same dossier folded into one (a later edit of a creation / an edit that
 * has not left the device yet). A section sent as null or left out keeps what the earlier payload said.
 */
export function mergeWrite(prev: Record<string, any>, next: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (k === 'acte' || v === undefined) continue;
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

  for (const op of writes) {
    if (op.type === 'declaration.update' && op.payload) applyWrite(d, op.payload);
  }
  // a transmission waiting on the device already shows as transmitted; a refused one does not
  const transmit = writes.find(o => o.type === 'declaration.transmit' && (o.status === 'pending' || o.status === 'sending'));
  if (transmit && EDITABLE.includes(d.status)) {
    const step: StatusHistoryEntry = {
      from_status: d.status, to_status: 'TRANSMITTED', changed_by_name: ctx.userName, changed_at: transmit.deviceTime,
      reason: "En attente d'envoi au serveur.",
    };
    d.status_history = [step, ...(d.status_history ?? [])];
    d.status = 'TRANSMITTED';
    d.transmitted_at = transmit.deviceTime;
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
  d.can_edit = EDITABLE.includes(d.status) && state !== 'conflict' && ctx.canUpdate;
  d.available_transitions = d.can_edit && ctx.canTransmit
    ? [{ target: 'TRANSMITTED', reason_required: false, permission: 'declaration.transmit' }] : [];
  return d as LocalDeclaration;
}

/* ── Transmission rule, mirrored from the API (which stays the authority) ── */

export const FIELD_LABELS: Record<string, string> = {
  birth_date: 'date de naissance', birth_time: 'heure de naissance', birth_place: 'lieu de naissance', hospital: 'établissement',
  'child.gender': "sexe de l'enfant", 'child.name': "nom de l'enfant", 'child.first_names': "prénoms de l'enfant",
  'child.last_name': "nom de l'enfant", 'child.nationality': "nationalité de l'enfant",
  'mother.name': 'nom de la mère', 'father.name': 'nom du père', 'declarant.name': 'nom du déclarant',
};

function filled(d: any, spec: string): boolean {
  const [scope, field] = spec.includes('.') ? spec.split('.') : ['', spec];
  if (!scope) return !!d[field];
  if (scope === 'acte') return true;  // the acte only exists once the secretariat works on the dossier
  const section = d[scope];
  if (!section) return false;
  if (field === 'name') return !!(section.first_names || section.last_name);
  return !!section[field];
}

export function missingForTransmission(d: any, specs: string[]): string[] {
  return specs.filter(s => !filled(d, s));
}

/* ── List of the dossiers kept on the device (used without connection) ── */

export interface ListQuery { search: string; statuses: string[]; hospital: string; from: string; to: string; ordering: string; }

export function matchesQuery(d: LocalDeclaration, q: ListQuery): boolean {
  if (q.statuses.length && !q.statuses.includes(d.status)) return false;
  if (q.hospital && d.hospital !== q.hospital) return false;
  if (q.from && d.received_at < q.from) return false;
  if (q.to && d.received_at > q.to) return false;
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
  };
}
