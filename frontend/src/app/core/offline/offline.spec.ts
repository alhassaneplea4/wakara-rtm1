import { HttpErrorResponse, HttpParams, HttpRequest, HttpResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { Subject, firstValueFrom, of, throwError } from 'rxjs';
import { BackupError, backupFileName, exportBackup, restoreBackup } from './backup';
import { decryptJson, encryptJson, generateRecoveryCode, normalizeRecoveryCode, sha256Hex } from './crypto';
import { OfflineDb, countUnsynced, deleteDb } from './db';
import { LocalApi } from './local-api';
import { WORKFLOW, localReference, materialize, mergeWrite, missingForTransmission, syncStateOf, userTransitions } from './materialize';
import { OfflineStore } from './store';
import { SyncEngine } from './sync';
import { LocalDeclaration, Op, PushResult } from './types';
import {
  PinError, RecoveryError, changeVaultPin, clearVaultSession, createVault, destroyVault, loadVaultSession, openVault, pendingRecoveryCode, pinProblem,
  recoverVault, recoveryMissing, recoveryRegistered, saveVaultSession,
} from './vault';
import { readVaultHeader, writeVaultHeader } from './vault-header';

const API = '/api';
const USER = { uuid: 'agent-test', username: 'agent', name: 'Agent Test' };
const FAST = 1000;  // PBKDF2 iterations for the tests only
const ctx = { userName: 'Agent Test', canUpdate: true, canTransmit: true, hospitals: [{ uuid: 'h1', code: 'CMC', name: 'Clinique' }] };

const payload = (over: Record<string, any> = {}) => ({
  hospital: 'h1', hospital_document_ref: '', doctor_name: '', midwife_name: '', birth_date: '2026-11-01', birth_time: '08:30',
  birth_place: 'Ratoma', notes: '', child: { first_names: 'Aminata', last_name: 'Diallo', gender: 'F' },
  mother: { first_names: 'Fatoumata', last_name: 'Bah' }, father: null, declarant: null, ...over,
});

const op = (over: Partial<Op>): Op => ({
  seq: 1, opId: 'op-1', entity: 'd1', type: 'declaration.create', status: 'pending', attempts: 0,
  deviceTime: '2026-11-10T10:00:00.000Z', createdAt: '2026-11-10T10:00:00.000Z', updatedAt: '2026-11-10T10:00:00.000Z',
  payload: payload(), error: null, ...over,
});

/* ───────────────────────── PIN and encryption ───────────────────────── */

describe('Offline vault (PIN)', () => {
  beforeEach(() => writeVaultHeader(null));
  afterAll(() => writeVaultHeader(null));

  it('refuses weak codes', () => {
    expect(pinProblem('12345')).toContain('au moins 8');
    expect(pinProblem('00000000')).toContain('trop simple');
    expect(pinProblem('12345678')).toContain('trop simple');
    expect(pinProblem('482915')).toContain('au moins 8');
    expect(pinProblem('48291563')).toContain('lettres et des chiffres');   // digits only: falls to a graphics card in minutes
    expect(pinProblem('abcdefgh')).toContain('trop simple');
    expect(pinProblem('kadiatou')).toContain('lettres et des chiffres');
    expect(pinProblem('Wakara2026')).toContain('trop courant');
    expect(pinProblem('Fatou4827')).toBe('');
    expect(pinProblem('mon enfant est ne a ratoma')).toBe('');            // a long phrase needs no digit
    expect(pinProblem('aaaa1111')).toContain('trop peu');
  });

  it('opens with the right code only, and counts wrong attempts', async () => {
    await createVault('482915', USER, FAST);
    expect(readVaultHeader()!.user.uuid).toBe(USER.uuid);
    await expectAsync(openVault('482915')).toBeResolved();
    await expectAsync(openVault('111222')).toBeRejectedWithError(PinError, /4 essais/);
    expect(readVaultHeader()!.fails).toBe(1);
    await openVault('482915');
    expect(readVaultHeader()!.fails).toBe(0);
  });

  it('blocks for a while after 5 wrong codes, even for the right one', async () => {
    await createVault('482915', USER, FAST);
    for (let i = 0; i < 4; i++) await expectAsync(openVault('999111')).toBeRejected();
    await expectAsync(openVault('999111')).toBeRejectedWithError(PinError, /Trop de codes incorrects/);
    expect(readVaultHeader()!.lockedUntil).toBeGreaterThan(Date.now());
    await expectAsync(openVault('482915')).toBeRejectedWithError(PinError, /Trop de codes incorrects/);
  });

  it('keeps the session encrypted and gives it back after the PIN', async () => {
    const key = await createVault('482915', USER, FAST);
    const session = { access: 'access-token', refresh: 'refresh-token', me: { uuid: USER.uuid, username: 'agent' } as any };
    await saveVaultSession(key, session);
    expect(localStorage.getItem('wk_vault_session')).not.toContain('access-token');
    expect(await loadVaultSession(await openVault('482915'))).toEqual(session);
  });

  it('changes the code without losing the data key', async () => {
    const key = await createVault('482915', USER, FAST);
    const secret = await encryptJson(key, { hello: 'monde' });
    await changeVaultPin('482915', '739264');
    await expectAsync(openVault('482915')).toBeRejected();
    expect(await decryptJson<any>(await openVault('739264'), secret)).toEqual({ hello: 'monde' });
  }, 60_000);   // a new code brings the key derivation up to the current cost (600 000 iterations, three times here)

  it('the data key cannot be exported', async () => {
    const key = await createVault('482915', USER, FAST);
    expect(key.extractable).toBeFalse();
    await expectAsync(crypto.subtle.exportKey('raw', key)).toBeRejected();
  });

  it('is removed with its session', async () => {
    const key = await createVault('482915', USER, FAST);
    await saveVaultSession(key, { access: 'a', refresh: 'r', me: {} as any });
    destroyVault();
    expect(readVaultHeader()).toBeNull();
    expect(localStorage.getItem('wk_vault_session')).toBeNull();
  });

  it('sign-out keeps the vault (the code is created once per device) but removes the saved session', async () => {
    const key = await createVault('482915', USER, FAST);
    await saveVaultSession(key, { access: 'a', refresh: 'r', me: {} as any });
    clearVaultSession();
    expect(readVaultHeader()?.user.uuid).toBe(USER.uuid);            // same code, no new set-up
    expect(await loadVaultSession(key)).toBeNull();                  // data cannot be reopened without a new sign-in
    await expectAsync(openVault('482915')).toBeResolved();           // the code still unlocks the device
  });
});

/* ───────────────────────── recovery code ───────────────────────── */

describe('Recovery code of the vault', () => {
  beforeEach(() => writeVaultHeader(null));
  afterAll(() => writeVaultHeader(null));

  it('generates long, readable, valid codes', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(normalizeRecoveryCode(code)).toBe(code);
    expect(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, ' '))).toBe(code);
    expect(new Set(Array.from({ length: 20 }, generateRecoveryCode)).size).toBe(20);
    expect(normalizeRecoveryCode('1234')).toBe('');
    expect(normalizeRecoveryCode('U'.repeat(24))).toBe('');
    expect(normalizeRecoveryCode('ABCD-EFGH-JKMN-PQRS-TVWX-OIL3')).toBe('ABCD-EFGH-JKMN-PQRS-TVWX-0113');
  });

  it('a new vault makes a recovery code, kept encrypted until the server has it', async () => {
    const key = await createVault('482915', USER, FAST);
    const header = readVaultHeader()!;
    expect(header.rec).toBeDefined();
    expect(header.recPending).toBeDefined();
    const code = (await pendingRecoveryCode(key))!;
    expect(normalizeRecoveryCode(code)).toBe(code);
    expect(JSON.stringify(header)).not.toContain(code);                 // never readable on the device without the data key
    expect(JSON.stringify(header)).not.toContain(code.replace(/-/g, ''));
  });

  it('the recovery code opens the vault, keeps the data, replaces the PIN and is replaced itself', async () => {
    const key = await createVault('482915', USER, FAST);
    const secret = await encryptJson(key, { hello: 'monde' });
    const code = (await pendingRecoveryCode(key))!;
    const reopened = await recoverVault(code, '739264', FAST);
    expect(await decryptJson<any>(reopened, secret)).toEqual({ hello: 'monde' });      // same data key: nothing re-encrypted
    expect(reopened.extractable).toBeFalse();
    await expectAsync(openVault('482915')).toBeRejectedWithError(PinError);             // the forgotten code is gone
    expect(await decryptJson<any>(await openVault('739264'), secret)).toEqual({ hello: 'monde' });
    const next = (await pendingRecoveryCode(reopened))!;
    expect(next).not.toBe(code);                                                         // the code the administrator read is of no use any more
    await expectAsync(recoverVault(code, '555666', FAST)).toBeRejectedWithError(RecoveryError, /pas le bon/);
  });

  it('a wrong or malformed code is refused and touches nothing', async () => {
    const key = await createVault('482915', USER, FAST);
    const secret = await encryptJson(key, { a: 1 });
    await expectAsync(recoverVault('AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', '739264', FAST)).toBeRejectedWithError(RecoveryError, /pas le bon/);
    await expectAsync(recoverVault('1234', '739264', FAST)).toBeRejectedWithError(RecoveryError, /invalide/);
    expect(await decryptJson<any>(await openVault('482915'), secret)).toEqual({ a: 1 });   // the old code still works
  });

  it('a device without recovery code cannot be recovered', async () => {
    await createVault('482915', USER, FAST);
    const { rec: _rec, recPending: _pending, ...bare } = readVaultHeader()!;
    writeVaultHeader(bare);
    await expectAsync(recoverVault(generateRecoveryCode(), '739264', FAST)).toBeRejectedWithError(RecoveryError, /pas de code de récupération/);
  });

  it('a vault made before the recovery code gets one at its next unlock, without disturbing it', async () => {
    const key = await createVault('482915', USER, FAST);
    const secret = await encryptJson(key, { old: true });
    const { rec: _rec, recPending: _pending, ...bare } = readVaultHeader()!;
    writeVaultHeader(bare);
    const reopened = await openVault('482915');
    expect(readVaultHeader()!.rec).toBeDefined();
    const code = (await pendingRecoveryCode(reopened))!;
    expect(code).toBeTruthy();
    expect(await decryptJson<any>(await recoverVault(code, '739264', FAST), secret)).toEqual({ old: true });
  });

  it('changing the PIN keeps the recovery code valid', async () => {
    const key = await createVault('482915', USER, FAST);
    const secret = await encryptJson(key, { x: 2 });
    const code = (await pendingRecoveryCode(key))!;
    await changeVaultPin('482915', '739264');
    expect(await decryptJson<any>(await recoverVault(code, '888777', FAST), secret)).toEqual({ x: 2 });
  }, 60_000);

  it('the code waits until the server confirms, then nothing is kept', async () => {
    const key = await createVault('482915', USER, FAST);
    expect(await pendingRecoveryCode(key)).toBeTruthy();
    recoveryRegistered();
    expect(readVaultHeader()!.recPending).toBeUndefined();
    expect(readVaultHeader()!.rec).toBeDefined();                         // the wrapping itself stays: the server holds the code
    expect(await pendingRecoveryCode(key)).toBeNull();
  });

  it('a server that lost the code makes the device generate a new one at the next unlock', async () => {
    const key = await createVault('482915', USER, FAST);
    const first = (await pendingRecoveryCode(key))!;
    recoveryRegistered();
    recoveryMissing();
    expect(readVaultHeader()!.recRenew).toBeTrue();
    const reopened = await openVault('482915');
    const second = (await pendingRecoveryCode(reopened))!;
    expect(second).not.toBe(first);
    expect(readVaultHeader()!.recRenew).toBeUndefined();
    await expectAsync(recoverVault(first, '739264', FAST)).toBeRejectedWithError(RecoveryError);   // the lost code no longer opens it
    await expectAsync(recoverVault(second, '739264', FAST)).toBeResolved();
  });

  it('does not ask for a new code while one is still waiting to be sent', async () => {
    await createVault('482915', USER, FAST);
    recoveryMissing();                                                    // the server has nothing, but the device still holds the code to send
    expect(readVaultHeader()!.recRenew).toBeUndefined();
  });

  it('a restored backup makes a fresh recovery code (the original one may have been replaced since)', async () => {
    const key = await createVault('482915', USER, FAST);
    const db = new OfflineDb(USER.uuid);
    await db.open();
    const text = await (await exportBackup(db)).text();
    db.close();
    writeVaultHeader(null);
    await restoreBackup(text);
    expect(readVaultHeader()!.rec).toBeUndefined();
    const reopened = await openVault('482915');
    expect(await pendingRecoveryCode(reopened)).toBeTruthy();
    expect(await decryptJson<any>(reopened, await encryptJson(key, { z: 1 }))).toEqual({ z: 1 });
    await deleteDb(USER.uuid);
  });
});

