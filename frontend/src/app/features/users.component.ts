import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, errorMessage, fieldErrors } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { AuditEntry, Page, PermissionDef, Role, UserRow } from '../core/models';
import { ToastService } from '../core/toast.service';
import { ConfirmComponent, IconComponent, PageHeaderComponent, PaginationComponent } from '../shared/ui';

@Component({
  selector: 'wk-users', standalone: true,
  imports: [CommonModule, FormsModule, DatePipe, IconComponent, PageHeaderComponent, PaginationComponent, ConfirmComponent],
  template: `
    <div class="page">
      <wk-page-header title="Utilisateurs" subtitle="Comptes, rôles et accès. Un compte n'est jamais supprimé : il est désactivé.">
        @if (auth.can('user.create')) { <button class="btn btn-primary" (click)="openCreate()"><wk-icon name="plus" [size]="16" /> Nouvel utilisateur</button> }
      </wk-page-header>
      <section class="card flush">
        <div class="filters">
          <input class="input" [(ngModel)]="search" (keyup.enter)="reload()" placeholder="Nom, identifiant, e-mail…" aria-label="Recherche" />
          <select class="input" [(ngModel)]="active" (ngModelChange)="reload()" aria-label="État"><option value="">Tous les comptes</option><option value="true">Actifs</option><option value="false">Désactivés</option></select>
          <button class="btn" (click)="reload()">Rechercher</button>
        </div>
        @if (error()) { <div class="alert alert-danger" style="margin:16px">{{ error() }}</div> }
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Utilisateur</th><th>Identifiant</th><th>Rôles</th><th>Dernière connexion</th><th>État</th></tr></thead>
          <tbody>
            @for (u of rows(); track u.uuid) {
              <tr class="clickable" (click)="openDetail(u)" tabindex="0" (keyup.enter)="openDetail(u)">
                <td><strong>{{ u.first_name }} {{ u.last_name }}</strong><br /><small class="muted">{{ u.email || '—' }}</small></td>
                <td class="mono">{{ u.username }}</td>
                <td>@for (r of u.roles; track r.codename) { <span class="badge badge-info" style="margin-right:4px">{{ r.name }}</span> } @empty { <span class="muted">Aucun rôle</span> }</td>
                <td class="mono">{{ u.last_login ? (u.last_login | date: 'dd/MM/yyyy HH:mm') : 'Jamais' }}</td>
                <td><span class="badge" [ngClass]="!u.is_active ? 'badge-neutral' : u.is_locked ? 'badge-warning' : 'badge-success'">{{ !u.is_active ? 'Désactivé' : u.is_locked ? 'Verrouillé' : 'Actif' }}</span></td>
              </tr>
            } @empty { <tr><td colspan="5"><div class="empty"><strong>Aucun utilisateur</strong></div></td></tr> }
          </tbody></table></div>
        <wk-pagination [page]="page" [total]="total()" (pageChange)="page = $event; load()" />
      </section>
    </div>

    @if (create(); as c) {
      <div class="modal-backdrop" (click)="create.set(null)">
        <div class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <h2>Nouvel utilisateur</h2>
          @if (formError()) { <div class="alert alert-danger" style="margin-bottom:12px">{{ formError() }}</div> }
          <div class="form-grid">
            <div class="field"><label class="req">Identifiant</label><input class="input" [(ngModel)]="c.username" autocomplete="off" [class.invalid]="errs()['username']" /><span class="field-error">{{ errs()['username'] }}</span></div>
            <div class="field"><label>E-mail</label><input class="input" type="email" [(ngModel)]="c.email" [class.invalid]="errs()['email']" /><span class="field-error">{{ errs()['email'] }}</span></div>
            <div class="field"><label>Prénom</label><input class="input" [(ngModel)]="c.first_name" /></div>
            <div class="field"><label>Nom</label><input class="input" [(ngModel)]="c.last_name" /></div>
            <div class="field"><label>Téléphone</label><input class="input" [(ngModel)]="c.phone" /></div>
            <div class="field"><label class="req">Mot de passe temporaire</label><input class="input" type="password" [(ngModel)]="c.password" autocomplete="new-password" [class.invalid]="errs()['password']" /><span class="field-error">{{ errs()['password'] }}</span></div>
          </div>
          <p class="soft" style="margin-top:12px">L'utilisateur devra changer son mot de passe à la première connexion. Les rôles s'attribuent ensuite depuis sa fiche.</p>
          <div class="modal-actions"><button class="btn" (click)="create.set(null)">Annuler</button><button class="btn btn-primary" [disabled]="busy()" (click)="doCreate()">Créer</button></div>
        </div>
      </div>
    }

    @if (sel(); as u) {
      <div class="modal-backdrop" (click)="sel.set(null)">
        <div class="modal wide" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <div class="row"><h2 style="margin:0">{{ u.first_name }} {{ u.last_name }}</h2><span class="badge" [ngClass]="u.is_active ? 'badge-success' : 'badge-neutral'">{{ u.is_active ? 'Actif' : 'Désactivé' }}</span></div>
          <p class="soft mono">{{ u.username }} · {{ u.email || 'sans e-mail' }}</p>
          @if (formError()) { <div class="alert alert-danger" style="margin:12px 0">{{ formError() }}</div> }
          @if (tempPassword()) { <div class="alert alert-warning" style="margin:12px 0">Mot de passe temporaire (affiché une seule fois) : <strong class="mono">{{ tempPassword() }}</strong></div> }
          @if (isSelf(u)) { <div class="alert alert-info" style="margin:12px 0">C'est votre compte : vous ne pouvez pas modifier vos propres rôles ni permissions, ni vous désactiver.</div> }

          @if (auth.can('user.update')) {
            <h3 style="margin-top:16px">Informations</h3>
            <div class="form-grid" style="margin-top:8px">
              <div class="field"><label>Prénom</label><input class="input" [(ngModel)]="edit.first_name" /></div>
              <div class="field"><label>Nom</label><input class="input" [(ngModel)]="edit.last_name" /></div>
              <div class="field"><label>E-mail</label><input class="input" type="email" [(ngModel)]="edit.email" [class.invalid]="errs()['email']" /><span class="field-error">{{ errs()['email'] }}</span></div>
              <div class="field"><label>Téléphone</label><input class="input" [(ngModel)]="edit.phone" /></div>
            </div>
            <p style="margin-top:8px"><button class="btn btn-sm" [disabled]="busy()" (click)="saveInfo(u)">Enregistrer les informations</button></p>
          }

          <h3 style="margin-top:16px">Rôles</h3>
          <div class="chips">
            @for (r of roles(); track r.id) {
              <label class="chip" [class.on]="has(u, r)"><input type="checkbox" [checked]="has(u, r)" [disabled]="isSelf(u) || !auth.can('user.assign_roles') || !r.is_active" (change)="toggleRole(u, r, $any($event.target).checked)" /> {{ r.name }}</label>
            }
          </div>

          @if (auth.can('user.assign_roles')) {
            <h3 style="margin-top:16px">Ajustements de permissions</h3>
            <p class="soft">En plus de ses rôles. « Accorder » ajoute une permission, « Refuser » en retire une. Effective : {{ u.effective_permissions?.length ?? 0 }} permission(s).</p>
            <div class="row">
              <select class="input" style="width:auto;flex:1" [(ngModel)]="ovCode" [disabled]="isSelf(u)"><option value="">Choisir une permission…</option>@for (p of perms(); track p.codename) { <option [value]="p.codename">{{ p.name }} ({{ p.codename }})</option> }</select>
              <button class="btn btn-sm" [disabled]="!ovCode || isSelf(u)" (click)="override(u, true)">Accorder</button>
              <button class="btn btn-sm" [disabled]="!ovCode || isSelf(u)" (click)="override(u, false)">Refuser</button>
            </div>
            @for (o of u.permission_overrides ?? []; track o.codename) {
              <div class="ov"><span class="badge" [ngClass]="o.granted ? 'badge-success' : 'badge-danger'">{{ o.granted ? 'Accordée' : 'Refusée' }}</span><span class="mono">{{ o.codename }}</span>
                <span class="spacer"></span><button class="btn btn-sm btn-ghost" [disabled]="isSelf(u)" (click)="removeOverride(u, o.codename)">Retirer</button></div>
            }
          }

          @if (auth.can('audit.view')) {
            <h3 style="margin-top:16px">Historique des accès et permissions</h3>
            @for (e of history(); track e.id) {
              <div class="ov"><span class="mono muted">{{ e.created_at | date: 'dd/MM/yyyy HH:mm' }}</span><span class="badge badge-info">{{ e.action }}</span>
                <span class="soft">{{ e.username || 'Système' }}</span>@if (e.reason) { <em class="soft">« {{ e.reason }} »</em> }</div>
            } @empty { <p class="muted">Aucun événement.</p> }
          }

          <div class="modal-actions" style="justify-content:space-between">
            <div class="row">
              @if (auth.can('user.manage_status') && !isSelf(u)) {
                @if (u.is_active) { <button class="btn btn-sm btn-danger" (click)="deactivating.set(u)">Désactiver le compte</button> }
                @else { <button class="btn btn-sm btn-success" (click)="setActive(u, true)">Réactiver</button> }
              }
              @if (auth.can('user.reset_password') && !isSelf(u)) { <button class="btn btn-sm" (click)="reset(u)">Réinitialiser le mot de passe</button> }
            </div>
            <button class="btn" (click)="sel.set(null)">Fermer</button>
          </div>
        </div>
      </div>
    }
    @if (deactivating(); as u) {
      <wk-confirm title="Désactiver le compte" confirmLabel="Désactiver" [danger]="true" [askReason]="true" [reasonRequired]="false" reasonLabel="Motif (facultatif)" (cancel)="deactivating.set(null)" (confirm)="deactivate(u, $event)">
        {{ u.username }} ne pourra plus se connecter et ses sessions seront refusées immédiatement.
      </wk-confirm>
    }
  `,
  styles: [`
    .filters{display:flex;gap:10px;flex-wrap:wrap;padding:16px;border-bottom:1px solid var(--wk-border)}.filters .input{width:auto;min-width:220px;min-height:40px}
    .modal.wide{width:min(720px,100%)}
    .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
    .chip{display:inline-flex;gap:8px;align-items:center;padding:7px 12px;border:1px solid var(--wk-border);border-radius:999px;cursor:pointer}
    .chip.on{background:var(--wk-info-bg);border-color:var(--wk-royal);color:var(--wk-royal-dark)}
    .ov{display:flex;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--wk-border);margin-top:6px}
  `],
})
export class UsersComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  auth = inject(AuthService);

  search = ''; active = ''; page = 1;
  rows = signal<UserRow[]>([]); total = signal(0); error = signal('');
  roles = signal<Role[]>([]); perms = signal<PermissionDef[]>([]);
  sel = signal<UserRow | null>(null);
  create = signal<any>(null);
  deactivating = signal<UserRow | null>(null);
  formError = signal(''); errs = signal<Record<string, string>>({}); busy = signal(false); tempPassword = signal('');
  ovCode = '';
  edit = { first_name: '', last_name: '', email: '', phone: '' };
  history = signal<AuditEntry[]>([]);

  ngOnInit() {
    this.load();
    if (this.auth.can('role.view')) {
      this.api.get<Page<Role>>('/roles/', { page_size: 100 }).subscribe(p => this.roles.set(p.results));
      this.api.get<PermissionDef[]>('/permissions/').subscribe(p => this.perms.set(p));
    }
  }
  isSelf(u: UserRow) { return u.uuid === this.auth.user()?.uuid; }
  has(u: UserRow, r: Role) { return u.roles.some(x => x.codename === r.codename); }
  reload() { this.page = 1; this.load(); }
  load() {
    this.api.get<Page<UserRow>>('/users/', { search: this.search, is_active: this.active, page: this.page }).subscribe({
      next: p => { this.rows.set(p.results); this.total.set(p.count); this.error.set(''); }, error: e => this.error.set(errorMessage(e)) });
  }
  openDetail(u: UserRow) {
    this.formError.set(''); this.tempPassword.set('');
    this.errs.set({});
    this.api.get<UserRow>(`/users/${u.uuid}/`).subscribe({ next: d => { this.sel.set(d); this.fill(d); this.loadHistory(d); }, error: e => this.toast.error(errorMessage(e)) });
  }
  private fill(d: UserRow) { this.edit = { first_name: d.first_name, last_name: d.last_name, email: d.email, phone: d.phone }; }
  private loadHistory(d: UserRow) {
    if (!this.auth.can('audit.view')) return;
    this.api.get<Page<AuditEntry>>('/audit/', { object_id: d.uuid, page_size: 15 }).subscribe({ next: p => this.history.set(p.results), error: () => this.history.set([]) });
  }
  private refresh(u: UserRow) { this.api.get<UserRow>(`/users/${u.uuid}/`).subscribe(d => { this.sel.set(d); this.loadHistory(d); }); this.load(); }
  saveInfo(u: UserRow) {
    this.busy.set(true); this.formError.set(''); this.errs.set({});
    this.api.patch<UserRow>(`/users/${u.uuid}/`, this.edit).subscribe({
      next: d => { this.busy.set(false); this.sel.set(d); this.toast.success('Informations mises à jour.'); this.loadHistory(d); this.load(); },
      error: e => { this.busy.set(false); this.errs.set(fieldErrors(e)); this.formError.set(errorMessage(e)); },
    });
  }

  openCreate() { this.formError.set(''); this.errs.set({}); this.create.set({ username: '', email: '', first_name: '', last_name: '', phone: '', password: '' }); }
  doCreate() {
    this.busy.set(true); this.formError.set(''); this.errs.set({});
    this.api.post<UserRow>('/users/', this.create()).subscribe({
      next: u => { this.busy.set(false); this.create.set(null); this.toast.success('Utilisateur créé. Attribuez-lui maintenant un rôle.'); this.load(); this.openDetail(u); },
      error: e => { this.busy.set(false); this.errs.set(fieldErrors(e)); this.formError.set(errorMessage(e)); },
    });
  }
  toggleRole(u: UserRow, r: Role, on: boolean) {
    const req = on ? this.api.post(`/users/${u.uuid}/roles/`, { role: r.id }) : this.api.post(`/users/${u.uuid}/roles/remove/`, { role: r.id });
    req.subscribe({ next: () => { this.toast.success(on ? `Rôle « ${r.name} » attribué.` : `Rôle « ${r.name} » retiré.`); this.refresh(u); }, error: e => { this.formError.set(errorMessage(e)); this.refresh(u); } });
  }
  override(u: UserRow, granted: boolean) {
    this.api.post(`/users/${u.uuid}/permissions/`, { codename: this.ovCode, granted }).subscribe({ next: () => { this.ovCode = ''; this.refresh(u); }, error: e => this.formError.set(errorMessage(e)) });
  }
  removeOverride(u: UserRow, codename: string) {
    this.api.delete(`/users/${u.uuid}/permissions/`, { codename }).subscribe({ next: () => this.refresh(u), error: e => this.formError.set(errorMessage(e)) });
  }
  setActive(u: UserRow, on: boolean) { this.api.post(`/users/${u.uuid}/${on ? 'activate' : 'deactivate'}/`).subscribe({ next: () => { this.toast.success('Compte mis à jour.'); this.refresh(u); }, error: e => this.formError.set(errorMessage(e)) }); }
  deactivate(u: UserRow, reason: string) {
    this.api.post(`/users/${u.uuid}/deactivate/`, { reason }).subscribe({ next: () => { this.deactivating.set(null); this.toast.success('Compte désactivé.'); this.refresh(u); }, error: e => { this.deactivating.set(null); this.formError.set(errorMessage(e)); } });
  }
  reset(u: UserRow) {
    this.api.post<{ temporary_password: string }>(`/users/${u.uuid}/reset-password/`).subscribe({ next: r => this.tempPassword.set(r.temporary_password), error: e => this.formError.set(errorMessage(e)) });
  }
}
