/**
 * The existing screens keep calling the API as before; for a collection agent whose device is unlocked, the
 * calls that matter offline are answered here:
 *
 *   writes (create / edit / transmit a declaration, attach a photo)  →  ALWAYS recorded on the device first,
 *          then synchronised. One path whether the network is there or not: no half-sent request, no duplicate.
 *   reads  (list, dossier, photos, health facilities)                →  the server when it answers, the
 *          device otherwise; dossiers with operations still on the device are shown as the agent left them.
 *
 * Everything else goes to the network untouched (and simply fails without connection).
 */
import { HttpErrorResponse, HttpEvent, HttpHandlerFn, HttpRequest, HttpResponse } from '@angular/common/http';
import { Observable, catchError, defer, from, of, switchMap, throwError } from 'rxjs';
import { DeclarationDetail, DeclarationListItem, Page, SupportingDocument } from '../models';
import { ConnectivityService } from './connectivity.service';
import { FIELD_LABELS, ListQuery, matchesQuery, mergeWrite, missingForTransmission, sortViews, toListItem } from './materialize';
import { OfflineStore, StoredFile } from './store';
import { LocalDeclaration, LocalDocument, Op, SyncState } from './types';

const UUID = '([0-9a-fA-F-]{36})';
const ALLOWED_EXT = ['.pdf', '.jpg', '.jpeg', '.png'];
const PAGE_SIZE = 20;

export interface ApiHost {
  apiUrl: string;
  userName(): string;
  sessionExpired(): boolean;
  /** Something changed on the device: refresh counters and screens, and synchronise soon. */
  changed(sync?: boolean): void;
}

export class LocalApi {
  constructor(private store: OfflineStore, private conn: ConnectivityService, private host: ApiHost) {}

  private netOk() { return this.conn.online() && !this.host.sessionExpired(); }
  /** Remote switch off: new work goes straight to the server again; what is already queued still drains. */
  private writesLocal() { return this.conn.offlineEnabled(); }