/* ───────────────────────── what the agent sees ───────────────────────── */

describe('Offline view of a dossier', () => {
  it('a dossier created on the device is a local draft', () => {
    const d = materialize('d1abcdef', null, [op({ entity: 'd1abcdef' })], ctx)!;
    expect(d.reference).toBe('LOCAL-D1AB');
    expect(localReference('d1abcdef')).toBe('LOCAL-D1AB');
    expect([d.status, d.sync_state, d.can_edit]).toEqual(['DRAFT', 'local', true]);
    expect([d.child_name, d.hospital_name, d.created_by_name]).toEqual(['Aminata Diallo', 'Clinique', 'Agent Test']);
    expect(d.available_transitions.map(t => t.target)).toEqual(['TRANSMITTED']);
    expect(d.father).toBeNull();
  });

  it('later edits are replayed in order on top of the creation', () => {
    const edits = [op({}), op({ seq: 2, opId: 'op-2', type: 'declaration.update', payload: { birth_place: 'Kipé', child: { first_names: 'Aïcha' }, father: { last_name: 'Barry' } } })];
    const d = materialize('d1', null, edits, ctx)!;
    expect([d.birth_place, d.child!.first_names, d.child!.last_name, d.father!.last_name]).toEqual(['Kipé', 'Aïcha', 'Diallo', 'Barry']);
  });

  it('a transmission waiting on the device shows as transmitted and locks the dossier', () => {
    const d = materialize('d1', null, [op({}), op({ seq: 2, opId: 'op-2', type: 'declaration.transmit', payload: {} })], ctx)!;
    expect([d.status, d.can_edit, d.sync_state]).toEqual(['TRANSMITTED', false, 'local']);
    expect(d.status_history[0].to_status).toBe('TRANSMITTED');
  });

  it('a refused transmission leaves the dossier editable, flagged in error', () => {
    const refused = op({ seq: 2, opId: 'op-2', type: 'declaration.transmit', status: 'rejected', error: { code: 'validation', detail: 'nom du père manquant' } });
    const d = materialize('d1', { ...serverRow(), status: 'DRAFT' } as any, [refused], ctx)!;
    expect([d.status, d.can_edit, d.sync_state, d.sync_error!.detail]).toEqual(['DRAFT', true, 'error', 'nom du père manquant']);
  });

  it('a conflict freezes local edits until the agent decides', () => {
    const conflict = op({ type: 'declaration.update', status: 'conflict', payload: { notes: 'x' }, error: { code: 'version_conflict' } });
    const d = materialize('d1', serverRow() as any, [conflict], ctx)!;
    expect([d.sync_state, d.can_edit]).toEqual(['conflict', false]);
  });

  it('a dossier with nothing waiting is « en ligne »; applied operations no longer count', () => {
    const d = materialize('d1', serverRow() as any, [op({ status: 'applied', payload: undefined })], ctx)!;
    expect([d.sync_state, d.reference]).toEqual(['synced', 'WKR-2026-0001']);
    expect(materialize('unknown', null, [], ctx)).toBeNull();
  });

  it('state priority: conflict > error > sending > waiting', () => {
    expect(syncStateOf(true, [{ status: 'pending' }, { status: 'conflict' }, { status: 'rejected' }])).toBe('conflict');
    expect(syncStateOf(true, [{ status: 'sending' }, { status: 'rejected' }])).toBe('error');
    expect(syncStateOf(true, [{ status: 'pending' }, { status: 'sending' }])).toBe('sending');
    expect(syncStateOf(true, [{ status: 'pending' }])).toBe('pending');
    expect(syncStateOf(false, [{ status: 'pending' }])).toBe('local');
    expect(syncStateOf(true, [])).toBe('synced');
  });

  it('folds successive edits into one payload', () => {
    const merged = mergeWrite(payload(), { birth_place: 'Kipé', child: { gender: 'M' }, father: null, acte: { numero_acte: '1' } });
    expect([merged['birth_place'], merged['child'], merged['father']]).toEqual(['Kipé', { first_names: 'Aminata', last_name: 'Diallo', gender: 'M' }, null]);
    // the registry header (secretariat) is folded like the other sections
    expect(merged['acte']).toEqual({ numero_acte: '1' });
    expect(mergeWrite(merged, { acte: { registre: 'R2' } })['acte']).toEqual({ numero_acte: '1', registre: 'R2' });
  });

  it('mirrors the transmission rule of the server', () => {
    const d = materialize('d1', null, [op({ payload: payload({ birth_time: null, child: { gender: '' } }) })], ctx)!;
    expect(missingForTransmission(d, ['birth_date', 'birth_time', 'birth_place', 'child.gender', 'mother.name', 'father.name', 'acte.registre', 'acte.declaration_date']))
      .toEqual(['birth_time', 'child.gender', 'father.name', 'acte.registre']);   // the date of declaration is set by the server
  });
});

