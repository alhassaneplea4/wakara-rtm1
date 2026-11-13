/**
 * Encrypted storage of the offline mode: the operation queue, the dossiers received from the server, the
 * photos waiting to be sent and the reference data. Every content goes through the data key of the vault.
 */
import { DeclarationDetail } from '../models';
import { decryptBytes, decryptJson, encryptBytes, encryptJson, sha256Hex, uuid as newUuid } from './crypto';
import { OfflineDb } from './db';
import { ViewContext, materialize } from './materialize';
import {
  DEFAULT_RULES, FileMeta, FileRow, HospitalRef, LocalDeclaration, LogRow, Op, OpRow, OpSecret, OpType, SyncRules,
} from './types';

/** Applied operations stay in the history this long, then are removed (their content is dropped at once). */
export const RETENTION_DAYS = 7;
const LOG_LIMIT = 200;

export interface StoredFile { id: string; entity: string; kind: string; size: number; createdAt: string; name: string; mime: string; sha256: string; }

export class OfflineStore {
  constructor(readonly db: OfflineDb, private key: CryptoKey, private context: () => Omit<ViewContext, 'hospitals'>) {}

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
  rules() { return this.secret<SyncRules>('rules', DEFAULT_RULES); }

  /* ── dossiers received from the server ── */
  async server(uuid: string): Promise<DeclarationDetail | null> {
    const row = await this.db.declarations.get(uuid);
    return row ? decryptJson<DeclarationDetail>(this.key, row.enc) : null;
  }
  async putServer(detail: DeclarationDetail) {
    const clean = { ...(detail as any) };
    delete clean.sync_state; delete clean.sync_error;
    await this.db.declarations.put({ uuid: detail.uuid, onServer: 1, updatedAt: detail.updated_at, enc: await encryptJson(this.key, clean) });
  }
  dropServer(uuid: string) { return this.db.declarations.delete(uuid); }

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

  async counts(): Promise<{ waiting: number; problems: number }> {
    const waiting = await this.db.operations.where('status').anyOf('pending', 'sending').count();
    const problems = await this.db.operations.where('status').anyOf('rejected', 'conflict').count();
    return { waiting, problems };
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
  private async ctx(): Promise<ViewContext> { return { ...this.context(), hospitals: await this.hospitals() }; }

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
