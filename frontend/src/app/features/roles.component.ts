import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { Page, PermissionDef, Role } from '../core/models';
import { ToastService } from '../core/toast.service';
import { PageHeaderComponent } from '../shared/ui';

@Component({
  selector: 'wk-roles', standalone: true,
  imports: [CommonModule, FormsModule, PageHeaderComponent],
  template: `
    <div class="page">
      <wk-page-header title="Rôles et permissions" subtitle="Les rôles regroupent des permissions. Chaque changement est tracé dans le journal d'audit." />
      @if (error()) { <div class="alert alert-danger" style="margin-bottom:16px">{{ error() }}</div> }
      <div class="layout">
        <aside class="card list">
          @for (r of roles(); track r.id) {
            <button class="role" [class.active]="sel()?.id === r.id" (click)="select(r)">
              <strong>{{ r.name }}</strong><small class="muted">{{ r.codename }} · {{ r.user_count }} utilisateur(s)</small>
              @if (r.is_system) { <span class="badge badge-info">Système</span> }
            </button>
          }
          @if (auth.can('role.manage')) { <button class="btn btn-sm" (click)="newRole.set(true)">+ Nouveau rôle</button> }
        </aside>

        @if (sel(); as r) {
          <section class="card">
            <div class="card-title"><div><h2>{{ r.name }}</h2><p class="soft">{{ r.description }}</p></div>
              @if (auth.can('role.manage')) { <button class="btn btn-primary" [disabled]="!dirty() || busy()" (click)="save()">Enregistrer les permissions</button> }
            </div>
            @for (cat of categories(); track cat) {
              <h3 class="cat">{{ cat }}</h3>
              <div class="perms">
                @for (p of byCat(cat); track p.codename) {
                  <label class="check perm"><input type="checkbox" [checked]="draft().has(p.codename)" [disabled]="!auth.can('role.manage')" (change)="toggle(p.codename, $any($event.target).checked)" />
                    <span>{{ p.name }}<small class="muted mono">{{ p.codename }}</small></span></label>
                }
              </div>
            }
            @if (dirty()) {
              <div class="field" style="margin-top:16px"><label>Motif de la modification (facultatif)</label><input class="input" [(ngModel)]="reason" /></div>
            }
          </section>
        }
      </div>
    </div>
    @if (newRole()) {
      <div class="modal-backdrop" (click)="newRole.set(false)"><div class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
        <h2>Nouveau rôle</h2>
        <div class="form-grid">
          <div class="field"><label class="req">Code</label><input class="input" [(ngModel)]="nr.codename" placeholder="ex. archiviste" /></div>
          <div class="field"><label class="req">Nom</label><input class="input" [(ngModel)]="nr.name" /></div>
          <div class="field wide"><label>Description</label><input class="input" [(ngModel)]="nr.description" /></div>
        </div>
        <div class="modal-actions"><button class="btn" (click)="newRole.set(false)">Annuler</button><button class="btn btn-primary" [disabled]="!nr.codename || !nr.name" (click)="create()">Créer</button></div>
      </div></div>
    }
  `,
  styles: [`
    .layout{display:grid;grid-template-columns:280px minmax(0,1fr);gap:16px;align-items:start}
    .list{display:flex;flex-direction:column;gap:6px;padding:12px}
    .role{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;background:none;border:1px solid transparent;border-radius:12px;padding:10px 12px;cursor:pointer;font:inherit}
    .role:hover{background:var(--wk-sky-50)}.role.active{background:var(--wk-info-bg);border-color:var(--wk-royal)}
    .cat{margin:18px 0 8px;color:var(--wk-text-soft);text-transform:uppercase;font-size:12px;letter-spacing:.05em}
    .perms{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px}
    .perm{padding:10px 12px;border:1px solid var(--wk-border);border-radius:10px;align-items:flex-start}
    .perm span{display:flex;flex-direction:column}
    @media (max-width:900px){.layout{grid-template-columns:minmax(0,1fr)}}
  `],
})
export class RolesComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  auth = inject(AuthService);

  roles = signal<Role[]>([]); perms = signal<PermissionDef[]>([]); sel = signal<Role | null>(null);
  draft = signal<Set<string>>(new Set()); error = signal(''); busy = signal(false); reason = '';
  newRole = signal(false); nr = { codename: '', name: '', description: '' };

  categories = () => [...new Set(this.perms().map(p => p.category))];
  byCat(c: string) { return this.perms().filter(p => p.category === c); }
  dirty = () => {
    const r = this.sel(); if (!r) return false;
    const d = this.draft();
    return d.size !== r.permissions.length || r.permissions.some(p => !d.has(p));
  };

  ngOnInit() {
    this.api.get<PermissionDef[]>('/permissions/').subscribe(p => this.perms.set(p));
    this.load();
  }
  load(keep?: number) {
    this.api.get<Page<Role>>('/roles/', { page_size: 100 }).subscribe({
      next: p => { this.roles.set(p.results); const cur = p.results.find(r => r.id === (keep ?? this.sel()?.id)) ?? p.results[0]; if (cur) this.select(cur); },
      error: e => this.error.set(errorMessage(e)),
    });
  }
  select(r: Role) { this.sel.set(r); this.draft.set(new Set(r.permissions)); this.reason = ''; this.error.set(''); }
  toggle(code: string, on: boolean) { const d = new Set(this.draft()); on ? d.add(code) : d.delete(code); this.draft.set(d); }
  save() {
    this.busy.set(true); this.error.set('');
    this.api.put<Role>(`/roles/${this.sel()!.id}/permissions/`, { permissions: [...this.draft()], reason: this.reason }).subscribe({
      next: r => { this.busy.set(false); this.toast.success('Permissions du rôle mises à jour.'); this.load(r.id); },
      error: e => { this.busy.set(false); this.error.set(errorMessage(e)); },
    });
  }
  create() {
    this.api.post<Role>('/roles/', this.nr).subscribe({
      next: r => { this.newRole.set(false); this.nr = { codename: '', name: '', description: '' }; this.toast.success('Rôle créé.'); this.load(r.id); },
      error: e => this.toast.error(errorMessage(e)),
    });
  }
}