function serverRow(over: Record<string, any> = {}) {
  return {
    uuid: 'd1', reference: 'WKR-2026-0001', status: 'DRAFT', status_label: 'Brouillon', hospital: 'h1', hospital_name: 'Clinique',
    birth_date: '2026-11-01', birth_time: '08:30:00', birth_place: 'Ratoma', notes: '', hospital_document_ref: '', doctor_name: '',
    midwife_name: '', received_at: '2026-11-10', child: { first_names: 'Aminata', last_name: 'Diallo', gender: 'F' }, mother: null,
    father: null, declarant: null, acte_uuid: null, status_history: [], created_at: '2026-11-10T10:00:00Z',
    updated_at: '2026-11-10T10:00:00Z', sync_version: 1, child_name: 'Aminata Diallo', assigned_to_name: 'Agent Test',
    official_number: null, can_edit: true, available_transitions: [], ...over,
  };
}

/* ───────────────────────── queue, local API and synchronisation ───────────────────────── */

/** A tiny stand-in for the server: applies pushed operations like backend/sync does, and can misbehave on demand. */
class FakeServer {
  rows = new Map<string, any>();
  seen = new Map<string, PushResult>();
  pushes: any[] = [];
  documents: { uuid: string; declaration: string; sha256: string; bytes: number }[] = [];
  fail: 'network' | 'lost-answer' | null = null;
  after = new Map<string, number>();
  refuseGet: HttpErrorResponse | null = null;
  reject: ((o: any) => { status: 'rejected' | 'conflict'; code: string; detail: string } | null) | null = null;
  private counter = 0;

  post = (url: string, body: any) => {
    if (this.fail === 'network') return throwError(() => new HttpErrorResponse({ status: 0 }));
    if (url.endsWith('/sync/documents/')) return this.document(body as FormData);
    this.pushes.push(body);
    const results = body.operations.map((o: any) => this.apply(o));
    if (this.fail === 'lost-answer') { this.fail = null; return throwError(() => new HttpErrorResponse({ status: 0 })); }
    return of({ server_time: new Date().toISOString(), results });
  };
  get = (_url: string, _options?: any) => this.refuseGet ? throwError(() => this.refuseGet) : of({
    server_time: new Date().toISOString(), offline_enabled: true, cursor: '2026-11-12T00:00:00+00:00', has_more: false,
    declarations: [], hospitals: [{ uuid: 'h1', code: 'CMC', name: 'Clinique' }],
    rules: { required_for_transmission: ['birth_date', 'birth_time', 'birth_place', 'child.gender'], max_upload_size: 4194304, max_batch: 20 },
  });

  private apply(o: any): PushResult {
    const base = { op_id: o.op_id, type: o.type, entity_uuid: o.entity_uuid, date_anomaly: '' };
    const before = this.seen.get(o.op_id);
    if (before?.status === 'applied') return { ...before, status: 'duplicate', declaration: this.rows.get(o.entity_uuid) };
    const refusal = this.reject?.(o);
    let row = this.rows.get(o.entity_uuid);
    let result: PushResult;
    if (refusal) result = { ...base, status: refusal.status, error: { code: refusal.code, detail: refusal.detail }, declaration: row ?? null };
    else if (o.type === 'declaration.update' && row && (o.base_version ?? this.after.get(o.after_op)) !== row.sync_version) {
      result = { ...base, status: 'conflict', error: { code: 'version_conflict', detail: 'Le dossier a changé.' }, declaration: row };
    } else {
      if (o.type === 'declaration.create' && !row) row = serverRow({ uuid: o.entity_uuid, reference: `WKR-2026-${String(++this.counter).padStart(4, '0')}`, ...o.payload });
      else if (o.type === 'declaration.update') row = { ...row, ...o.payload, child: { ...row.child, ...(o.payload.child ?? {}) }, sync_version: row.sync_version + 1 };
      else if (o.type === 'declaration.transmit') row = { ...row, status: 'TRANSMITTED', status_label: 'Transmis à l\'état civil', sync_version: row.sync_version + 1 };
      this.rows.set(o.entity_uuid, row);
      this.after.set(o.op_id, row.sync_version);
      result = { ...base, status: 'applied', error: null, declaration: row };
    }
    this.seen.set(o.op_id, result);
    return result;
  }

  private document(form: FormData) {
    const file = form.get('file') as File;
    const opId = String(form.get('op_id'));
    if (!this.seen.has(opId)) {
      this.documents.push({ uuid: String(form.get('uuid')), declaration: String(form.get('declaration')), sha256: String(form.get('sha256')), bytes: file.size });
      this.seen.set(opId, { op_id: opId, type: 'document.upload', status: 'applied', entity_uuid: String(form.get('uuid')), date_anomaly: '', error: null, declaration: null });
    }
    return of({ result: this.seen.get(opId)! });
  }
}

