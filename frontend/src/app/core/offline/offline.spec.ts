import { HttpErrorResponse, HttpParams, HttpRequest, HttpResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { Subject, firstValueFrom, of, throwError } from 'rxjs';
import { decryptJson, encryptJson, sha256Hex } from './crypto';
import { OfflineDb, countUnsynced, deleteDb } from './db';
import { LocalApi } from './local-api';
import { localReference, materialize, mergeWrite, missingForTransmission, syncStateOf } from './materialize';
import { OfflineStore } from './store';
import { SyncEngine } from './sync';
import { LocalDeclaration, Op, PushResult } from './types';
import { PinError, changeVaultPin, createVault, destroyVault, loadVaultSession, openVault, pinProblem, saveVaultSession } from './vault';
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
    expect(pinProblem('12345')).toContain('au moins 6');
    expect(pinProblem('000000')).toContain('trop simple');
    expect(pinProblem('123456')).toContain('trop simple');
    expect(pinProblem('482915')).toBe('');
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
  });

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
    expect('acte' in merged).toBeFalse();
  });

  it('mirrors the transmission rule of the server', () => {
    const d = materialize('d1', null, [op({ payload: payload({ birth_time: null, child: { gender: '' } }) })], ctx)!;
    expect(missingForTransmission(d, ['birth_date', 'birth_time', 'birth_place', 'child.gender', 'mother.name', 'father.name', 'acte.registre']))
      .toEqual(['birth_time', 'child.gender', 'father.name']);
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
  get = (_url: string, _options?: any) => of({
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
    else if (o.type === 'declaration.update' && row && o.base_version !== row.sync_version) {
      result = { ...base, status: 'conflict', error: { code: 'version_conflict', detail: 'Le dossier a changé.' }, declaration: row };
    } else {
      if (o.type === 'declaration.create' && !row) row = serverRow({ uuid: o.entity_uuid, reference: `WKR-2026-${String(++this.counter).padStart(4, '0')}`, ...o.payload });
      else if (o.type === 'declaration.update') row = { ...row, ...o.payload, child: { ...row.child, ...(o.payload.child ?? {}) }, sync_version: row.sync_version + 1 };
      else if (o.type === 'declaration.transmit') row = { ...row, status: 'TRANSMITTED', status_label: 'Transmis au secrétariat', sync_version: row.sync_version + 1 };
      this.rows.set(o.entity_uuid, row);
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
  let host: { messages: string[]; revoked: boolean };
  const conn: any = { online, offlineEnabled: signal(true), changes: new Subject<boolean>(), check: async () => online(), reportFailure: () => online.set(false), start: () => undefined };
  const offlineNext = () => throwError(() => new HttpErrorResponse({ status: 0 }));

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
    host = { messages: [], revoked: false };
    sync = new SyncEngine(store, server as any, conn, {
      syncing: () => undefined, synced: () => undefined, failed: m => host.messages.push(m), deviceRevoked: () => { host.revoked = true; },
      changed: () => undefined, sessionExpired: () => expired(),
    }, { apiUrl: API, deviceId: 'device-1', deviceLabel: 'Test', userUuid });
    api = new LocalApi(store, conn, { apiUrl: API, userName: () => 'Agent Test', sessionExpired: () => expired(), changed: () => undefined });
  });
  afterEach(async () => { sync.stop(); db.close(); await deleteDb(userUuid); });

  it('creates and lists a declaration without any network', async () => {
    const d = await create();
    expect([d.sync_state, d.status]).toEqual(['local', 'DRAFT']);
    expect(d.reference).toMatch(/^LOCAL-/);
    const page = (await call('GET', '/declarations/')).body;
    expect(page.count).toBe(1);
    expect(page.results[0].sync_state).toBe('local');
    expect((await call('GET', `/declarations/${d.uuid}/`)).body.child.first_names).toBe('Aminata');
    expect(await store.counts()).toEqual({ waiting: 1, problems: 0 });
    expect(await countUnsynced(userUuid)).toEqual({ waiting: 1, problems: 0 });  // readable without the key (locked device)
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
    expect(await store.counts()).toEqual({ waiting: 0, problems: 0 });
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
    expect(await store.counts()).toEqual({ waiting: 1, problems: 0 });
  });

  it('a network failure in the middle keeps everything pending', async () => {
    await create();
    online.set(true);
    server.fail = 'network';
    await sync.run();
    expect(await store.counts()).toEqual({ waiting: 1, problems: 0 });
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
    expect(await store.counts()).toEqual({ waiting: 0, problems: 1 });
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

  it('leaves the other endpoints to the network', async () => {
    const res = await call('GET', '/users/', null, {}, () => of(new HttpResponse({ body: 'réseau', status: 200 })));
    expect(res.body).toBe('réseau');
    const validate = await call('POST', '/declarations/00000000-0000-0000-0000-000000000000/transition/', { status: 'VALIDATED' }, {}, () => of(new HttpResponse({ body: 'réseau', status: 200 })));
    expect(validate.body).toBe('réseau');
  });

  it('a revoked device is reported and keeps its queue', async () => {
    await create();
    online.set(true);
    server.post = () => throwError(() => new HttpErrorResponse({ status: 403, error: { code: 'device_revoked' } }));
    await sync.run();
    expect(host.revoked).toBeTrue();
    expect(await store.counts()).toEqual({ waiting: 1, problems: 0 });
  });
});

function form(declaration: string, file: File): FormData {
  const fd = new FormData();
  fd.append('declaration', declaration); fd.append('kind', 'PAPER_FORM'); fd.append('file', file);
  return fd;
}
