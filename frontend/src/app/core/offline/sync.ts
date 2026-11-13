/**
 * Synchronisation of the device queue with the server.
 *
 *   push  operations in the order they were made, by small batches; photos one by one
 *   pull  the agent's own dossiers that changed, the health facilities and the rules to mirror
 *
 * Safe by construction: an operation is only marked « envoyée » on the server's explicit answer, and sending
 * it twice is harmless (the server recognises its identifier). A lost answer, a closed tab or a cut in the
 * middle of a batch therefore never loses nor duplicates anything.
 */
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import { ConnectivityService } from './connectivity.service';
import { OfflineStore } from './store';
import { HospitalRef, LocalDeclaration, Op, PushResult, SyncRules } from './types';

const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000];
const MAX_PULL_PAGES = 40;
// A request that never answers (signal without data) must not freeze the queue: it is given up and tried again.
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

export interface SyncHost {
  syncing(value: boolean): void;
  synced(at: string): void;
  failed(message: string): void;
  deviceRevoked(): void;
  changed(): Promise<void> | void;
  sessionExpired(): boolean;
}

export interface SyncIdentity { apiUrl: string; deviceId: string; deviceLabel: string; userUuid: string; }

interface PullResponse {
  server_time: string; offline_enabled: boolean; cursor: string | null; has_more: boolean;
  declarations: LocalDeclaration[]; hospitals: HospitalRef[]; rules: SyncRules;
}

export class SyncEngine {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private batchLimit: number | null = null;
  private stopped = false;