describe('Offline queue and synchronisation', () => {
  let db: OfflineDb, store: OfflineStore, api: LocalApi, sync: SyncEngine, server: FakeServer;
  let userUuid: string;
  const online = signal(false);
  const expired = signal(false);
  let host: { messages: string[]; revoked: boolean; signIn: number; lost: string };
  const conn: any = { online, offlineEnabled: signal(true), changes: new Subject<boolean>(), check: async () => online(), reportFailure: () => online.set(false), start: () => undefined };
  const offlineNext = () => throwError(() => new HttpErrorResponse({ status: 0 }));
  let cachedAt: string | null = null;

  const call = async <T = any>(method: string, path: string, body: any = null, params: Record<string, any> = {}, next: any = offlineNext) => {
    const req = new HttpRequest<any>(method as any, API + path, body, { params: new HttpParams({ fromObject: params }) });
    return (await firstValueFrom(api.handle(req, next))) as HttpResponse<T>;
  };
  const create = async (over: Record<string, any> = {}) => (await call<LocalDeclaration>('POST', '/declarations/', payload(over))).body!;

  beforeEach(async () => {
    userUuid = `test-${Math.random().toString(36).slice(2)}`;
    online.set(false); expired.set(false);
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    db = new OfflineDb(userUuid);
    store = new OfflineStore(db, key, () => ({ userName: 'Agent Test', canUpdate: true, canTransmit: true }));
    await store.setSecret('hospitals', ctx.hospitals);
    server = new FakeServer();
    host = { messages: [], revoked: false, signIn: 0, lost: '' };
    sync = new SyncEngine(store, server as any, conn, {
      syncing: () => undefined, synced: () => undefined, failed: m => host.messages.push(m), deviceRevoked: () => { host.revoked = true; }, deviceLimit: () => undefined, accessLost: m => { host.lost = m; }, signInRequired: () => { host.signIn++; },
      changed: () => undefined, sessionExpired: () => expired(),
    }, { apiUrl: API, deviceId: 'device-1', deviceLabel: 'Test', userUuid });
    cachedAt = null;
    api = new LocalApi(store, conn, { apiUrl: API, userName: () => 'Agent Test', sessionExpired: () => expired(), changed: () => undefined, cachedPage: at => { cachedAt = at; } });
  });
  afterEach(async () => { sync.stop(); db.close(); await deleteDb(userUuid); });

  it('an edit stacked on an earlier operation of the dossier travels with that operation, not with a version', async () => {
    const row = serverRow({ uuid: 'd9', sync_version: 3 });
    server.rows.set('d9', row); await store.putServer(row as any);
    const first = await store.addOp('d9', 'declaration.update', { payload: { notes: 'a' }, baseVersion: 3 });
    const second = await store.addOp('d9', 'declaration.update', { payload: { notes: 'b' }, baseVersion: null });
    online.set(true);
    await sync.run(true);
    const [one, two] = server.pushes[0].operations;
    expect([one.base_version, one.after_op]).toEqual([3, null]);
    expect([two.base_version, two.after_op]).toEqual([null, first.opId]);
    expect((await store.ops()).map(o => o.status)).toEqual(['applied', 'applied']);
    expect(second.opId).not.toBe(first.opId);
  });

  it('rights withdrawn: the copies of the dossiers are erased, the unsent work stays', async () => {
    await store.putServer(serverRow({ uuid: 'other' }) as any);
    await store.cachePut('/stats/', { total: 1 });
    const mine = await create();
    online.set(true);
    server.refuseGet = new HttpErrorResponse({ status: 403, error: { code: 'access_lost', detail: 'Vos droits ont changé.' } });
    await sync.run();
    expect(host.lost).toContain('droits');
    expect(await store.server('other')).toBeNull();
    expect(await store.cacheGet('/stats/')).toBeNull();
    expect(await store.counts()).toEqual(jasmine.objectContaining({ waiting: 1, problems: 0 }));
    expect((await store.view(mine.uuid))?.sync_state).toBe('local');
  });

  it('a revoked device also forgets the copies of the dossiers and keeps its queue', async () => {
    await store.putServer(serverRow({ uuid: 'other' }) as any);
    await create();
    online.set(true);
    server.post = () => throwError(() => new HttpErrorResponse({ status: 403, error: { code: 'device_revoked' } }));
    await sync.run();
    expect(host.revoked).toBeTrue();
    expect(await store.server('other')).toBeNull();
    expect(await store.counts()).toEqual(jasmine.objectContaining({ waiting: 1 }));
  });

  it('knows how long the oldest unsent operation has been waiting', async () => {
    expect((await store.counts()).oldest).toBeNull();
    const first = await create();
    await create();
    const oldest = (await store.counts()).oldest;
    expect(oldest).toBe((await store.ops())[0].createdAt);
    expect((await countUnsynced(userUuid)).oldest).toBe(oldest);
    expect(first.sync_state).toBe('local');
  });

  it('a page served from the device comes with its date, and is not served any more after a week', async () => {
    online.set(true);
    await call('GET', '/stats/summary/', null, {}, () => of(new HttpResponse({ body: { total: 12 }, status: 200 })));
    expect(cachedAt).toBeNull();                                   // answered by the server: nothing to say
    online.set(false);
    expect((await call('GET', '/stats/summary/')).body.total).toBe(12);
    expect(Date.parse(cachedAt!)).toBeGreaterThan(Date.now() - 60_000);
    const row = (await db.cache.toArray())[0];
    await db.cache.put({ ...row, at: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    const old: any = await call('GET', '/stats/summary/').catch(e => e);
    expect(old.status).toBe(503);                                  // too old: treated as never consulted
  });

  it('never keeps the audit, the accounts and their rights on the device', async () => {
    online.set(true);
    for (const path of ['/audit/', '/users/', '/roles/', '/permissions/', '/devices/']) {
      await call('GET', path, null, {}, () => of(new HttpResponse({ body: { results: [{ username: 'secret' }] }, status: 200 })));
    }
    expect(await db.cache.count()).toBe(0);
    online.set(false);
    const res: any = await call('GET', '/users/').catch(e => e);
    expect([res.status, res.error.detail]).toEqual([503, jasmine.stringContaining('connexion au serveur')]);
  });

  it('reads the dossiers again without decrypting them each time', async () => {
    for (let i = 0; i < 5; i++) await store.putServer(serverRow({ uuid: `m${i}`, reference: `WKR-2026-000${i}` }) as any);
    store.decryptions = 0;
    expect((await call('GET', '/declarations/')).body.count).toBe(5);
    expect(store.decryptions).toBe(5);
    await call('GET', '/declarations/');
    await call('GET', '/inbox/');
    expect(store.decryptions).toBe(5);                              // the next reads cost nothing
    await store.putServer(serverRow({ uuid: 'm0', notes: 'changé' }) as any);   // a new copy is decrypted again, the others are not
    await call('GET', '/declarations/');
    expect(store.decryptions).toBe(6);
  });

  it('measures a secretariat reading thousands of dossiers on the device (first read decrypts, the next ones do not)', async () => {
    const N = 2000;
    const writing = performance.now();
    for (let i = 0; i < N; i++) await store.putServer(serverRow({ uuid: `perf${i}`, reference: `WKR-2026-${String(i).padStart(5, '0')}`, child_name: `Enfant ${i}`, child: { first_names: `Enfant${i}`, last_name: 'Essai', gender: 'F' } }) as any);
    const written = Math.round(performance.now() - writing);
    store.decryptions = 0;
    const cold = performance.now();
    expect((await call('GET', '/declarations/')).body.count).toBe(N);
    const first = Math.round(performance.now() - cold);
    expect(store.decryptions).toBe(N);
    const warm = performance.now();
    await call('GET', '/declarations/');
    await call('GET', '/inbox/');
    const next = Math.round(performance.now() - warm);
    expect(store.decryptions).toBe(N);                                // nothing is decrypted again
    console.log(`[perf] ${N} dossiers: written ${written} ms, first read ${first} ms, next two reads ${next} ms`);
    expect(next).toBeLessThan(2000);                                  // generous: a CI machine is not a phone
    expect(first).toBeLessThan(60_000);
  }, 180_000);

  it('a draft of the entry form is kept encrypted, forgotten after a week, and cleared once saved', async () => {
    await store.saveDraft('new', { m: { notes: 'Observation confidentielle' } });
    expect(JSON.stringify(await db.kv.toArray())).not.toContain('confidentielle');
    expect((await store.loadDraft<any>('new'))!.data.m.notes).toBe('Observation confidentielle');
    expect(await store.loadDraft('autre')).toBeNull();
    await store.setSecret('draft:vieux', { at: new Date(Date.now() - 8 * 86_400_000).toISOString(), data: {} });
    expect(await store.loadDraft('vieux')).toBeNull();
    await store.clearDraft('new');
    expect(await store.loadDraft('new')).toBeNull();
  });

  it('removing a page already on the server needs the connection and says so', async () => {
    const res: any = await call('DELETE', '/documents/11111111-1111-4111-8111-111111111111/').catch(e => e);
    expect([res.status, res.error.detail]).toEqual([503, jasmine.stringContaining('connexion au serveur')]);
  });

  it('a batch refused as a whole slows down that cycle only', async () => {
    await create(); await create();
    online.set(true);
    const post = server.post;
    server.post = (url: string, body: any) => body.operations?.length > 1 ? throwError(() => new HttpErrorResponse({ status: 400, error: { detail: 'trop' } })) : post(url, body);
    await sync.run();
    expect((await store.ops()).map(o => o.status)).toEqual(['applied', 'applied']);   // isolated one by one
    server.post = post;
    await create(); await create();
    await sync.run(true);
    expect(server.pushes[server.pushes.length - 1].operations.length).toBe(2);        // back to normal batches
  });

  it('creates and lists a declaration without any network', async () => {
    const d = await create();
    expect([d.sync_state, d.status]).toEqual(['local', 'DRAFT']);
    expect(d.reference).toMatch(/^LOCAL-/);
    const page = (await call('GET', '/declarations/')).body;
    expect(page.count).toBe(1);
    expect(page.results[0].sync_state).toBe('local');
    expect((await call('GET', `/declarations/${d.uuid}/`)).body.child.first_names).toBe('Aminata');
    expect(await store.counts()).toEqual(jasmine.objectContaining({ waiting: 1, problems: 0 }));
    expect(await countUnsynced(userUuid)).toEqual(jasmine.objectContaining({ waiting: 1, problems: 0 }));  // readable without the key (locked device)
  });

  it('stores nothing readable on the device', async () => {
    const d = await create({ notes: 'Observation confidentielle' });
    await call('POST', '/documents/', form(d.uuid, new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], 'fiche-diallo.jpg', { type: 'image/jpeg' })));
    const raw = JSON.stringify([await db.operations.toArray(), await db.kv.toArray(), (await db.files.toArray()).map(f => ({ ...f, data: null, meta: null }))]);
    for (const secret of ['Aminata', 'Diallo', 'confidentielle', 'Clinique', 'fiche-diallo']) expect(raw).not.toContain(secret);
    const file = (await db.files.toArray())[0];
    expect(new Uint8Array(file.data.ct).slice(0, 3)).not.toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
  });

  it('edits made before the first synchronisation travel in the creation itself', async () => {
    const d = await create();
    await call('PATCH', `/declarations/${d.uuid}/`, { birth_place: 'Kipé' });
    const ops = await store.ops();
    expect(ops.length).toBe(1);
    expect([ops[0].type, ops[0].payload!['birth_place']]).toEqual(['declaration.create', 'Kipé']);
  });

  it('synchronises when the connection returns: reference attributed, indicator « en ligne »', async () => {
    const d = await create();
    await call('POST', `/declarations/${d.uuid}/transition/`, { status: 'TRANSMITTED' });
    expect((await store.view(d.uuid))!.status).toBe('TRANSMITTED');
    online.set(true);
    await sync.run();
    const view = (await store.view(d.uuid))!;
    expect([view.sync_state, view.reference, view.status]).toEqual(['synced', 'WKR-2026-0001', 'TRANSMITTED']);
    expect(await store.counts()).toEqual(jasmine.objectContaining({ waiting: 0, problems: 0 }));
    expect(server.pushes[0].operations.map((o: any) => o.type)).toEqual(['declaration.create', 'declaration.transmit']);
    expect(server.pushes[0].device.id).toBe('device-1');
    expect(server.pushes[0].user).toBe(userUuid);
    // an applied operation keeps no content on the device
    expect((await db.operations.toArray()).every(o => o.status === 'applied' && o.enc === null)).toBeTrue();
  });

  it('a cut during the push loses nothing and creates no duplicate', async () => {
    const d = await create();
    online.set(true);
    server.fail = 'lost-answer';  // the server applied the operation but the answer never arrived
    await sync.run();
    expect((await store.view(d.uuid))!.sync_state).toBe('local');
    expect((await store.ops())[0].status).toBe('pending');
    online.set(true);
    await sync.run();
    expect(server.rows.size).toBe(1);
    expect(server.pushes[1].operations[0].op_id).toBe(server.pushes[0].operations[0].op_id);  // same identifier: the server recognises it
    expect((await store.view(d.uuid))!.sync_state).toBe('synced');
  });

  it('an operation left « sending » by a closed tab is sent again', async () => {
    await create();
    const [pending] = await store.ops();
    pending.status = 'sending';
    await store.saveOp(pending);
    online.set(true);
    await sync.run();
    expect((await store.ops())[0].status).toBe('applied');
  });

  it('does nothing while offline or with an expired session, and keeps the queue', async () => {
    await create();
    await sync.run(true);
    expect(server.pushes.length).toBe(0);
    expect(host.messages[0]).toContain('injoignable');
    online.set(true); expired.set(true);
    await sync.run(true);
    expect(server.pushes.length).toBe(0);
    expect(await store.counts()).toEqual(jasmine.objectContaining({ waiting: 1, problems: 0 }));
  });

  it('a network failure in the middle keeps everything pending', async () => {
    await create();
    online.set(true);
    server.fail = 'network';
    await sync.run();
    expect(await store.counts()).toEqual(jasmine.objectContaining({ waiting: 1, problems: 0 }));
    expect((await store.ops())[0].status).toBe('pending');
    expect(online()).toBeFalse();
  });

  it('a refusal is shown on the dossier, corrected in place and sent again under the same identifier', async () => {
    const d = await create({ birth_place: '' });
    online.set(true);
    server.reject = o => (o.payload?.birth_place === '' ? { status: 'rejected', code: 'validation', detail: 'Le lieu de naissance est requis.' } : null);
    await sync.run();
    let view = (await store.view(d.uuid))!;
    expect([view.sync_state, view.sync_error!.detail, view.can_edit]).toEqual(['error', 'Le lieu de naissance est requis.', true]);
    expect(await store.counts()).toEqual(jasmine.objectContaining({ waiting: 0, problems: 1 }));
    await call('PATCH', `/declarations/${d.uuid}/`, { birth_place: 'Ratoma' });
    expect((await store.ops()).length).toBe(1);
    await sync.run();
    view = (await store.view(d.uuid))!;
    expect([view.sync_state, view.birth_place]).toEqual(['synced', 'Ratoma']);
    expect(server.pushes[1].operations[0].op_id).toBe(server.pushes[0].operations[0].op_id);
  });

  it('a refused dossier does not hold back the others', async () => {
    const bad = await create({ notes: 'bad' });
    const good = await create();
    online.set(true);
    server.reject = o => (o.payload?.notes === 'bad' ? { status: 'rejected', code: 'validation', detail: 'Refusé.' } : null);
    await sync.run();
    expect((await store.view(bad.uuid))!.sync_state).toBe('error');
    expect((await store.view(good.uuid))!.sync_state).toBe('synced');
  });

  it('a version conflict overwrites nothing: the agent re-applies or keeps the server version', async () => {
    const d = await create();
    online.set(true);
    await sync.run();
    online.set(false);
    await call('PATCH', `/declarations/${d.uuid}/`, { birth_place: 'Appareil' });
    server.rows.set(d.uuid, { ...server.rows.get(d.uuid), birth_place: 'Serveur', sync_version: 2 });  // changed elsewhere meanwhile
    online.set(true);
    await sync.run();
    let view = (await store.view(d.uuid))!;
    expect([view.sync_state, view.can_edit, view.sync_error!.code]).toEqual(['conflict', false, 'version_conflict']);
    expect(server.rows.get(d.uuid).birth_place).toBe('Serveur');
    await expectAsync(call('PATCH', `/declarations/${d.uuid}/`, { notes: 'x' })).toBeRejected();

    // 1) re-apply my changes on top of the server's current version
    const [conflict] = await store.liveOps(d.uuid);
    conflict.baseVersion = 2; conflict.status = 'pending'; conflict.error = null;
    await store.saveOp(conflict);
    await sync.run();
    view = (await store.view(d.uuid))!;
    expect([view.sync_state, view.birth_place, server.rows.get(d.uuid).birth_place]).toEqual(['synced', 'Appareil', 'Appareil']);
  });

  it('transmission is checked on the device with the server rule', async () => {
    const d = await create({ birth_time: null });
    const error: any = await call('POST', `/declarations/${d.uuid}/transition/`, { status: 'TRANSMITTED' }).catch(e => e);
    expect(error.status).toBe(400);
    expect(error.error.missing_fields).toEqual(['birth_time']);
    expect(error.error.detail).toContain('heure de naissance');
    expect((await store.ops()).length).toBe(1);
  });

  it('a transmitted dossier is locked on the device too', async () => {
    const d = await create();
    await call('POST', `/declarations/${d.uuid}/transition/`, { status: 'TRANSMITTED' });
    const error: any = await call('PATCH', `/declarations/${d.uuid}/`, { notes: 'x' }).catch(e => e);
    expect(error.status).toBe(403);
    const again: any = await call('POST', `/declarations/${d.uuid}/transition/`, { status: 'TRANSMITTED' }).catch(e => e);
    expect(again.status).toBe(400);
  });

  it('photos are kept encrypted, listed, readable, and sent one by one before the transmission', async () => {
    const d = await create();
    const bytes = new Uint8Array(2000).map((_, i) => (i < 3 ? [0xff, 0xd8, 0xff][i] : i % 251));
    const res = await call('POST', '/documents/', form(d.uuid, new File([bytes], 'fiche.jpg', { type: 'image/jpeg' })));
    expect([res.status, res.body.sync_state, res.body.original_name]).toEqual([201, 'local', 'fiche.jpg']);
    expect(res.body.sha256).toBe(await sha256Hex(bytes.buffer));
    await call('POST', `/declarations/${d.uuid}/transition/`, { status: 'TRANSMITTED' });

    const list = (await call('GET', '/documents/', null, { declaration: d.uuid, kind: 'PAPER_FORM' })).body;
    expect(list.results.map((x: any) => x.uuid)).toEqual([res.body.uuid]);
    const blob = (await call<Blob>('GET', `/documents/${res.body.uuid}/download/`)).body!;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);

    online.set(true);
    await sync.run();
    expect(server.pushes.map(p => p.operations.map((o: any) => o.type))).toEqual([['declaration.create'], ['declaration.transmit']]);
    expect(server.documents).toEqual([{ uuid: res.body.uuid, declaration: d.uuid, sha256: res.body.sha256, bytes: 2000 }]);
    expect(await db.files.count()).toBe(0);  // removed from the device once the server confirmed
    expect((await store.view(d.uuid))!.sync_state).toBe('synced');
  });

  it('refuses a forbidden or too large file before storing it, and lets a waiting photo be removed', async () => {
    const d = await create();
    const exe: any = await call('POST', '/documents/', form(d.uuid, new File([new Uint8Array(10)], 'virus.exe'))).catch(e => e);
    expect(exe.status).toBe(400);
    const big: any = await call('POST', '/documents/', form(d.uuid, new File([new Uint8Array(5 * 1024 * 1024)], 'grande.jpg'))).catch(e => e);
    expect(big.error.file[0]).toContain('trop volumineux');
    const ok = await call('POST', '/documents/', form(d.uuid, new File([new Uint8Array(10)], 'fiche.png', { type: 'image/png' })));
    expect((await call('DELETE', `/documents/${ok.body.uuid}/`)).status).toBe(204);
    expect([await db.files.count(), (await store.ops()).length]).toEqual([0, 1]);
  });

  it('online, the list shows the server page plus what only this device knows', async () => {
    const local = await create();
    online.set(true);
    const serverPage = { count: 1, next: null, previous: null, results: [{ uuid: 'srv-1', reference: 'WKR-2026-0042', status: 'TRANSMITTED' }] };
    const page = (await call('GET', '/declarations/', null, {}, () => of(new HttpResponse({ body: serverPage, status: 200 })))).body;
    expect(page.count).toBe(2);
    expect(page.results.map((r: any) => [r.uuid, r.sync_state])).toEqual([[local.uuid, 'local'], ['srv-1', 'synced']]);
  });

  it('falls back to the device when the server stops answering in the middle of a read', async () => {
    const d = await create();
    online.set(true);
    const page = (await call('GET', '/declarations/')).body;   // the network call fails (status 0)
    expect(page.results[0].uuid).toBe(d.uuid);
    expect(online()).toBeFalse();
    expect((await call('GET', '/hospitals/')).body.results[0].name).toBe('Clinique');
  });

  it('leaves the other endpoints to the network, and keeps what they answered for offline reading', async () => {
    online.set(true);
    const res = await call('GET', '/stats/summary/', null, {}, () => of(new HttpResponse({ body: { count: 1, results: ['réseau'] }, status: 200 })));
    expect(res.body.results).toEqual(['réseau']);
    const validate = await call('POST', '/declarations/00000000-0000-0000-0000-000000000000/transition/', { status: 'VALIDATED' }, {}, () => of(new HttpResponse({ body: 'réseau', status: 200 })));
    expect(validate.body).toBe('réseau');
    online.set(false);
    expect((await call('GET', '/stats/summary/')).body.results).toEqual(['réseau']);    // read again from the device
  });

  it('a revoked device is reported and keeps its queue', async () => {
    await create();
    online.set(true);
    server.post = () => throwError(() => new HttpErrorResponse({ status: 403, error: { code: 'device_revoked' } }));
    await sync.run();
    expect(host.revoked).toBeTrue();
    expect(await store.counts()).toEqual(jasmine.objectContaining({ waiting: 1, problems: 0 }));
  });

  it('receives the facilities and the rules first, even when the dossiers cannot be pulled', async () => {
    await store.setSecret('hospitals', []);
    online.set(true);
    const calls: string[] = [];
    (server as any).get = (url: string) => {
      calls.push(url);
      return url.endsWith('/sync/reference/')
        ? of({ server_time: new Date().toISOString(), offline_enabled: true, hospitals: [{ uuid: 'h9', code: 'NEW', name: 'Maternité du Port' }],
               rules: { required_for_transmission: ['birth_date'], required_for_submission: ['child.nationality'], max_upload_size: 1048576, max_batch: 5 } })
        : throwError(() => new HttpErrorResponse({ status: 500 }));
    };
    await sync.run();
    expect(calls[0]).toContain('/sync/reference/');
    expect((await store.hospitals()).map(h => h.name)).toEqual(['Maternité du Port']);
    const rules = await store.rules();
    expect([rules.required_for_submission, rules.max_batch]).toEqual([['child.nationality'], 5]);
    expect(await store.referenceAt()).not.toBeNull();
    expect(host.messages.at(-1)).toContain('interrompue');       // the pull failed, the reference data are kept anyway
  });

  it('gives the server the recovery code once, and keeps it for the next cycle when the server does not answer', async () => {
    online.set(true);
    const sent: any[] = [];
    let registered = 0;
    let pending: string | null = 'ABCD-EFGH-JKMN-PQRS-TVWX-0123';
    let down = true;
    const plain = server.post;
    server.post = ((url: string, body: any) => {
      if (url.endsWith('/sync/recovery/')) {
        if (down) return throwError(() => new HttpErrorResponse({ status: 0 }));
        sent.push(body);
        return of({ registered: true });
      }
      return plain(url, body);
    }) as any;
    const engine = new SyncEngine(store, server as any, conn, {
      syncing: () => undefined, synced: () => undefined, failed: () => undefined, deviceRevoked: () => undefined, deviceLimit: () => undefined,
      accessLost: () => undefined, signInRequired: () => undefined, changed: () => undefined, sessionExpired: () => false,
      recoveryPending: async () => pending, recoveryRegistered: () => { registered++; pending = null; }, recoveryMissing: () => undefined,
    }, { apiUrl: API, deviceId: 'device-1', deviceLabel: 'Test', userUuid });
    await engine.run();
    expect(registered).toBe(0);                                          // the server did not answer: the code is still waiting
    expect(pending).not.toBeNull();
    down = false;
    await engine.run();
    expect(sent).toEqual([{ device_id: 'device-1', device_label: 'Test', code: 'ABCD-EFGH-JKMN-PQRS-TVWX-0123' }]);
    expect(registered).toBe(1);
    await engine.run();
    expect(sent.length).toBe(1);                                         // nothing waits any more: not sent again
    engine.stop();
  });

  it('learns from the server that it holds no recovery code', async () => {
    online.set(true);
    let missing = 0;
    (server as any).get = () => of({ server_time: new Date().toISOString(), offline_enabled: true, cursor: null, has_more: false, declarations: [], hospitals: [], rules: { required_for_transmission: [], max_upload_size: 1, max_batch: 1 }, recovery_registered: false });
    const engine = new SyncEngine(store, server as any, conn, {
      syncing: () => undefined, synced: () => undefined, failed: () => undefined, deviceRevoked: () => undefined, deviceLimit: () => undefined,
      accessLost: () => undefined, signInRequired: () => undefined, changed: () => undefined, sessionExpired: () => false,
      recoveryMissing: () => { missing++; },
    }, { apiUrl: API, deviceId: 'device-1', deviceLabel: 'Test', userUuid });
    await engine.run();
    expect(missing).toBeGreaterThan(0);
    engine.stop();
  });

  it('an empty list from the server never blanks the facilities already on the device', async () => {
    online.set(true);
    (server as any).get = () => of({ server_time: new Date().toISOString(), offline_enabled: true, cursor: null, has_more: false, declarations: [], hospitals: [], rules: { required_for_transmission: [], max_upload_size: 1, max_batch: 1 } });
    await sync.run();
    expect((await store.hospitals()).map(h => h.name)).toEqual(['Clinique']);
  });

  it('a device that learned the dossiers before the secretariat could use it starts its pull again once', async () => {
    await store.setClear('cursor', '2026-11-12T00:00:00+00:00');
    await store.setClear('schema', 1);
    await store.migrate();
    expect(await store.clear<string | null>('cursor', null)).toBeNull();
    await store.setClear('cursor', '2026-11-13T00:00:00+00:00');
    await store.migrate();                                               // already migrated: the cursor stays
    expect(await store.clear<string | null>('cursor', null)).toBe('2026-11-13T00:00:00+00:00');
  });

  it('keeps the pages it reads online encrypted, and says clearly when a page was never consulted', async () => {
    online.set(true);
    await call('GET', '/stats/summary/', null, {}, () => of(new HttpResponse({ body: { total: 12, secret: 'Confidentiel' }, status: 200 })));
    online.set(false);
    expect((await call('GET', '/stats/summary/')).body.total).toBe(12);
    expect(JSON.stringify(await db.cache.toArray())).not.toContain('Confidentiel');
    const never: any = await call('GET', '/actes/').catch(e => e);
    expect([never.status, never.error.detail]).toEqual([503, jasmine.stringContaining('première consultation')]);
  });

  it('refuses, with a reason, what cannot be queued (users, roles, settings, decisions on duplicates)', async () => {
    const res: any = await call('POST', '/users/', { username: 'x' }).catch(e => e);
    expect([res.status, res.error.detail]).toEqual([503, jasmine.stringContaining('connexion au serveur')]);
  });

  for (const code of ['device_binding_required', 'device_mismatch']) {
    it(`asks for a new sign-in when the session is not bound to this device (${code}) and keeps the queue`, async () => {
      await create();
      online.set(true);
      server.post = () => throwError(() => new HttpErrorResponse({ status: 403, error: { code, detail: 'Reconnectez-vous.' } }));
      await sync.run();
      expect(host.signIn).toBe(1);
      expect(host.messages.at(-1)).toContain('Reconnectez-vous');
      expect(await store.counts()).toEqual(jasmine.objectContaining({ waiting: 1, problems: 0 }));
    });
  }
});

