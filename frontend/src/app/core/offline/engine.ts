/**
 * Everything the offline mode needs once the vault is open, loaded on demand (this file and what it imports —
 * Dexie, the queue, the synchronisation — stay out of the initial bundle of the application).
 */
import { HttpClient, HttpEvent, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from '../auth.service';
import { ConnectivityService } from './connectivity.service';
import { OfflineDb, countUnsynced, deleteDb } from './db';
import { LocalApi } from './local-api';
import { OfflineStore } from './store';
import { SyncEngine } from './sync';
import { LocalDeclaration, LogRow, OpView } from './types';
import { VaultSession, changeVaultPin, createVault, destroyVault, loadVaultSession, openVault, pinProblem, saveVaultSession } from './vault';

export { PinError, pinProblem, PIN_MIN_LENGTH } from './vault';

export interface EngineHost {
  counts(waiting: number, problems: number): void;
  syncing(value: boolean): void;
  synced(at: string | null): void;
  failed(message: string): void;
  deviceRevoked(): void;
  /** Tells the screens that what they show may have changed. */
  bump(): void;
}

export interface EngineDeps {
  http: HttpClient; conn: ConnectivityService; auth: AuthService; host: EngineHost;
  apiUrl: string; deviceId: string; deviceLabel: string;
}

export const vault = { create: createVault, open: openVault, changePin: changeVaultPin, destroy: destroyVault, pinProblem };
export const storage = { countUnsynced, deleteDb };

export class OfflineEngine {
  readonly store: OfflineStore;
  readonly sync: SyncEngine;
  private api: LocalApi;
  private db: OfflineDb;

  constructor(private deps: EngineDeps, private key: CryptoKey, userUuid: string) {
    const { auth, conn, host } = deps;
    this.db = new OfflineDb(userUuid);
    this.store = new OfflineStore(this.db, key, () => ({
      userName: auth.fullName(), canUpdate: auth.can('declaration.update'), canTransmit: auth.can('declaration.transmit'),
    }));
    this.sync = new SyncEngine(this.store, deps.http, conn, {
      syncing: v => host.syncing(v), synced: at => host.synced(at), failed: m => host.failed(m),
      deviceRevoked: () => host.deviceRevoked(), changed: () => this.refresh(), sessionExpired: () => auth.sessionExpired(),
    }, { apiUrl: deps.apiUrl, deviceId: deps.deviceId, deviceLabel: deps.deviceLabel, userUuid });
    this.api = new LocalApi(this.store, conn, {
      apiUrl: deps.apiUrl, userName: () => auth.fullName(), sessionExpired: () => auth.sessionExpired(),
      changed: sync => { void this.refresh(); if (sync) this.sync.kick(); },
    });
  }

  /** Opens the local database and brings the counters up to date. */
  async start() {
    await this.db.open();
    await this.store.resetSending();
    this.deps.host.synced(await this.store.clear<string | null>('lastSync', null));
    await this.refresh();
    try { void navigator.storage?.persist?.(); } catch { /* best effort: ask the browser not to evict the data */ }
  }

  close() { this.sync.stop(); this.db.close(); }

  handle(req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> { return this.api.handle(req, next); }

  async refresh() {
    const { waiting, problems } = await this.store.counts();
    this.deps.host.counts(waiting, problems);
    this.deps.host.bump();
  }

  /* ── session kept in the vault ── */

  saveSession(): Promise<void> {
    const me = this.deps.auth.user();
    if (!me) return Promise.resolve();
    return saveVaultSession(this.key, { access: this.deps.auth.accessToken, refresh: this.deps.auth.refreshToken, me });
  }
  loadSession(): Promise<VaultSession | null> { return loadVaultSession(this.key); }

  /* ── synchronisation screen ── */

  view(uuid: string): Promise<LocalDeclaration | null> { return this.store.view(uuid); }
  logs(): Promise<LogRow[]> { return this.store.logs(); }

  async operations(): Promise<OpView[]> {
    const ops = await this.store.ops();
    const views = new Map<string, LocalDeclaration | null>();
    const out: OpView[] = [];
    for (const op of ops) {
      if (!views.has(op.entity)) views.set(op.entity, await this.store.view(op.entity));
      const view = views.get(op.entity) ?? null;
      const file = op.fileId && op.status !== 'applied' ? await this.store.file(op.fileId) : null;
      out.push({
        seq: op.seq, opId: op.opId, entity: op.entity, type: op.type, status: op.status, attempts: op.attempts,
        deviceTime: op.deviceTime, updatedAt: op.updatedAt, appliedAt: op.appliedAt ?? null,
        error: op.error?.detail ?? '', errorCode: op.error?.code ?? op.errorCode ?? '',
        reference: view?.reference ?? '', childName: view?.child_name ?? '', fileName: file?.name ?? '',
      });
    }
    return out.reverse();
  }

  /**
   * Gives up what this device holds for a dossier (after a refusal or a conflict): its unsent operations and
   * photos are removed and the dossier shows the server state again — or disappears if it never reached it.
   */
  async discard(entity: string) {
    for (const op of await this.store.liveOps(entity)) {
      if (op.status === 'sending') continue;
      if (op.fileId) await this.store.removeFile(op.fileId);
      await this.store.removeOp(op.seq);
    }
    await this.store.log('info', "Modifications locales abandonnées pour un dossier.");
    await this.refresh();
  }

  /** Sends refused operations again; a version conflict is re-applied on top of the server's current version. */
  async retry(entity: string) {
    const server = await this.store.server(entity) as LocalDeclaration | null;
    for (const op of await this.store.liveOps(entity)) {
      if (op.status !== 'rejected' && op.status !== 'conflict') continue;
      if (op.status === 'conflict' && op.error?.code !== 'version_conflict') continue;  // nothing to re-apply on a frozen dossier
      if (op.type === 'declaration.update') op.baseVersion = server?.sync_version ?? op.baseVersion ?? null;
      op.status = 'pending'; op.error = null;
      await this.store.saveOp(op);
    }
    await this.refresh();
    this.sync.kick(0);
  }

  /** One refused photo is removed without touching the rest of the dossier. */
  async dropOperation(seq: number) {
    const op = (await this.store.ops()).find(o => o.seq === seq);
    if (!op || op.status === 'sending' || op.status === 'applied') return;
    if (op.fileId) await this.store.removeFile(op.fileId);
    await this.store.removeOp(seq);
    await this.refresh();
    this.sync.kick();
  }
}
