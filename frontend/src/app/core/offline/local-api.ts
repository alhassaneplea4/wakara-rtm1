/**
 * The existing screens keep calling the API as before; for a user whose device is unlocked, the calls that matter
 * offline are answered here. Two ways of working, one queue:
 *
 *   collection agent  writes (create / edit / transmit a declaration, attach a photo) are ALWAYS recorded on the
 *                     device first, then synchronised: one path whether the network is there or not.
 *   other roles       (secretariat, validator, administrator) work on the server while it answers — what they do
 *                     online is exactly what they did before — and the same writes (edit a dossier and its acte,
 *                     submit, validate, send back, attach a document) are queued on the device when it does not.
 *                     A dossier that already has operations waiting keeps going through the queue, so that the
 *                     order of what was done is never broken.
 *
 *   reads  (list, dossier, acte, photos, health facilities) → the server when it answers, the device otherwise;
 *          dossiers with operations still on the device are shown as the user left them.
 *   every other page consulted online (statistics, lists of actes, deliveries, history, duplicate cases,
 *          users, roles…) is kept, encrypted, and read again from the device when the server is out of reach.
 *          Anything that is not a dossier operation (managing users and roles, settings, duplicate decisions,
 *          deliveries…) is never queued: it needs the server and says so.
 */
import { HttpErrorResponse, HttpEvent, HttpHandlerFn, HttpRequest, HttpResponse } from '@angular/common/http';
import { Observable, catchError, defer, from, of, switchMap, throwError } from 'rxjs';
import { DeclarationDetail, DeclarationListItem, Page, SupportingDocument } from '../models';
import { ConnectivityService } from './connectivity.service';
import {
  FIELD_LABELS, ListQuery, SEPARATION_MESSAGE, WORKFLOW, isLockedByDeadline, matchesQuery, mergeWrite, missingForTransmission, sortViews, toListItem,
} from './materialize';
import { OfflineStore, StoredFile } from './store';
import { LocalDeclaration, LocalDocument, Op, SyncState } from './types';

const UUID = '([0-9a-fA-F-]{36})';
const ALLOWED_EXT = ['.pdf', '.jpg', '.jpeg', '.png'];
const PAGE_SIZE = 20;
const NOT_CONSULTED = "Cette page n'a pas encore été consultée sur cet appareil : elle sera lisible hors connexion après une première consultation en ligne.";
const NEEDS_SERVER = 'Cette action nécessite la connexion au serveur.';

export interface ApiHost {
  apiUrl: string;
  userName(): string;
  sessionExpired(): boolean;
  /** Something changed on the device: refresh counters and screens, and synchronise soon. */
  changed(sync?: boolean): void;
  /** Permissions of the signed-in user. Without it: the collection agent's rights. */
  can?(permission: string): boolean;
  /** Collection agent (device first) or any other role (server first, queue when it does not answer). Default: agent. */
  localFirst?(): boolean;
}

export class LocalApi {
  constructor(private store: OfflineStore, private conn: ConnectivityService, private host: ApiHost) {}

  private netOk() { return this.conn.online() && !this.host.sessionExpired(); }
  /** Remote switch off: new work goes straight to the server again; what is already queued still drains. */
  private writesLocal() { return this.conn.offlineEnabled(); }
  private localFirst() { return this.host.localFirst ? this.host.localFirst() : true; }
  private can(permission: string): boolean {
    if (this.host.can) return this.host.can(permission);
    return ['declaration.create', 'declaration.update', 'declaration.transmit', 'document.upload'].includes(permission);
  }

