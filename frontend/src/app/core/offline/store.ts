/**
 * Encrypted storage of the offline mode: the operation queue, the dossiers received from the server, the
 * photos waiting to be sent and the reference data. Every content goes through the data key of the vault.
 */
import { DeclarationDetail } from '../models';
import { decryptBytes, decryptJson, encryptBytes, encryptJson, sha256Hex, uuid as newUuid } from './crypto';
import { OfflineDb, oldestUnsynced } from './db';
import { ViewContext, materialize } from './materialize';
import {
  DEFAULT_RULES, FileMeta, FileRow, HospitalRef, LocalDeclaration, LogRow, Op, OpRow, OpSecret, OpType, SyncRules,
} from './types';

/** Applied operations stay in the history this long, then are removed (their content is dropped at once). */
export const RETENTION_DAYS = 7;
/** Shape of what is kept on the device (see ``migrate``). */
export const SCHEMA_VERSION = 2;
/** Pages kept for offline reading, the oldest consulted ones go first. */
export const CACHE_LIMIT = 250;
const CACHE_MAX_BYTES = 1_500_000;
const LOG_LIMIT = 200;

export interface StoredFile { id: string; entity: string; kind: string; size: number; createdAt: string; name: string; mime: string; sha256: string; }

export class OfflineStore {
  constructor(readonly db: OfflineDb, private key: CryptoKey, private context: () => Omit<ViewContext, 'hospitals' | 'separateDuties'>) {}

  /* ── key / value ── */
  async clear<T>(key: string, fallback: T): Promise<T> { return ((await this.db.kv.get(key))?.value as T) ?? fallback; }
  setClear(key: string, value: unknown) { return this.db.kv.put({ key, value }); }
  async secret<T>(key: string, fallback: T): Promise<T> {
    const row = await this.db.kv.get(`enc:${key}`);
    if (!row) return fallback;
    try { return await decryptJson<T>(this.key, row.value); } catch { return fallback; }
  }
  async setSecret(key: string, value: unknown) { await this.db.kv.put({ key: `enc:${key}`, value: await encryptJson(this.key, value) }); }

  hospitals() { return this.secret<HospitalRef[]>('hospitals', []); }
  /** Rules mirrored from the server; what an older server does not send keeps its default. */
  async rules(): Promise<SyncRules> { return { ...DEFAULT_RULES, ...(await this.secret<Partial<SyncRules>>('rules', {})) }; }

  /**
   * A device that learned dossiers before the secretariat could use it holds copies without their registry header:
   * the next pull starts again from the beginning once, so that every dossier is received in its present shape.
   */
  async migrate() {
    if ((await this.clear<number>('schema', 1)) >= SCHEMA_VERSION) return;
    await this.db.kv.delete('cursor');
    await this.setClear('schema', SCHEMA_VERSION);
  }

  /* ── dossiers received from the server ── */
  async server(uuid: string): Promise<DeclarationDetail | null> {
    const row = await this.db.declarations.get(uuid);
    return row ? decryptJson<DeclarationDetail>(this.key, row.enc) : null;
  }
  async putServer(detail: DeclarationDetail) {
    const clean = { ...(detail as any) };
    delete clean.sync_state; delete clean.sync_error;
    // the usual detail does not carry the registry header (only the pull and /actes/ do): keep the one already known
    if (!clean.acte) { const previous = await this.server(detail.uuid) as any; if (previous?.acte) clean.acte = previous.acte; }
    await this.db.declarations.put({ uuid: detail.uuid, onServer: 1, updatedAt: detail.updated_at, enc: await encryptJson(this.key, clean) });
    // the registry header is fetched by its own identifier: remember which dossier holds it (identifiers only)
    if (detail.acte_uuid) await this.db.kv.put({ key: `acte:${detail.acte_uuid}`, value: detail.uuid });
  }
  dropServer(uuid: string) { return this.db.declarations.delete(uuid); }
  /** The registry header just read online replaces the copy of the dossier that holds it. */
  async putActe(acteUuid: string, acte: unknown): Promise<void> {
    const declaration = await this.declarationOfActe(acteUuid);
    const row = declaration ? await this.server(declaration) as any : null;
    if (row) await this.putServer({ ...row, acte });
  }
  async declarationOfActe(acteUuid: string): Promise<string | null> {
    return ((await this.db.kv.get(`acte:${acteUuid}`))?.value as string | undefined) ?? null;
  }