function form(declaration: string, file: File): FormData {
  const fd = new FormData();
  fd.append('declaration', declaration); fd.append('kind', 'PAPER_FORM'); fd.append('file', file);
  return fd;
}

/* ───────────────────────── secretariat, validators, administrator ───────────────────────── */

describe('Offline mode for the other roles', () => {
  const D1 = '11111111-1111-4111-8111-111111111111';
  const D2 = '22222222-2222-4222-8222-222222222222';
  const A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const BACK_OFFICE = ['declaration.view', 'declaration.view_all', 'acte.view', 'acte.update', 'acte.submit', 'document.upload', 'dossier.validate', 'dossier.reject', 'hospital.view'];
  const HEADER = { uuid: A1, declaration_uuid: D1, registre: '', feuillet: '', annee: 2026, numero_acte: null, declaration_date: null, can_edit: true };
  const DECLARANT = { first_names: 'Mamadou', last_name: 'Diallo', relationship: 'Père' };

  let db: OfflineDb, store: OfflineStore, api: LocalApi, userUuid: string, perms: string[];
  const online = signal(false);
  const conn: any = { online, offlineEnabled: signal(true), changes: new Subject<boolean>(), check: async () => online(), reportFailure: () => online.set(false), start: () => undefined };
  const offlineNext = () => throwError(() => new HttpErrorResponse({ status: 0 }));
  const reached = (body: any) => () => of(new HttpResponse({ body, status: 200 }));
  const call = async (method: string, path: string, body: any = null, next: any = offlineNext) =>
    (await firstValueFrom(api.handle(new HttpRequest<any>(method as any, API + path, body, { params: new HttpParams() }), next))) as HttpResponse<any>;
  const refused = (method: string, path: string, body: any = null) => call(method, path, body).then(() => null as any, (e: any) => e);

  const seed = async (over: Record<string, any> = {}) => {
    await store.putServer(serverRow({ uuid: D1, status: 'TRANSMITTED', acte_uuid: A1, acte: { ...HEADER }, sync_version: 4, can_edit: false, ...over }) as any);
  };

  beforeEach(async () => {
    userUuid = `back-${Math.random().toString(36).slice(2)}`;
    online.set(false); perms = [...BACK_OFFICE];
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    db = new OfflineDb(userUuid);
    store = new OfflineStore(db, key, () => ({ userName: 'Secrétaire Test', userUuid: 'me-user', canUpdate: false, canTransmit: false, can: (p: string) => perms.includes(p), today: '2026-11-17' }));
    await store.setSecret('hospitals', ctx.hospitals);
    await store.setSecret('rules', { required_for_transmission: ['birth_date'], required_for_submission: ['declarant.first_names', 'acte.registre'], expected_for_validation: ['child.nationality'], max_upload_size: 4194304, max_batch: 20 });
    api = new LocalApi(store, conn, {
      apiUrl: API, userName: () => 'Secrétaire Test', sessionExpired: () => false, changed: () => undefined,
      can: p => perms.includes(p), localFirst: () => false,
    });
  });
  afterEach(async () => { db.close(); await deleteDb(userUuid); });

  it('separation of duties: whoever sent the dossier to validation cannot validate it, on the device either', async () => {
    await store.setSecret('rules', { required_for_transmission: ['birth_date'], required_for_submission: [], expected_for_validation: [], max_upload_size: 4194304, max_batch: 20, separate_submit_and_validate: true });
    await seed({ status: 'PENDING_VALIDATION', status_history: [{ from_status: 'TRANSMITTED', to_status: 'PENDING_VALIDATION', changed_by: 'me-user', changed_by_name: 'Moi', changed_at: '2026-11-16T10:00:00Z', reason: '' }] });
    const view = (await call('GET', `/declarations/${D1}/`)).body;
    expect(view.available_transitions.map((t: any) => t.target)).not.toContain('VALIDATED');
    const error = await refused('POST', `/declarations/${D1}/transition/`, { status: 'VALIDATED', annee: 2026, numero_acte: '12' });
    expect(error.status).toBe(403);
    expect(error.error.detail).toContain('Séparation des tâches');
    expect(await store.liveOps(D1)).toEqual([]);
    // somebody else sent it: the validation is offered
    await seed({ status: 'PENDING_VALIDATION', status_history: [{ from_status: 'TRANSMITTED', to_status: 'PENDING_VALIDATION', changed_by: 'someone-else', changed_by_name: 'Autre', changed_at: '2026-11-16T10:00:00Z', reason: '' }] });
    expect((await call('GET', `/declarations/${D1}/`)).body.available_transitions.map((t: any) => t.target)).toContain('VALIDATED');
  });

  it('separation of duties: a step taken on the device counts as submitted by this user, and the rule can be off', async () => {
    await store.setSecret('rules', { required_for_transmission: ['birth_date'], required_for_submission: [], expected_for_validation: [], max_upload_size: 4194304, max_batch: 20, separate_submit_and_validate: true });
    await seed({ status: 'TRANSMITTED' });
    await call('POST', `/declarations/${D1}/transition/`, { status: 'PENDING_VALIDATION' });
    const view = (await call('GET', `/declarations/${D1}/`)).body;
    expect(view.status).toBe('PENDING_VALIDATION');
    expect(view.available_transitions.map((t: any) => t.target)).not.toContain('VALIDATED');
    await store.setSecret('rules', { required_for_transmission: ['birth_date'], required_for_submission: [], expected_for_validation: [], max_upload_size: 4194304, max_batch: 20, separate_submit_and_validate: false });
    expect((await call('GET', `/declarations/${D1}/`)).body.available_transitions.map((t: any) => t.target)).toContain('VALIDATED');
  });

  it('mirrors the workflow of the server: each role sees the steps it could take online', () => {
    const can = (list: string[]) => (p: string) => list.includes(p);
    expect(userTransitions('TRANSMITTED', can(BACK_OFFICE), false).map(t => t.target)).toEqual(['PENDING_VALIDATION']);
    expect(userTransitions('PENDING_VALIDATION', can(BACK_OFFICE), false).map(t => t.target)).toEqual(['VALIDATED', 'TO_CORRECT_COLLECTION', 'TO_CORRECT_SECRETARIAT', 'REJECTED']);
    expect(userTransitions('PENDING_VALIDATION', can(['acte.submit']), false)).toEqual([]);          // no right to decide
    expect(userTransitions('PENDING_VALIDATION', can(BACK_OFFICE), true)).toEqual([]);               // six-month rule
    expect(userTransitions('VALIDATED', can(BACK_OFFICE), false)).toEqual([]);                       // frozen
    expect(WORKFLOW.filter(t => t.reason_required).map(t => t.target)).toEqual(['TO_CORRECT_COLLECTION', 'TO_CORRECT_SECRETARIAT', 'REJECTED']);
  });

  it('offline, the secretariat completes the registry header of a transmitted dossier', async () => {
    await seed();
    const view = (await call('GET', `/declarations/${D1}/`)).body;
    expect(view.can_edit).toBeTrue();                          // the secretariat may edit a transmitted dossier
    const res = await call('PATCH', `/declarations/${D1}/`, { doctor_name: 'Dr Corrigé', acte: { registre: 'R7', feuillet: '12' } });
    expect(res.body.doctor_name).toBe('Dr Corrigé');
    const [queued] = await store.ops();
    expect([queued.type, queued.baseVersion, queued.payload!['acte']]).toEqual(['declaration.update', 4, { registre: 'R7', feuillet: '12' }]);
    const header = (await call('GET', `/actes/${A1}/`)).body;     // the registry screen reads what waits on the device
    expect([header.registre, header.feuillet, header.uuid]).toEqual(['R7', '12', A1]);
    // a second edit before sending rides on the same operation
    await call('PATCH', `/declarations/${D1}/`, { acte: { registre: 'R8' } });
    expect((await store.ops()).length).toBe(1);
    expect((await store.ops())[0].payload!['acte']).toEqual({ registre: 'R8', feuillet: '12' });
  });

  it('a collection device never carries the registry header', async () => {
    perms = ['declaration.view', 'declaration.update', 'declaration.transmit'];
    await seed({ status: 'DRAFT' });
    await call('PATCH', `/declarations/${D1}/`, { notes: 'ok', acte: { registre: 'R7' } });
    expect((await store.ops())[0].payload).toEqual({ notes: 'ok' });
  });

  it('online, the secretariat works on the server as before and nothing is queued', async () => {
    await seed();
    online.set(true);
    const answer = serverRow({ uuid: D1, status: 'TRANSMITTED', doctor_name: 'Dr Serveur', sync_version: 5 });
    const res = await call('PATCH', `/declarations/${D1}/`, { doctor_name: 'Dr Serveur' }, reached(answer));
    expect(res.body.doctor_name).toBe('Dr Serveur');
    expect(await store.ops()).toEqual([]);
    expect(((await store.server(D1)) as any).sync_version).toBe(5);        // the copy of the device follows
    expect(((await store.server(D1)) as any).acte.uuid).toBe(A1);         // … without losing the registry header
  });

  it('online but the server stops answering during the write: the operation is queued, not lost', async () => {
    await seed();
    online.set(true);
    await call('PATCH', `/declarations/${D1}/`, { doctor_name: 'Dr Coupé' });
    expect((await store.ops()).map(o => o.type)).toEqual(['declaration.update']);
    expect(online()).toBeFalse();
  });

  it('a dossier with operations waiting keeps going through the queue, even online', async () => {
    await seed();
    await call('PATCH', `/declarations/${D1}/`, { doctor_name: 'Avant' });
    online.set(true);
    let reachedServer = false;
    await call('PATCH', `/declarations/${D1}/`, { notes: 'Après' }, () => { reachedServer = true; return of(new HttpResponse({ body: {}, status: 200 })); });
    expect(reachedServer).toBeFalse();
    expect((await store.ops())[0].payload).toEqual({ doctor_name: 'Avant', notes: 'Après' });
  });

  it('submits to validation only when the required data are there, then shows the dossier as submitted', async () => {
    await seed();
    const early = await refused('POST', `/declarations/${D1}/transition/`, { status: 'PENDING_VALIDATION' });
    expect([early.status, early.error.detail]).toEqual([400, jasmine.stringContaining('registre')]);
    await call('PATCH', `/declarations/${D1}/`, { declarant: DECLARANT, acte: { registre: 'R7' } });
    const res = await call('POST', `/declarations/${D1}/transition/`, { status: 'PENDING_VALIDATION' });
    expect(res.body.status).toBe('PENDING_VALIDATION');
    expect(res.body.available_transitions.map((t: any) => t.target)).toEqual(['VALIDATED', 'TO_CORRECT_COLLECTION', 'TO_CORRECT_SECRETARIAT', 'REJECTED']);
    const ops = await store.ops();
    expect(ops.map(o => o.type)).toEqual(['declaration.update', 'declaration.transition']);
    // taken on top of the device's own change: no version guard, but the step it saw is recorded
    expect([ops[1].baseVersion, ops[1].payload!['from_status'], ops[1].payload!['status']]).toEqual([null, 'TRANSMITTED', 'PENDING_VALIDATION']);
  });

  it('a decision taken on the dossier as pulled carries the version and the step it saw', async () => {
    await seed({ status: 'PENDING_VALIDATION', declarant: DECLARANT });
    await call('POST', `/declarations/${D1}/transition/`, { status: 'TO_CORRECT_COLLECTION', reason: 'Date illisible' });
    const [decision] = await store.ops();
    expect([decision.baseVersion, decision.payload]).toEqual([4, { status: 'TO_CORRECT_COLLECTION', reason: 'Date illisible', from_status: 'PENDING_VALIDATION' }]);
    expect((await store.view(D1))!.status).toBe('TO_CORRECT_COLLECTION');
    expect((await store.view(D1))!.status_history[0].reason).toBe('Date illisible');
  });

  it('sending back or rejecting needs a reason; an impossible step is refused like online', async () => {
    await seed({ status: 'PENDING_VALIDATION' });
    const noReason = await refused('POST', `/declarations/${D1}/transition/`, { status: 'REJECTED' });
    expect([noReason.status, noReason.error.reason[0]]).toEqual([400, 'Un motif est obligatoire pour cette décision.']);
    const impossible = await refused('POST', `/declarations/${D1}/transition/`, { status: 'DELIVERED' });
    expect([impossible.status, impossible.error.code]).toEqual([400, 'invalid_transition']);
    expect(await store.ops()).toEqual([]);
  });

  it('final validation asks for the official number, then for the confirmation when expected fields are empty', async () => {
    await seed({ status: 'PENDING_VALIDATION', acte: { ...HEADER, annee: null } });
    const noYear = await refused('POST', `/declarations/${D1}/transition/`, { status: 'VALIDATED' });
    expect(noYear.error.annee[0]).toContain('année');
    const noNumber = await refused('POST', `/declarations/${D1}/transition/`, { status: 'VALIDATED', annee: 2026 });
    expect(noNumber.error.numero_acte[0]).toContain('numéro officiel');
    const warned = await refused('POST', `/declarations/${D1}/transition/`, { status: 'VALIDATED', annee: 2026, registre: 'R1', numero_acte: '4521' });
    expect([warned.status, warned.error.code, warned.error.missing_fields]).toEqual([409, 'incomplete_confirmation_required', ['child.nationality']]);
    expect(await store.ops()).toEqual([]);                                  // nothing is queued before the confirmation
    const done = await call('POST', `/declarations/${D1}/transition/`, { status: 'VALIDATED', annee: 2026, registre: 'R1', numero_acte: '4521', accept_incomplete: true });
    expect([done.body.status, done.body.official_number, done.body.available_transitions]).toEqual(['VALIDATED', '4521', []]);
    expect((await store.ops())[0].payload).toEqual(jasmine.objectContaining({ status: 'VALIDATED', numero_acte: '4521', annee: 2026, accept_incomplete: true, from_status: 'PENDING_VALIDATION' }));
  });

  it('a step the server refused is replaced by the new attempt, not stacked', async () => {
    await seed({ status: 'PENDING_VALIDATION' });
    await call('POST', `/declarations/${D1}/transition/`, { status: 'TO_CORRECT_SECRETARIAT', reason: 'Nom à vérifier' });
    const [first] = await store.ops();
    first.status = 'rejected'; first.error = { code: 'forbidden', detail: 'Refusé' };
    await store.saveOp(first);
    expect((await store.view(D1))!.status).toBe('PENDING_VALIDATION');    // a refused step does not show as taken
    await call('POST', `/declarations/${D1}/transition/`, { status: 'REJECTED', reason: 'Doublon avéré' });
    expect((await store.ops()).map(o => (o.payload as any).status)).toEqual(['REJECTED']);
  });

  it('the six-month rule locks the dossier on the device for whoever may not override it', async () => {
    await seed({ deadline: { months: 6, reference_date: '2026-03-01', deadline_date: '2026-09-01', applies: true, overdue: true, days_over: 77, message: 'Ce dossier date de plus de 6 mois : il doit être traité aux tribunaux.', can_override: false } });
    const view = (await call('GET', `/declarations/${D1}/`)).body;
    expect([view.can_edit, view.available_transitions, view.overdue]).toEqual([false, [], true]);
    const edit = await refused('PATCH', `/declarations/${D1}/`, { notes: 'x' });
    expect([edit.status, edit.error.detail]).toEqual([403, jasmine.stringContaining('tribunaux')]);
    const step = await refused('POST', `/declarations/${D1}/transition/`, { status: 'PENDING_VALIDATION' });
    expect(step.status).toBe(400);
    perms = [...BACK_OFFICE, 'dossier.override_deadline'];                  // the administrator keeps the hand
    expect((await call('GET', `/declarations/${D1}/`)).body.can_edit).toBeTrue();
  });

  it('lists the dossiers it holds with the filters of the secretariat, without any network', async () => {
    await seed({ status: 'PENDING_VALIDATION' });
    await store.putServer(serverRow({ uuid: D2, reference: 'WKR-2026-0002', status: 'TRANSMITTED', deadline: { deadline_date: '2026-01-01', applies: true, overdue: true } }) as any);
    const list = async (query: string) => (await firstValueFrom(api.handle(new HttpRequest<any>('GET', `${API}/declarations/?${query}`, null, { params: new HttpParams({ fromString: query }) }), offlineNext)) as HttpResponse<any>).body;
    expect((await list('status=PENDING_VALIDATION')).results.map((r: any) => r.uuid)).toEqual([D1]);
    expect((await list('overdue=true')).results.map((r: any) => r.uuid)).toEqual([D2]);
    expect((await list('overdue=true')).results[0].overdue).toBeTrue();
    expect((await list('page_size=1')).results.length).toBe(1);
  });

  it('the pending documents of a dossier of the secretariat are queued like the agent\'s', async () => {
    await seed();
    const fd = new FormData();
    fd.append('declaration', D1); fd.append('kind', 'OTHER'); fd.append('file', new File([new Uint8Array(10)], 'piece.pdf', { type: 'application/pdf' }));
    const res = await call('POST', '/documents/', fd);
    expect(res.status).toBe(201);
    expect((await store.ops()).map(o => o.type)).toEqual(['document.upload']);
  });
});