  constructor(
    private store: OfflineStore, private http: HttpClient, private conn: ConnectivityService,
    private host: SyncHost, private id: SyncIdentity) {}

  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }

  /** Asks for a synchronisation soon (several calls in a row give one run). */
  kick(delayMs = 300) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delayMs);
  }

  /** One full cycle. `manual` = the agent pressed « Synchroniser »: the connection is checked first. */
  run(manual = false): Promise<void> {
    this.running ??= this.cycle(manual).finally(() => { this.running = null; });
    return this.running;
  }

  private async cycle(manual: boolean) {
    if (this.stopped) return;
    if (manual || !this.conn.online()) await this.conn.check();
    if (!this.conn.online()) { if (manual) this.host.failed('Serveur injoignable : la synchronisation reprendra au retour de la connexion.'); return; }
    if (this.host.sessionExpired()) { if (manual) this.host.failed('Session expirée : reconnectez-vous pour synchroniser.'); return; }
    this.host.syncing(true);
    try {
      await this.store.resetSending();
      const sent = await this.push();
      const received = await this.pull();
      await this.store.purge();
      const at = new Date().toISOString();
      await this.store.setClear('lastSync', at);
      if (sent || received) await this.store.log('info', `Synchronisation : ${sent} opération(s) envoyée(s), ${received} dossier(s) reçu(s).`);
      this.failures = 0;
      this.host.synced(at);
    } catch (e) {
      await this.onFailure(e);
    } finally {
      this.host.syncing(false);
      await this.host.changed();
    }
  }

  private async onFailure(e: unknown) {
    const err = e as HttpErrorResponse;
    const status = err?.status;
    if (status === 401) return;  // the session is handled by the auth interceptor (expired → the queue waits)
    if (status === 403 && err.error?.code === 'device_revoked') {
      this.host.deviceRevoked();
      await this.store.log('error', "Appareil révoqué par l'administrateur : synchronisation refusée.");
      return;
    }
    if (status === 0 || status === undefined || status >= 500 || status === 429) {
      if (status === 0) this.conn.reportFailure();
      const delay = RETRY_DELAYS_MS[Math.min(this.failures, RETRY_DELAYS_MS.length - 1)];
      this.failures++;
      this.host.failed('Synchronisation interrompue : nouvel essai automatique dans quelques instants.');
      await this.store.log('error', `Synchronisation interrompue (${status === 0 ? 'réseau' : status === undefined ? 'délai dépassé' : 'serveur ' + status}).`);
      this.kick(delay);
      return;
    }
    const detail = err?.error?.detail ?? 'Erreur inattendue.';
    this.host.failed(`Synchronisation refusée : ${detail}`);
    await this.store.log('error', `Synchronisation refusée (${status}) : ${detail}`);
  }

  /* ── push ── */

  private async readyOps(): Promise<Op[]> {
    const ops = (await this.store.ops()).filter(o => o.status !== 'applied');
    // a refused operation holds back the later operations of the same dossier: they were made on top of it
    const blocked = new Set(ops.filter(o => o.status === 'rejected' || o.status === 'conflict').map(o => o.entity));
    return ops.filter(o => o.status === 'pending' && !blocked.has(o.entity));
  }

  private async push(): Promise<number> {
    let sent = 0;
    for (let guard = 0; guard < 500; guard++) {
      const ready = await this.readyOps();
      if (!ready.length) break;
      let done: number;
      if (ready[0].type === 'document.upload') done = await this.pushDocument(ready[0]);
      else {
        const limit = this.batchLimit ?? (await this.store.rules()).max_batch ?? 20;
        const batch: Op[] = [];
        const waitsForPhoto = new Set<string>();
        for (const op of ready) {
          if (batch.length >= limit) break;
          // order inside a dossier is kept: what follows a photo waits for the photo
          if (op.type === 'document.upload') { waitsForPhoto.add(op.entity); continue; }
          if (!waitsForPhoto.has(op.entity)) batch.push(op);
        }
        done = await this.pushBatch(batch);
      }
      if (!done) break;  // nothing moved (everything skipped): do not loop on the server
      sent += done;
      await this.host.changed();
    }
    return sent;
  }

  private async markSending(ops: Op[]) {
    for (const op of ops) { op.status = 'sending'; op.attempts++; await this.store.saveOp(op); }
    await this.host.changed();
  }
  private async backToPending(ops: Op[]) {
    for (const op of ops) { op.status = 'pending'; await this.store.saveOp(op); }
  }

  private async baseVersion(op: Op): Promise<number | null> {
    if (op.type !== 'declaration.update') return null;
    // an edit stacked on the agent's own earlier operations targets the version they produced
    return op.baseVersion ?? ((await this.store.server(op.entity)) as LocalDeclaration | null)?.sync_version ?? null;
  }

  private async pushBatch(batch: Op[]): Promise<number> {
    if (!batch.length) return 0;
    await this.markSending(batch);
    const operations = [];
    for (const op of batch) {
      operations.push({
        op_id: op.opId, type: op.type, entity_uuid: op.entity, device_time: op.deviceTime,
        base_version: await this.baseVersion(op), payload: op.type === 'declaration.transmit' ? {} : (op.payload ?? {}),
      });
    }
    let results: PushResult[];
    try {
      const body = { device: { id: this.id.deviceId, label: this.id.deviceLabel }, user: this.id.userUuid, sent_at: new Date().toISOString(), operations };
      results = (await firstValueFrom(this.http.post<{ results: PushResult[] }>(`${this.id.apiUrl}/sync/push/`, body).pipe(timeout(REQUEST_TIMEOUT_MS)))).results;
    } catch (e) {
      const err = e as HttpErrorResponse;
      if (err?.status === 400 || err?.status === 413) {
        // the whole envelope was refused: isolate the operation that cannot go through
        if (batch.length > 1) { await this.backToPending(batch); this.batchLimit = 1; return this.pushBatch([batch[0]]); }
        batch[0].status = 'rejected';
        batch[0].error = { code: 'bad_request', detail: this.flatten(err.error) || 'Opération refusée par le serveur.' };
        await this.store.saveOp(batch[0]);
        await this.store.log('error', `Opération refusée : ${batch[0].error.detail}`);
        return 1;
      }
      await this.backToPending(batch);
      throw e;
    }
    let moved = 0;
    for (const op of batch) {
      const result = results.find(r => r.op_id === op.opId);
      if (!result) { op.status = 'pending'; await this.store.saveOp(op); continue; }
      if (await this.applyResult(op, result)) moved++;
    }
    return moved;
  }

  private async pushDocument(op: Op): Promise<number> {
    const file = op.fileId ? await this.store.file(op.fileId) : null;
    const blob = op.fileId ? await this.store.fileBlob(op.fileId) : null;
    if (!file || !blob) {
      op.status = 'rejected'; op.error = { code: 'missing_file', detail: "Le fichier n'est plus disponible sur cet appareil." };
      await this.store.saveOp(op);
      return 1;
    }
    await this.markSending([op]);
    const form = new FormData();
    form.append('op_id', op.opId); form.append('device_id', this.id.deviceId); form.append('device_label', this.id.deviceLabel);
    form.append('user', this.id.userUuid); form.append('sent_at', new Date().toISOString()); form.append('device_time', op.deviceTime);
    form.append('uuid', file.id); form.append('declaration', op.entity); form.append('kind', file.kind); form.append('sha256', file.sha256);
    form.append('file', new File([blob], file.name, { type: file.mime }));
    try {
      const { result } = await firstValueFrom(this.http.post<{ result: PushResult }>(`${this.id.apiUrl}/sync/documents/`, form).pipe(timeout(UPLOAD_TIMEOUT_MS)));
      return (await this.applyResult(op, result)) ? 1 : 0;
    } catch (e) {
      const err = e as HttpErrorResponse;
      if (err?.status === 400 || err?.status === 413) {
        op.status = 'rejected';
        op.error = { code: 'bad_request', detail: err.status === 413 ? 'Fichier trop volumineux pour le serveur (4 Mo maximum).' : this.flatten(err.error) || 'Fichier refusé par le serveur.' };
        await this.store.saveOp(op);
        return 1;
      }
      await this.backToPending([op]);
      throw e;
    }
  }

  /** Records the server's answer. Returns false when the operation simply waits (skipped). */
  private async applyResult(op: Op, r: PushResult): Promise<boolean> {
    const dossier = r.declaration;
    if (dossier) {
      if (dossier.is_archived) await this.store.dropServer(dossier.uuid);
      else await this.store.putServer(dossier);
    }
    if (r.status === 'applied' || r.status === 'duplicate') {
      op.status = 'applied'; op.appliedAt = new Date().toISOString(); op.error = null;
      await this.store.saveOp(op);
      if (op.fileId) await this.store.removeFile(op.fileId);
      return true;
    }
    if (r.status === 'rejected' || r.status === 'conflict') {
      op.status = r.status; op.error = r.error ?? { detail: 'Opération refusée.' };
      await this.store.saveOp(op);
      await this.store.log('error', `${r.status === 'conflict' ? 'Conflit' : 'Opération refusée'} : ${op.error.detail ?? op.error.code ?? ''}`);
      return true;
    }
    op.status = 'pending';
    await this.store.saveOp(op);
    return false;
  }

  private flatten(detail: unknown): string {
    if (!detail) return '';
    if (typeof detail === 'string') return detail.length < 300 ? detail : '';
    if (Array.isArray(detail)) return detail.map(d => this.flatten(d)).filter(Boolean).join(' ');
    if (typeof detail === 'object') return Object.entries(detail as object).filter(([k]) => k !== 'code').map(([, v]) => this.flatten(v)).filter(Boolean).join(' — ');
    return String(detail);
  }

  /* ── pull ── */

  private async pull(): Promise<number> {
    let received = 0;
    for (let page = 0; page < MAX_PULL_PAGES; page++) {
      const since = await this.store.clear<string | null>('cursor', null);
      const res = await firstValueFrom(this.http.get<PullResponse>(`${this.id.apiUrl}/sync/pull/`, { params: since ? { since } : {} }).pipe(timeout(REQUEST_TIMEOUT_MS)));
      await this.store.setSecret('hospitals', res.hospitals ?? []);
      if (res.rules) await this.store.setSecret('rules', res.rules);
      if (typeof res.offline_enabled === 'boolean') this.conn.offlineEnabled.set(res.offline_enabled);
      for (const d of res.declarations ?? []) {
        if (d.is_archived && !(await this.store.liveOps(d.uuid)).length) await this.store.dropServer(d.uuid);
        else await this.store.putServer(d);
        received++;
      }
      if (res.cursor) await this.store.setClear('cursor', res.cursor);
      if (!res.has_more) break;
    }
    return received;
  }
}