  /* ── pages consulted online, read again without connection ── */
  async cachePut(address: string, body: unknown): Promise<void> {
    const json = JSON.stringify(body);
    if (json.length > CACHE_MAX_BYTES) return;           // a huge answer (export, long journal) is not worth keeping
    const key = await sha256Hex(new TextEncoder().encode(address).buffer as ArrayBuffer);
    await this.db.cache.put({ key, at: new Date().toISOString(), enc: await encryptJson(this.key, { address, body }) });
    const extra = (await this.db.cache.count()) - CACHE_LIMIT;
    if (extra > 0) await this.db.cache.orderBy('at').limit(extra).delete();
  }
  async cacheGet(address: string): Promise<{ body: unknown; at: string } | null> {
    const key = await sha256Hex(new TextEncoder().encode(address).buffer as ArrayBuffer);
    const row = await this.db.cache.get(key);
    if (!row) return null;
    try { return { body: (await decryptJson<{ body: unknown }>(this.key, row.enc)).body, at: row.at }; } catch { return null; }
  }

  /* ── operation queue ── */
  private async open(row: OpRow): Promise<Op> {
    const secret: OpSecret = row.enc ? await decryptJson<OpSecret>(this.key, row.enc) : {};
    const { enc: _enc, ...clear } = row;
    return { ...clear, seq: row.seq!, payload: secret.payload, error: secret.error ?? null };
  }
  async ops(entity?: string): Promise<Op[]> {
    const rows = entity ? await this.db.operations.where('entity').equals(entity).sortBy('seq') : await this.db.operations.orderBy('seq').toArray();
    return Promise.all(rows.map(r => this.open(r)));
  }
  async liveOps(entity: string): Promise<Op[]> { return (await this.ops(entity)).filter(o => o.status !== 'applied'); }

  async addOp(entity: string, type: OpType, extra: { payload?: Record<string, any>; baseVersion?: number | null; fileId?: string } = {}): Promise<Op> {
    const now = new Date().toISOString();
    const row: OpRow = {
      opId: newUuid(), entity, type, status: 'pending', attempts: 0, deviceTime: now, createdAt: now, updatedAt: now,
      fileId: extra.fileId ?? null, baseVersion: extra.baseVersion ?? null,
      enc: await encryptJson(this.key, { payload: extra.payload ?? {} } as OpSecret),
    };
    row.seq = await this.db.operations.add(row);
    return this.open(row);
  }

  /** Writes an operation back (state, attempts, content). An applied operation loses its content at once. */
  async saveOp(op: Op) {
    const { payload, error, ...clear } = op;
    const applied = op.status === 'applied';
    const row: OpRow = {
      ...clear, updatedAt: new Date().toISOString(), errorCode: error?.code ?? '',
      enc: applied ? null : await encryptJson(this.key, { payload, error } as OpSecret),
    };
    await this.db.operations.put(row);
  }
  removeOp(seq: number) { return this.db.operations.delete(seq); }

  /** After a crash or a closed tab, « sending » means « answer unknown »: sending again is safe (idempotent). */
  resetSending() { return this.db.operations.where('status').equals('sending').modify({ status: 'pending' }); }

  async purge() {
    const limit = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
    await this.db.operations.where('status').equals('applied').filter(o => (o.appliedAt ?? o.updatedAt) < limit).delete();
    const extra = (await this.db.log.count()) - LOG_LIMIT;
    if (extra > 0) await this.db.log.orderBy('id').limit(extra).delete();
  }

  /** When the facilities and rules were last received (reference data). */
  referenceAt() { return this.clear<string | null>('referenceAt', null); }

  async counts(): Promise<{ waiting: number; problems: number; oldest: string | null }> {
    const waiting = await this.db.operations.where('status').anyOf('pending', 'sending').count();
    const problems = await this.db.operations.where('status').anyOf('rejected', 'conflict').count();
    return { waiting, problems, oldest: await oldestUnsynced(this.db) };
  }