  handle(req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> {
    const path = req.url.slice(this.host.apiUrl.length).split('?')[0];
    const method = req.method;
    let m: RegExpMatchArray | null;

    if (path === '/declarations/') {
      if (method === 'GET') return this.list(req, next);
      if (method === 'POST' && this.writesLocal()) return this.run(() => this.create(req.body as Record<string, any>));
    }
    if ((m = path.match(new RegExp(`^/declarations/${UUID}/$`)))) {
      const uuid = m[1];
      if (method === 'GET') return this.detail(uuid, req, next);
      if (method === 'PATCH' || method === 'PUT') return this.orNetwork(() => this.update(uuid, req.body as Record<string, any>), req, next);
    }
    if ((m = path.match(new RegExp(`^/declarations/${UUID}/transition/$`))) && method === 'POST' && (req.body as any)?.status === 'TRANSMITTED') {
      const uuid = m[1];
      return this.orNetwork(() => this.transmit(uuid), req, next);
    }
    if (path === '/documents/') {
      if (method === 'GET' && req.params.get('declaration')) return this.documents(req, next);
      if (method === 'POST' && req.body instanceof FormData) { const form = req.body; return this.orNetwork(() => this.addDocument(form), req, next); }
    }
    if ((m = path.match(new RegExp(`^/documents/${UUID}/download/$`))) && method === 'GET') {
      const id = m[1];
      return this.orNetwork(async () => { const blob = await this.store.fileBlob(id); return blob ? ok(blob) : null; }, req, next);
    }
    if ((m = path.match(new RegExp(`^/documents/${UUID}/$`))) && method === 'DELETE') {
      const id = m[1];
      return this.orNetwork(() => this.removeDocument(id), req, next);
    }
    if (path === '/hospitals/' && method === 'GET') return this.withFallback(req, next, () => this.hospitals());
    if (path === '/inbox/' && method === 'GET') return this.withFallback(req, next, () => this.inbox());
    return next(req);
  }

  /* ── plumbing ── */

  private run(fn: () => Promise<HttpResponse<unknown>>): Observable<HttpEvent<unknown>> { return defer(() => from(fn())); }

  /** Local answer when the handler gives one, otherwise the network (handler returned null). */
  private orNetwork(fn: () => Promise<HttpResponse<unknown> | null>, req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> {
    return defer(() => from(fn())).pipe(switchMap(res => (res ? of(res) : next(req))));
  }

  /** The network when it answers, the device otherwise. */
  private withFallback(req: HttpRequest<unknown>, next: HttpHandlerFn, local: () => Promise<HttpResponse<unknown>>): Observable<HttpEvent<unknown>> {
    if (!this.netOk()) return this.run(local);
    return next(req).pipe(catchError(e => (this.unreachable(e) ? this.run(local) : throwError(() => e))));
  }

  private unreachable(e: unknown): boolean {
    const status = (e as HttpErrorResponse)?.status;
    if (status === 0) this.conn.reportFailure();
    return status === 0 || status === 502 || status === 503 || status === 504;
  }

  /* ── declarations: reads ── */

  private query(req: HttpRequest<unknown>): ListQuery & { page: number } {
    const p = req.params;
    return {
      search: p.get('search') ?? '', statuses: p.getAll('status') ?? [], hospital: p.get('hospital') ?? '',
      from: p.get('received_from') ?? '', to: p.get('received_to') ?? '', ordering: p.get('ordering') ?? '-updated_at',
      page: Number(p.get('page') ?? 1) || 1,
    };
  }

  private list(req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> {
    const q = this.query(req);
    const local = async () => {
      const rows = sortViews((await this.store.views()).filter(v => !v.is_archived && matchesQuery(v, q)), q.ordering);
      const start = (q.page - 1) * PAGE_SIZE;
      return ok({ count: rows.length, next: null, previous: null, results: rows.slice(start, start + PAGE_SIZE).map(toListItem) });
    };
    if (!this.netOk()) return this.run(local);
    return next(req).pipe(
      switchMap(ev => (ev instanceof HttpResponse ? from(this.mergeList(ev as HttpResponse<Page<DeclarationListItem>>, q)) : of(ev))),
      catchError(e => (this.unreachable(e) ? this.run(local) : throwError(() => e))),
    );
  }

  /** Server page + what only this device knows: dossiers not sent yet come first, edited ones show the local state. */
  private async mergeList(res: HttpResponse<Page<DeclarationListItem>>, q: ListQuery & { page: number }): Promise<HttpResponse<unknown>> {
    const page = res.body;
    if (!page || !Array.isArray(page.results)) return res;
    const unsynced = await this.store.unsyncedViews();
    const results: unknown[] = page.results.map(r => (unsynced.has(r.uuid) ? toListItem(unsynced.get(r.uuid)!) : { ...r, sync_state: 'synced' as SyncState }));
    let count = page.count;
    if (q.page === 1) {
      const known = new Set(page.results.map(r => r.uuid));
      const onlyHere: LocalDeclaration[] = [];
      for (const view of unsynced.values()) {
        if (!known.has(view.uuid) && !(await this.store.server(view.uuid)) && matchesQuery(view, q)) onlyHere.push(view);
      }
      results.unshift(...sortViews(onlyHere, '-updated_at').map(toListItem));
      count += onlyHere.length;
    }
    return res.clone({ body: { ...page, count, results } as any });
  }

  private detail(uuid: string, req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> {
    const local = async () => {
      const view = await this.store.view(uuid);
      return view ? ok(view) : Promise.reject(fail(503, { detail: "Ce dossier n'est pas disponible sans connexion sur cet appareil." }));
    };
    return defer(() => from(this.store.liveOps(uuid))).pipe(switchMap(live => {
      if (live.length || !this.netOk()) return this.run(local);
      return next(req).pipe(
        switchMap(ev => {
          if (!(ev instanceof HttpResponse) || !(ev.body as any)?.uuid) return of(ev);
          const body = ev.body as DeclarationDetail;
          return from(this.store.putServer(body).then(() => ev.clone({ body: { ...body, sync_state: 'synced' } as any })));
        }),
        catchError(e => (this.unreachable(e) ? this.run(local) : throwError(() => e))),
      );
    }));
  }

  /* ── declarations: writes (always on the device first) ── */

  private async create(payload: Record<string, any>): Promise<HttpResponse<unknown>> {
    const { acte: _acte, ...clean } = payload ?? {};
    const uuid = (await this.store.addOp(cryptoUuid(), 'declaration.create', { payload: clean })).entity;
    this.host.changed(true);
    return ok(await this.store.view(uuid), 201);
  }

  private async update(uuid: string, payload: Record<string, any>): Promise<HttpResponse<unknown> | null> {
    const view = await this.store.view(uuid);
    const live = await this.store.liveOps(uuid);
    if (!view) return this.netOk() ? null : Promise.reject(fail(503, { detail: "Ce dossier n'est pas disponible sans connexion sur cet appareil." }));
    if (!this.writesLocal() && !live.length) return null;
    if (view.sync_state === 'conflict') return Promise.reject(fail(409, { detail: "Ce dossier a changé sur le serveur : réglez d'abord le conflit depuis la page du dossier." }));
    if (!view.can_edit) return Promise.reject(fail(403, { detail: 'Ce dossier ne peut pas être modifié dans son état actuel.' }));
    const { acte: _acte, ...clean } = payload ?? {};

    // a refused transmission is dropped: the agent transmits again once the dossier is corrected
    for (const op of live) if (op.type === 'declaration.transmit' && op.status === 'rejected') await this.store.removeOp(op.seq);
    const writes = live.filter(o => o.type === 'declaration.create' || o.type === 'declaration.update');
    const last: Op | undefined = writes[writes.length - 1];
    if (last && (last.status === 'pending' || last.status === 'rejected')) {
      // not sent yet (or refused and now corrected): the same operation carries the new content
      last.payload = mergeWrite(last.payload ?? {}, clean);
      last.status = 'pending'; last.error = null; last.deviceTime = last.type === 'declaration.create' ? last.deviceTime : new Date().toISOString();
      await this.store.saveOp(last);
    } else {
      await this.store.addOp(uuid, 'declaration.update', { payload: clean, baseVersion: live.length ? null : view.sync_version ?? null });
    }
    this.host.changed(true);
    return ok(await this.store.view(uuid));
  }

  private async transmit(uuid: string): Promise<HttpResponse<unknown> | null> {
    const view = await this.store.view(uuid);
    const live = await this.store.liveOps(uuid);
    if (!view) return this.netOk() ? null : Promise.reject(fail(503, { detail: "Ce dossier n'est pas disponible sans connexion sur cet appareil." }));
    if (!this.writesLocal() && !live.length) return null;
    if (!view.available_transitions.some(t => t.target === 'TRANSMITTED')) {
      return Promise.reject(fail(400, { code: 'invalid_transition', detail: 'Ce dossier ne peut pas être transmis dans son état actuel.' }));
    }
    const missing = missingForTransmission(view, (await this.store.rules()).required_for_transmission);
    if (missing.length) {
      return Promise.reject(fail(400, {
        missing_fields: missing, detail: 'Informations obligatoires manquantes : ' + missing.map(f => FIELD_LABELS[f] ?? f).join(', '),
      }));
    }
    const refused = live.find(o => o.type === 'declaration.transmit' && o.status === 'rejected');
    if (refused) { refused.status = 'pending'; refused.error = null; refused.deviceTime = new Date().toISOString(); await this.store.saveOp(refused); }
    else await this.store.addOp(uuid, 'declaration.transmit');
    this.host.changed(true);
    return ok(await this.store.view(uuid));
  }

  /* ── photos and documents ── */

  private asDocument(f: StoredFile, state: SyncState): LocalDocument {
    return {
      uuid: f.id, declaration: f.entity, kind: f.kind, original_name: f.name, content_type: f.mime, size: f.size, sha256: f.sha256,
      description: '', uploaded_by_name: this.host.userName(), created_at: f.createdAt, sync_state: state,
    };
  }

  private async localDocuments(declaration: string, kind: string | null): Promise<LocalDocument[]> {
    const ops = await this.store.liveOps(declaration);
    const files = (await this.store.filesFor(declaration)).filter(f => !kind || f.kind === kind);
    return files.map(f => {
      const op = ops.find(o => o.fileId === f.id);
      return this.asDocument(f, op?.status === 'rejected' ? 'error' : op?.status === 'sending' ? 'sending' : 'local');
    });
  }

  private documents(req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> {
    const declaration = req.params.get('declaration')!;
    const kind = req.params.get('kind');
    const local = async () => {
      const docs = await this.localDocuments(declaration, kind);
      return ok({ count: docs.length, next: null, previous: null, results: docs });
    };
    return defer(() => from(this.store.server(declaration))).pipe(switchMap(onServer => {
      if (!onServer || !this.netOk()) return this.run(local);
      return next(req).pipe(
        switchMap(ev => {
          if (!(ev instanceof HttpResponse)) return of(ev);
          const page = ev.body as Page<SupportingDocument>;
          return from(this.localDocuments(declaration, kind).then(docs => ev.clone({
            body: { ...page, count: (page?.count ?? 0) + docs.length, results: [...(page?.results ?? []), ...docs] } as any,
          })));
        }),
        catchError(e => (this.unreachable(e) ? this.run(local) : throwError(() => e))),
      );
    }));
  }

  private async addDocument(form: FormData): Promise<HttpResponse<unknown> | null> {
    const declaration = String(form.get('declaration') ?? '');
    const kind = String(form.get('kind') || 'OTHER');
    const file = form.get('file');
    const view = declaration ? await this.store.view(declaration) : null;
    if (!view) return null;                                    // dossier unknown on this device: plain online upload
    if (!this.writesLocal() && view.sync_state === 'synced') return null;
    if (!(file instanceof Blob)) return Promise.reject(fail(400, { file: ['Aucun fichier reçu.'] }));
    const name = (file as File).name || 'fichier';
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) return Promise.reject(fail(400, { file: ['Format non autorisé (PDF, JPG ou PNG uniquement).'] }));
    const max = (await this.store.rules()).max_upload_size;
    if (file.size > max) return Promise.reject(fail(400, { file: [`Fichier trop volumineux (max ${Math.floor(max / 1048576)} Mo).`] }));
    if (['VALIDATED', 'REJECTED', 'DELIVERED'].includes(view.status)) return Promise.reject(fail(403, { detail: "Le dossier est figé : impossible d'ajouter une pièce." }));
    if (!(await hasRoomFor(file.size))) {
      return Promise.reject(fail(507, { detail: "Espace de stockage insuffisant sur cet appareil : synchronisez les dossiers en attente pour libérer de la place, puis réessayez." }));
    }
    let stored: StoredFile;
    try { stored = await this.store.putFile(declaration, kind, file, name); }
    catch { return Promise.reject(fail(507, { detail: "Impossible d'enregistrer le fichier sur cet appareil (espace de stockage insuffisant)." })); }
    await this.store.addOp(declaration, 'document.upload', { fileId: stored.id, payload: { kind } });
    this.host.changed(true);
    return ok(this.asDocument(stored, 'local'), 201);
  }

  private async removeDocument(id: string): Promise<HttpResponse<unknown> | null> {
    const file = await this.store.file(id);
    if (!file) return null;  // a document already on the server: usual API
    const op = (await this.store.liveOps(file.entity)).find(o => o.fileId === id);
    if (op?.status === 'sending') return Promise.reject(fail(409, { detail: 'Envoi en cours : réessayez dans un instant.' }));
    if (op) await this.store.removeOp(op.seq);
    await this.store.removeFile(id);
    this.host.changed(true);
    return ok(null, 204);
  }

  /* ── reference data ── */

  private async hospitals(): Promise<HttpResponse<unknown>> {
    const results = (await this.store.hospitals()).map(h => ({
      ...h, facility_type: '', facility_type_label: '', region: '', commune: '', address: '', contact_name: '', phone: '', email: '',
      is_active: true, is_archived: false, declaration_count: 0, created_at: '',
    }));
    return ok({ count: results.length, next: null, previous: null, results });
  }

  private async inbox(): Promise<HttpResponse<unknown>> {
    const toCorrect = (await this.store.views()).filter(v => v.status === 'TO_CORRECT_COLLECTION' && !v.is_archived).length;
    const items = toCorrect ? [{ code: 'to_correct_collection', label: 'Déclarations à corriger', count: toCorrect, status: 'TO_CORRECT_COLLECTION' }] : [];
    return ok({ total: toCorrect, items, badges: toCorrect ? { '/declarations': toCorrect } : {} });
  }
}

function ok(body: unknown, status = 200): HttpResponse<unknown> { return new HttpResponse({ body, status, statusText: 'OK' }); }
function fail(status: number, error: unknown): HttpErrorResponse { return new HttpErrorResponse({ status, error, statusText: 'Offline' }); }
function cryptoUuid(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15; return (c === 'x' ? r : (r & 3) | 8).toString(16); });
}

/** Keeps a safety margin so that the queue itself can always be written. */
async function hasRoomFor(bytes: number): Promise<boolean> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate?.quota) return true;
    return estimate.quota - (estimate.usage ?? 0) > bytes * 1.5 + 5 * 1024 * 1024;
  } catch { return true; }
}