/* ───────────────────────── emergency backup ───────────────────────── */

describe('Emergency backup of the unsent work', () => {
  const U = { uuid: 'backup-user', username: 'agent', name: 'Agent Test' };
  let key: CryptoKey, db: OfflineDb, store: OfflineStore;

  beforeEach(async () => {
    writeVaultHeader(null);
    await deleteDb(U.uuid);
    key = await createVault('482915aB', U, FAST);
    db = new OfflineDb(U.uuid);
    store = new OfflineStore(db, key, () => ({ userName: 'Agent Test', canUpdate: true, canTransmit: true }));
  });
  afterEach(async () => { db.close(); await deleteDb(U.uuid); writeVaultHeader(null); });

  const makeBackup = async () => {
    await store.addOp('dossier-1', 'declaration.create', { payload: payload({ notes: 'Observation confidentielle' }) });
    const stored = await store.putFile('dossier-1', 'PAPER_FORM', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 9, 9])], { type: 'image/jpeg' }), 'fiche.jpg');
    await store.addOp('dossier-1', 'document.upload', { fileId: stored.id, payload: { kind: 'PAPER_FORM' } });
    const done = await store.addOp('dossier-0', 'declaration.create', { payload: payload() });
    await store.saveOp({ ...done, status: 'applied' });
    return { blob: await exportBackup(db), fileId: stored.id };
  };

  it('keeps only what is not sent yet, still encrypted', async () => {
    const { blob } = await makeBackup();
    const text = await blob.text();
    for (const secret of ['Aminata', 'Diallo', 'confidentielle', 'fiche.jpg']) expect(text).not.toContain(secret);
    const body = JSON.parse(text);
    expect(body.operations.length).toBe(2);                     // the applied one is not part of it
    expect(body.files.length).toBe(1);
    expect(body.header.user.uuid).toBe(U.uuid);
    expect(backupFileName(new Date(2026, 10, 7))).toBe('wakara-sauvegarde-2026-11-07.wkr');
  });

  it('brings the work back after the browser data were erased, opened by the original code only', async () => {
    const { blob, fileId } = await makeBackup();
    const text = await blob.text();
    db.close(); await deleteDb(U.uuid); writeVaultHeader(null);          // « clear site data »
    expect((await countUnsynced(U.uuid)).waiting).toBe(0);

    await restoreBackup(text);
    expect(readVaultHeader()!.user.uuid).toBe(U.uuid);
    expect(await countUnsynced(U.uuid)).toEqual(jasmine.objectContaining({ waiting: 2, problems: 0 }));
    await expectAsync(openVault('mauvais code 1')).toBeRejected();
    const restoredKey = await openVault('482915aB');
    db = new OfflineDb(U.uuid);
    store = new OfflineStore(db, restoredKey, () => ({ userName: 'Agent Test', canUpdate: true, canTransmit: true }));
    const ops = await store.ops();
    expect(ops.map(o => o.type)).toEqual(['declaration.create', 'document.upload']);
    expect(ops[0].payload!['notes']).toBe('Observation confidentielle');
    const file = await store.file(fileId);
    expect(file?.name).toBe('fiche.jpg');
    expect(new Uint8Array(await (await store.fileBlob(fileId))!.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 9, 9]));
  });

  it('refuses a file that is not a backup, and a device that already has a code', async () => {
    const { blob } = await makeBackup();
    await expectAsync(restoreBackup('pas une sauvegarde')).toBeRejectedWithError(BackupError, /pas une sauvegarde/);
    await expectAsync(restoreBackup(JSON.stringify({ kind: 'autre', v: 1 }))).toBeRejectedWithError(BackupError, /pas une sauvegarde/);
    await expectAsync(restoreBackup(await blob.text())).toBeRejectedWithError(BackupError, /déjà protégé/);   // the vault of this device is still there
  });
});