  /**
   * The user lost the right to work on these dossiers (role withdrawn, device revoked): the copies of the dossiers
   * and the pages kept for reading are erased. What is still to be sent (operations, photos) stays: it is the user's
   * own work and can be sent again, or exported, once the access is restored.
   */
  async wipeCopies() {
    await this.db.declarations.clear();
    await this.db.cache.clear();
    for (const key of await this.db.kv.toCollection().primaryKeys()) {
      if (key === 'cursor' || (typeof key === 'string' && key.startsWith('acte:'))) await this.db.kv.delete(key);
    }
  }

  /* ── photos and documents waiting to be sent ── */
  async putFile(entity: string, kind: string, file: Blob, name: string): Promise<StoredFile> {
    const bytes = await file.arrayBuffer();
    const meta: FileMeta = { name, mime: file.type || 'application/octet-stream', sha256: await sha256Hex(bytes) };
    const row: FileRow = {
      id: newUuid(), entity, kind, size: bytes.byteLength, createdAt: new Date().toISOString(),
      meta: await encryptJson(this.key, meta), data: await encryptBytes(this.key, bytes),
    };
    await this.db.files.add(row);
    return { id: row.id, entity, kind, size: row.size, createdAt: row.createdAt, ...meta };
  }
  private async openFile(row: FileRow): Promise<StoredFile> {
    const meta = await decryptJson<FileMeta>(this.key, row.meta);
    return { id: row.id, entity: row.entity, kind: row.kind, size: row.size, createdAt: row.createdAt, ...meta };
  }
  async file(id: string): Promise<StoredFile | null> {
    const row = await this.db.files.get(id);
    return row ? this.openFile(row) : null;
  }
  async filesFor(entity: string): Promise<StoredFile[]> {
    const rows = await this.db.files.where('entity').equals(entity).sortBy('createdAt');
    return Promise.all(rows.map(r => this.openFile(r)));
  }
  async fileBlob(id: string): Promise<Blob | null> {
    const row = await this.db.files.get(id);
    if (!row) return null;
    const meta = await decryptJson<FileMeta>(this.key, row.meta);
    return new Blob([await decryptBytes(this.key, row.data)], { type: meta.mime });
  }
  removeFile(id: string) { return this.db.files.delete(id); }

  /* ── what the agent sees ── */
  private async ctx(): Promise<ViewContext> {
    return { ...this.context(), hospitals: await this.hospitals(), separateDuties: !!(await this.rules()).separate_submit_and_validate };
  }

  async view(uuid: string): Promise<LocalDeclaration | null> {
    return materialize(uuid, await this.server(uuid), await this.ops(uuid), await this.ctx());
  }

  /** Every dossier known on this device (received from the server or created here), as the agent sees it. */
  async views(): Promise<LocalDeclaration[]> {
    const ctx = await this.ctx();
    const ops = await this.ops();
    const byEntity = new Map<string, Op[]>();
    for (const op of ops) byEntity.set(op.entity, [...(byEntity.get(op.entity) ?? []), op]);
    const uuids = new Set<string>([...(await this.db.declarations.toCollection().primaryKeys()), ...byEntity.keys()]);
    const out: LocalDeclaration[] = [];
    for (const uuid of uuids) {
      const view = materialize(uuid, await this.server(uuid), byEntity.get(uuid) ?? [], ctx);
      if (view) out.push(view);
    }
    return out;
  }

  /** Dossiers with operations the server has not confirmed, keyed by uuid. */
  async unsyncedViews(): Promise<Map<string, LocalDeclaration>> {
    const ctx = await this.ctx();
    const live = (await this.ops()).filter(o => o.status !== 'applied');
    const out = new Map<string, LocalDeclaration>();
    for (const uuid of new Set(live.map(o => o.entity))) {
      const view = materialize(uuid, await this.server(uuid), await this.ops(uuid), ctx);
      if (view) out.set(uuid, view);
    }
    return out;
  }

  /* ── journal of the synchronisations (no personal data) ── */
  log(kind: LogRow['kind'], message: string) { return this.db.log.add({ at: new Date().toISOString(), kind, message }); }
  logs(limit = 60): Promise<LogRow[]> { return this.db.log.orderBy('id').reverse().limit(limit).toArray(); }
}