  handle(req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> {
    const path = req.url.slice(this.host.apiUrl.length).split('?')[0];
    const method = req.method;
    let m: RegExpMatchArray | null;

    if (path === '/declarations/') {
      if (method === 'GET') return this.list(req, next);
      if (method === 'POST' && this.writesLocal() && this.can('declaration.create')) return this.createRoute(req, next);
    }
    if ((m = path.match(new RegExp(`^/declarations/${UUID}/$`)))) {
      const uuid = m[1];
      if (method === 'GET') return this.detail(uuid, req, next);
      if (method === 'PATCH' || method === 'PUT') return this.write(uuid, req, next, () => this.update(uuid, req.body as Record<string, any>));
    }
    if ((m = path.match(new RegExp(`^/declarations/${UUID}/transition/$`))) && method === 'POST') {
      const uuid = m[1];
      return this.write(uuid, req, next, () => this.transition(uuid, (req.body ?? {}) as Record<string, any>));
    }
    if ((m = path.match(new RegExp(`^/actes/${UUID}/$`))) && method === 'GET') return this.acte(m[1], req, next);
    if (path === '/documents/') {
      if (method === 'GET' && req.params.get('declaration')) return this.documents(req, next);
      if (method === 'POST' && req.body instanceof FormData) {
        const form = req.body;
        return this.write(String(form.get('declaration') ?? ''), req, next, () => this.addDocument(form));
      }
    }
    if ((m = path.match(new RegExp(`^/documents/${UUID}/download/$`))) && method === 'GET') {
      const id = m[1];
      return this.orNetwork(async () => { const blob = await this.store.fileBlob(id); return blob ? ok(blob) : null; }, req, next);
    }
    if ((m = path.match(new RegExp(`^/documents/${UUID}/$`))) && method === 'DELETE') {
      const id = m[1];
      return this.orNetwork(() => this.removeDocument(id), req, next);
    }
    if (path === '/hospitals/' && method === 'GET') return this.hospitalsRoute(req, next);
    if (path === '/inbox/' && method === 'GET') {
      // the agent's counters come from the device (what waits there counts); the others' from the last answer
      return this.localFirst() ? this.withFallback(req, next, () => this.inbox()) : this.cached(req, next, () => this.inbox());
    }
    if (this.readable(path, req)) return this.cached(req, next);
    return this.offlineGuard(req, next);
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

  /**
   * A write on one dossier. The collection agent always goes through the device. The other roles go straight to
   * the server while it answers (and while the dossier has nothing waiting on the device); otherwise — no network,
   * an expired session, or the server out of reach — the operation is queued exactly as the agent's.
   */
  private write(uuid: string, req: HttpRequest<unknown>, next: HttpHandlerFn, local: () => Promise<HttpResponse<unknown> | null>): Observable<HttpEvent<unknown>> {
    return defer(() => from(uuid ? this.store.liveOps(uuid) : Promise.resolve([] as Op[]))).pipe(switchMap(live => {
      const direct = !this.localFirst() && !live.length && this.netOk() && this.writesLocal();
      if (!direct) return this.orNetwork(local, req, next);
      return next(req).pipe(
        switchMap(ev => (ev instanceof HttpResponse && (ev.body as any)?.uuid && (ev.body as any)?.status
          ? from(this.store.putServer(ev.body as DeclarationDetail).then(() => ev)) : of(ev))),
        catchError(e => (this.unreachable(e) ? this.orNetwork(local, req, next) : throwError(() => e))),
      );
    }));
  }

  /** Creating a dossier: device first for the agent, server first for the others. */
  private createRoute(req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> {
    const local = () => this.run(() => this.create(req.body as Record<string, any>));
    if (this.localFirst() || !this.netOk()) return local();
    return next(req).pipe(catchError(e => (this.unreachable(e) ? local() : throwError(() => e))));
  }

  /* ── pages consulted online, read again offline ── */

  /** A GET of the API worth keeping for offline reading (dossier operations have their own, richer handlers). */
  private readable(path: string, req: HttpRequest<unknown>): boolean {
    if (req.method !== 'GET' || req.responseType !== 'json') return false;
    return !/^\/(auth|sync|public)\//.test(path) && !/\/(download|export)\/?$/.test(path);
  }

  private address(req: HttpRequest<unknown>): string {
    const path = req.url.slice(this.host.apiUrl.length).split('?')[0];
    const query = req.params.keys().sort().map(k => `${k}=${(req.params.getAll(k) ?? []).join(',')}`).join('&');
    return query ? `${path}?${query}` : path;
  }

  /**
   * Server first; every good answer is kept (encrypted) for the day it does not answer. ``fallback`` is the
   * device's own answer when the page was never consulted.
   */
  private cached(req: HttpRequest<unknown>, next: HttpHandlerFn, fallback?: () => Promise<HttpResponse<unknown>>): Observable<HttpEvent<unknown>> {
    const address = this.address(req);
    const fromDevice = () => defer(() => from(this.store.cacheGet(address))).pipe(switchMap(hit => {
      if (hit) return of(ok(hit.body));
      if (fallback) return this.run(fallback);
      return throwError(() => fail(503, { detail: NOT_CONSULTED }));
    }));
    if (!this.netOk()) return fromDevice();
    return next(req).pipe(
      switchMap(ev => (ev instanceof HttpResponse && ev.status === 200 && ev.body !== null && typeof ev.body === 'object'
        ? from(this.store.cachePut(address, ev.body).catch(() => undefined).then(() => ev)) : of(ev))),
      catchError(e => (this.unreachable(e) ? fromDevice() : throwError(() => e))),
    );
  }

  /** Writes the device cannot queue (users, roles, settings, duplicate decisions…): refused with a clear reason. */
  private offlineGuard(req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next(req);
    if (!this.conn.online() && !this.host.sessionExpired()) return throwError(() => fail(503, { detail: NEEDS_SERVER }));
    return next(req);
  }

  /* ── declarations: reads ── */

  private query(req: HttpRequest<unknown>): ListQuery & { page: number; size: number } {
    const p = req.params;
    const overdue = p.get('overdue');
    return {
      search: p.get('search') ?? '', statuses: p.getAll('status') ?? [], hospital: p.get('hospital') ?? '',
      from: p.get('received_from') ?? '', to: p.get('received_to') ?? '', ordering: p.get('ordering') ?? '-updated_at',
      birthFrom: p.get('birth_from') ?? '', birthTo: p.get('birth_to') ?? '', assignedTo: p.get('assigned_to') ?? '',
      overdue: overdue === null || overdue === '' ? null : overdue === 'true' || overdue === '1',
      page: Number(p.get('page') ?? 1) || 1, size: Math.min(Number(p.get('page_size') ?? PAGE_SIZE) || PAGE_SIZE, 100),
    };
  }

  private list(req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> {
    // how a dossier reached the server is not known to the device: those filters are answered from the last page seen
    if (req.params.has('transmitted_offline') || req.params.has('entered_offline')) return this.cached(req, next);
    const q = this.query(req);
    const local = async () => {
      const rows = sortViews((await this.store.views()).filter(v => !v.is_archived && matchesQuery(v, q)), q.ordering);
      const start = (q.page - 1) * q.size;
      return ok({ count: rows.length, next: null, previous: null, results: rows.slice(start, start + q.size).map(toListItem) });
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

  /** Registry header of a dossier (secretariat): the server's, or the device's with what waits to be sent. */
  private acte(id: string, req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> {
    const local = async () => {
      const declaration = await this.store.declarationOfActe(id);
      const view = declaration ? await this.store.view(declaration) : null;
      const acte = (view as any)?.acte;
      if (!view || !acte) return Promise.reject(fail(503, { detail: "Les références de cet acte ne sont pas disponibles sans connexion sur cet appareil." }));
      return ok({ ...acte, uuid: id, declaration_uuid: view.uuid, reference: view.reference, status: view.status, status_label: view.status_label });
    };
    return defer(async () => { const d = await this.store.declarationOfActe(id); return d ? this.store.liveOps(d) : []; }).pipe(switchMap(live => {
      if (live.length || !this.netOk()) return this.run(local);
      return next(req).pipe(
        switchMap(ev => (ev instanceof HttpResponse && (ev.body as any)?.uuid
          ? from(this.store.putActe(id, ev.body).catch(() => undefined).then(() => ev)) : of(ev))),
        catchError(e => (this.unreachable(e) ? this.run(local) : throwError(() => e))),
      );
    }));
  }

  /* ── declarations: writes ── */

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
    if (!view.can_edit) return Promise.reject(fail(403, { detail: view.deadline?.overdue ? view.deadline.message : 'Ce dossier ne peut pas être modifié dans son état actuel.' }));
    // the registry header belongs to the secretariat and the validator, never to a collection device
    const { acte, ...rest } = payload ?? {};
    const clean = this.can('acte.update') && acte ? { ...rest, acte } : rest;

    // a refused step is dropped: the user takes it again once the dossier is corrected
    for (const op of live) if ((op.type === 'declaration.transmit' || op.type === 'declaration.transition') && op.status === 'rejected') await this.store.removeOp(op.seq);
    const after = await this.store.liveOps(uuid);
    const last: Op | undefined = after.filter(o => o.type !== 'document.upload').pop();
    if (last && (last.type === 'declaration.create' || last.type === 'declaration.update') && (last.status === 'pending' || last.status === 'rejected')) {
      // the last thing done on this dossier is a change that has not been sent (or was refused and is now corrected):
      // the same operation carries the new content
      last.payload = mergeWrite(last.payload ?? {}, clean);
      last.status = 'pending'; last.error = null; last.deviceTime = last.type === 'declaration.create' ? last.deviceTime : new Date().toISOString();
      await this.store.saveOp(last);
    } else {
      await this.store.addOp(uuid, 'declaration.update', { payload: clean, baseVersion: after.length ? null : view.sync_version ?? null });
    }
    this.host.changed(true);
    return ok(await this.store.view(uuid));
  }

  /**
   * Any step of the workflow. The device checks what it can know (the step exists for this user, the reason, the
   * required data, the numbering) so that the answer is the one of the online API; the server checks everything
   * again — rules, permissions, uniqueness of the official number — when the operation is synchronised.
   */
  private async transition(uuid: string, body: Record<string, any>): Promise<HttpResponse<unknown> | null> {
    const view = await this.store.view(uuid);
    const live = await this.store.liveOps(uuid);
    if (!view) return this.netOk() ? null : Promise.reject(fail(503, { detail: "Ce dossier n'est pas disponible sans connexion sur cet appareil." }));
    if (!this.writesLocal() && !live.length) return null;
    const target = String(body['status'] ?? '');
    if (target === 'VALIDATED' && (view as any).validation_blocked) return Promise.reject(fail(403, { detail: SEPARATION_MESSAGE }));
    const step = WORKFLOW.find(t => t.target === target && t.source === view.status);
    if (!step || !view.available_transitions.some(t => t.target === target)) {
      return Promise.reject(fail(400, { code: 'invalid_transition', detail: view.deadline?.overdue ? view.deadline.message : 'Ce dossier ne peut pas passer à cette étape dans son état actuel.' }));
    }
    const reason = String(body['reason'] ?? '').trim();
    if (step.reason_required && !reason) return Promise.reject(fail(400, { reason: ['Un motif est obligatoire pour cette décision.'], detail: 'Un motif est obligatoire pour cette décision.' }));

    const rules = await this.store.rules();
    const required = target === 'TRANSMITTED' ? rules.required_for_transmission : target === 'PENDING_VALIDATION' ? rules.required_for_submission ?? [] : [];
    const missing = missingForTransmission(view, required);
    if (missing.length) {
      return Promise.reject(fail(400, { missing_fields: missing, detail: 'Informations obligatoires manquantes : ' + missing.map(f => FIELD_LABELS[f] ?? f).join(', ') }));
    }

    const payload: Record<string, any> = { status: target, reason, from_status: view.status };
    if (target === 'VALIDATED') {
      const header = ((view as any).acte ?? {}) as Record<string, any>;
      const annee = body['annee'] || header['annee'];
      const numero = String(body['numero_acte'] ?? header['numero_acte'] ?? '').trim();
      if (!annee) return Promise.reject(fail(400, { annee: ["L'année du registre est requise pour attribuer le numéro."] }));
      if (!numero && !rules.auto_numbering) return Promise.reject(fail(400, { numero_acte: ["Le numéro officiel de l'acte est requis (la numérotation automatique n'est pas activée : règle à confirmer par la mairie)."] }));
      const draft: any = { ...view, acte: { ...header, annee, registre: body['registre'] ?? header['registre'], feuillet: body['feuillet'] ?? header['feuillet'], numero_acte: numero } };
      const incomplete = missingForTransmission(draft, rules.expected_for_validation ?? []);
      if (incomplete.length && !body['accept_incomplete']) {
        const labels = incomplete.map(f => FIELD_LABELS[f] ?? f);
        return Promise.reject(fail(409, {
          code: 'incomplete_confirmation_required', missing_fields: incomplete, missing_labels: labels,
          detail: 'Des champs ne sont pas renseignés : ' + labels.join(', ') + '. Confirmez pour valider quand même.',
        }));
      }
      Object.assign(payload, { annee, registre: draft.acte.registre ?? '', feuillet: draft.acte.feuillet ?? '', numero_acte: numero, accept_incomplete: !!body['accept_incomplete'] });
    }

    // a step refused earlier is replaced by the new one
    for (const op of live) if ((op.type === 'declaration.transmit' || op.type === 'declaration.transition') && op.status === 'rejected') await this.store.removeOp(op.seq);
    if (target === 'TRANSMITTED') await this.store.addOp(uuid, 'declaration.transmit');
    else await this.store.addOp(uuid, 'declaration.transition', { payload, baseVersion: live.length ? null : view.sync_version ?? null });
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
    const address = this.address(req);
    const local = async () => {
      // what the server already holds was listed the last time the page was open online; the photos waiting here come on top
      const known = ((await this.store.cacheGet(address))?.body as Page<SupportingDocument> | undefined)?.results ?? [];
      const docs = await this.localDocuments(declaration, kind);
      return ok({ count: known.length + docs.length, next: null, previous: null, results: [...known, ...docs] });
    };
    return defer(() => from(this.store.server(declaration))).pipe(switchMap(onServer => {
      if (!onServer || !this.netOk()) return this.run(local);
      return next(req).pipe(
        switchMap(ev => {
          if (!(ev instanceof HttpResponse)) return of(ev);
          const page = ev.body as Page<SupportingDocument>;
          return from((page && typeof page === 'object' ? this.store.cachePut(address, page).catch(() => undefined) : Promise.resolve())
            .then(() => this.localDocuments(declaration, kind)).then(docs => ev.clone({
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
    if (isLockedByDeadline(view, (p: string) => this.can(p), todayLocal())) return Promise.reject(fail(403, { detail: view.deadline?.message ?? 'Ce dossier est bloqué (délai de 6 mois dépassé).' }));
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

  /** Facilities for the forms. The simple list of the active ones comes from the reference data kept at each synchronisation. */
  private hospitalsRoute(req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> {
    const simple = req.params.keys().every(k => ['is_active', 'page_size', 'ordering'].includes(k));
    const address = this.address(req);
    const local = async () => {
      if (simple) {
        const known = await this.hospitals();
        if ((known.body as Page<unknown>).count) return known;
      }
      const hit = await this.store.cacheGet(address);
      return hit ? ok(hit.body) : (simple ? this.hospitals() : Promise.reject(fail(503, { detail: NOT_CONSULTED })));
    };
    if (!this.netOk()) return this.run(local);
    return next(req).pipe(
      switchMap(ev => (ev instanceof HttpResponse && ev.status === 200 && ev.body && typeof ev.body === 'object'
        ? from(this.store.cachePut(address, ev.body).catch(() => undefined).then(() => ev)) : of(ev))),
      catchError(e => (this.unreachable(e) ? this.run(local) : throwError(() => e))),
    );
  }

  private async hospitals(): Promise<HttpResponse<unknown>> {
    const results = (await this.store.hospitals()).map(h => ({
      ...h, facility_type: '', facility_type_label: '', region: '', commune: '', address: '', contact_name: '', phone: '', email: '',
      is_active: true, is_archived: false, declaration_count: 0, created_at: '',
    }));
    return ok({ count: results.length, next: null, previous: null, results });
  }

  private async inbox(): Promise<HttpResponse<unknown>> {
    const views = (await this.store.views()).filter(v => !v.is_archived);
    const items: { code: string; label: string; count: number; status: string }[] = [];
    const toCorrect = views.filter(v => v.status === 'TO_CORRECT_COLLECTION').length;
    if (toCorrect && this.can('declaration.create')) items.push({ code: 'to_correct_collection', label: 'Déclarations à corriger', count: toCorrect, status: 'TO_CORRECT_COLLECTION' });
    const toValidate = views.filter(v => v.status === 'PENDING_VALIDATION').length;
    if (toValidate && this.can('dossier.validate')) items.push({ code: 'pending_validation', label: 'Dossiers en attente de validation', count: toValidate, status: 'PENDING_VALIDATION' });
    const late = views.filter(v => (v as any).overdue).length;
    if (late) items.push({ code: 'overdue', label: 'Dossiers de plus de 6 mois : à traiter aux tribunaux', count: late, status: 'OVERDUE' });
    const badges: Record<string, number> = {};
    if (toCorrect || late) badges['/declarations'] = toCorrect + late;
    if (toValidate && this.can('dossier.validate')) badges['/validation'] = toValidate;
    return ok({ total: items.reduce((n, i) => n + i.count, 0), items, badges });
  }
}

function ok(body: unknown, status = 200): HttpResponse<unknown> { return new HttpResponse({ body, status, statusText: 'OK' }); }
function fail(status: number, error: unknown): HttpErrorResponse { return new HttpErrorResponse({ status, error, statusText: 'Offline' }); }
function todayLocal(): string { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; }
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
