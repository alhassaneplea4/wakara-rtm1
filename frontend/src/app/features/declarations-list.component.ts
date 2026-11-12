import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, Query, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { AutoRefreshService } from '../core/auto-refresh.service';
import { DeclarationListItem, Hospital, Page, STATUS_LABELS, Status } from '../core/models';
import { ToastService } from '../core/toast.service';
import { IconComponent, PageHeaderComponent, PaginationComponent, StatusBadgeComponent } from '../shared/ui';

type Mode = 'all' | 'validation';

/** Finished by the secretariat: these dossiers are followed in « Actes de naissance » (and « Délivrances »). */
const MOVED_TO_ACTES: Status[] = ['PENDING_VALIDATION', 'VALIDATED', 'DELIVERED'];

const MODE_TEXT: Record<Mode, { title: string; subtitle: string; statuses: Status[] }> = {
  all: { title: 'Déclarations de naissance', subtitle: 'Déclarations reçues des hôpitaux et maternités', statuses: [] },
  validation: { title: 'File de validation', subtitle: 'Dossiers en attente de la décision définitive', statuses: ['PENDING_VALIDATION'] },
};

@Component({
  selector: 'wk-declarations-list', standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, DatePipe, IconComponent, PageHeaderComponent, PaginationComponent, StatusBadgeComponent],
  template: `
    <div class="page">
      <wk-page-header [title]="text.title" [subtitle]="subtitle()">
        @if (mode === 'all' && auth.can('data.export')) {
          <button class="btn" (click)="export()"><wk-icon name="download" [size]="16" /> Exporter (CSV)</button>
        }
        @if (mode === 'all' && auth.can('declaration.create')) {
          <a class="btn btn-primary" routerLink="/declarations/new"><wk-icon name="plus" [size]="16" /> Nouvelle déclaration</a>
        }
      </wk-page-header>

      <section class="card flush">
        <div class="filters">
          <div class="field grow"><label class="sr-only" for="q">Recherche</label>
            <input id="q" class="input" [(ngModel)]="search" (keyup.enter)="apply()" placeholder="Référence, nom de l'enfant, n° de l'acte…" /></div>
          <div class="field"><label class="sr-only" for="st">Statut</label>
            <select id="st" class="input" [(ngModel)]="status" (ngModelChange)="apply()">
              <option value="">{{ mode !== 'all' ? 'Tous (file)' : hidesActes() ? 'Dossiers en cours' : 'Tous les statuts' }}</option>
              @for (s of statusOptions; track s) { <option [value]="s">{{ labels[s] }}</option> }
            </select></div>
          @if (mode === 'all') {
            <div class="field"><label class="sr-only" for="hp">Établissement</label>
              <select id="hp" class="input" [(ngModel)]="hospital" (ngModelChange)="apply()">
                <option value="">Tous les établissements</option>
                @for (h of hospitals(); track h.uuid) { <option [value]="h.uuid">{{ h.name }}</option> }
              </select></div>
            @if (agents().length) {
              <div class="field"><label class="sr-only" for="ag">Responsable</label>
                <select id="ag" class="input" [(ngModel)]="agent" (ngModelChange)="apply()">
                  <option value="">Tous les responsables</option>
                  @for (a of agents(); track a.uuid) { <option [value]="a.uuid">{{ a.name }}</option> }
                </select></div>
            }
            <div class="field"><label class="sr-only" for="df">Reçues depuis</label><input id="df" type="date" class="input" [(ngModel)]="from" (ngModelChange)="apply()" title="Reçues à partir du" /></div>
            <div class="field"><label class="sr-only" for="dt">Reçues jusqu'au</label><input id="dt" type="date" class="input" [(ngModel)]="to" (ngModelChange)="apply()" title="Reçues jusqu'au" /></div>
          }
          <button class="btn" (click)="apply()"><wk-icon name="search" [size]="16" /> Filtrer</button>
          @if (hasFilters()) { <button class="btn btn-ghost" (click)="reset()">Réinitialiser</button> }
          @if (statuses.length) {
            <p class="scope" role="status">Sélection du tableau de bord : <strong>{{ scopeLabel || statuses.length + ' statuts' }}</strong>
              <button type="button" class="btn btn-sm btn-ghost" (click)="clearScope()" aria-label="Retirer cette sélection">Retirer ×</button></p>
          }
        </div>

        @if (error()) { <div class="alert alert-danger m">{{ error() }}</div> }

        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th class="sortable" (click)="sort('reference')">Référence {{ arrow('reference') }}</th>
              <th>Enfant</th><th>Établissement</th>
              <th class="sortable" (click)="sort('birth_date')">Naissance {{ arrow('birth_date') }}</th>
              <th class="sortable" (click)="sort('received_at')">Reçue le {{ arrow('received_at') }}</th>
              <th>Responsable</th><th>Statut</th>
              <th class="sortable" (click)="sort('updated_at')">Modifiée {{ arrow('updated_at') }}</th>
              <th><span class="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              @if (loading()) { @for (i of [1,2,3,4,5]; track i) { <tr><td colspan="9"><div class="skeleton" style="height:20px"></div></td></tr> } }
              @else {
                @for (d of rows(); track d.uuid) {
                  <tr class="clickable" (click)="open(d.uuid)" tabindex="0" (keyup.enter)="open(d.uuid)">
                    <td class="mono"><a [routerLink]="['/declarations', d.uuid]" (click)="$event.stopPropagation()">{{ d.reference }}</a></td>
                    <td class="uc">{{ d.child_name || '—' }}</td><td class="uc">{{ d.hospital_name || 'Non renseigné' }}</td>
                    <td class="mono">{{ d.birth_date | date: 'dd/MM/yyyy' }}</td><td class="mono">{{ d.received_at | date: 'dd/MM/yyyy' }}</td>
                    <td>{{ d.assigned_to_name || '—' }}</td><td><wk-status [status]="d.status" /></td>
                    <td class="mono">{{ d.updated_at | date: 'dd/MM/yyyy HH:mm' }}</td>
                    <td class="act">@if (d.can_edit) { <a class="edit-btn" [routerLink]="['/declarations', d.uuid, 'edit']" (click)="$event.stopPropagation()" (keyup.enter)="$event.stopPropagation()" title="Modifier" [attr.aria-label]="'Modifier la déclaration ' + d.reference"><wk-icon name="edit" [size]="16" /></a> }</td>
                  </tr>
                } @empty {
                  <tr><td colspan="9"><div class="empty"><strong>Aucun dossier</strong>{{ hasFilters() ? 'Aucun résultat pour ces filtres.' : 'Rien à afficher pour le moment.' }}</div></td></tr>
                }
              }
            </tbody>
          </table>
        </div>
        <wk-pagination [page]="page" [total]="total()" [pageSize]="20" (pageChange)="goto($event)" />
      </section>
    </div>
  `,
  styles: [`
    .scope{flex:1 1 100%;margin:4px 0 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--wk-text-soft)}
    .filters{display:flex;gap:10px;flex-wrap:wrap;padding:16px;border-bottom:1px solid var(--wk-border);align-items:center}
    .grow{flex:1;min-width:220px}
    .filters .input{min-height:40px}
    .m{margin:16px}
    .act{text-align:right;white-space:nowrap;width:1%}
    /* Pencil icon only. On a mouse the action appears on row hover or keyboard focus; on touch screens it is always visible. */
    .edit-btn{display:inline-grid;place-items:center;width:36px;height:36px;border-radius:50%;color:var(--wk-royal);border:1px solid transparent;transition:opacity .15s,background .15s}
    .edit-btn:hover{background:var(--wk-info-bg);text-decoration:none}
    .edit-btn:focus-visible{outline:2px solid var(--wk-royal);outline-offset:2px}
    @media (hover:hover) and (pointer:fine){
      .edit-btn{opacity:0}
      tr:hover .edit-btn,tr:focus-within .edit-btn,.edit-btn:focus-visible{opacity:1}
    }
    @media (hover:none),(pointer:coarse){.edit-btn{opacity:1;width:44px;height:44px;border-color:var(--wk-border);background:#fff}}
    .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  `],
})
export class DeclarationsListComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);
  private autoRefresh = inject(AutoRefreshService);
  private lastQuery: Query | null = null;
  auth = inject(AuthService);

  mode: Mode = 'all';
  text = MODE_TEXT.all;
  labels = STATUS_LABELS;
  statusOptions: Status[] = [];

  search = ''; status = ''; hospital = ''; agent = ''; from = ''; to = ''; ordering = '-updated_at'; page = 1;
  /** Several statuses at once, set by a dashboard figure (`?statuses=A,B&label=…`); a single status chosen here replaces them. */
  statuses: string[] = []; scopeLabel = '';
  rows = signal<DeclarationListItem[]>([]);
  total = signal(0);
  loading = signal(true);
  error = signal('');
  hospitals = signal<Hospital[]>([]);
  agents = signal<{ uuid: string; name: string }[]>([]);

  ngOnInit() {
    this.mode = (this.route.snapshot.data['mode'] as Mode) ?? 'all';
    this.text = MODE_TEXT[this.mode];
    // every 30 s: same filters as the last search the user applied, without the loading flash
    this.autoRefresh.on(this.destroyRef, () => this.silentReload());
    // the secretariat never sees the agents' drafts (they stay in the agents' own space until transmitted)
    const seesDrafts = this.auth.can('declaration.create') || this.auth.can('declaration.archive') || !this.auth.can('declaration.view_all');
    this.statusOptions = this.mode === 'all' ? (Object.keys(STATUS_LABELS) as Status[]).filter(s => seesDrafts || s !== 'DRAFT') : this.text.statuses;
    this.route.queryParamMap.subscribe(q => {
      this.search = q.get('search') ?? '';
      this.status = q.get('status') ?? '';
      this.statuses = (q.get('statuses') ?? '').split(',').filter(Boolean);
      this.scopeLabel = q.get('label') ?? '';
      if (this.mode === 'all') {
        this.hospital = q.get('hospital') ?? ''; this.agent = q.get('agent') ?? '';
        this.from = q.get('from') ?? ''; this.to = q.get('to') ?? '';
      }
      this.page = Number(q.get('page') ?? 1);
      this.load();
    });
    if (this.mode === 'all' && this.auth.can('hospital.view')) {
      this.api.get<Page<Hospital>>('/hospitals/', { page_size: 100 }).subscribe(p => this.hospitals.set(p.results));
    }
    if (this.mode === 'all' && this.auth.can('declaration.view_all')) {
      this.api.get<{ uuid: string; name: string }[]>('/declarations/agents/').subscribe({ next: a => this.agents.set(a), error: () => undefined });
    }
  }

  /**
   * Users who follow the acts (secretariat, administrator) get a simple list: without a search or a chosen status,
   * the dossiers waiting for validation, validated or delivered are not shown here but in « Actes de naissance » /
   * « Délivrances ». A search, a chosen status or a dashboard figure still reaches every dossier.
   */
  hidesActes = () => this.mode === 'all' && this.auth.can('acte.view');
  subtitle() {
    return this.hidesActes() ? "Dossiers en cours. Ceux en attente de validation ou validés sont dans « Actes de naissance », les actes remis dans « Délivrances »." : this.text.subtitle;
  }
  private defaultStatuses(): Status[] {
    return this.hidesActes() && !this.search ? (Object.keys(STATUS_LABELS) as Status[]).filter(s => !MOVED_TO_ACTES.includes(s)) : this.text.statuses;
  }

  hasFilters = () => !!(this.search || this.status || this.statuses.length || this.hospital || this.agent || this.from || this.to);
  arrow(f: string) { return this.ordering === f ? '↑' : this.ordering === '-' + f ? '↓' : ''; }
  sort(f: string) { this.ordering = this.ordering === f ? '-' + f : f; this.load(); }
  open(uuid: string) { this.router.navigate(['/declarations', uuid]); }
  goto(p: number) { this.router.navigate([], { queryParams: { page: p }, queryParamsHandling: 'merge' }); }
  apply() {
    if (this.status) { this.statuses = []; this.scopeLabel = ''; }   // one status picked here replaces the dashboard's selection
    this.router.navigate([], {
      queryParams: {
        search: this.search || null, status: this.status || null, statuses: this.statuses.join(',') || null, label: this.statuses.length ? this.scopeLabel || null : null,
        hospital: this.hospital || null, agent: this.agent || null, from: this.from || null, to: this.to || null, page: null,
      },
      queryParamsHandling: 'merge',
    });
    this.page = 1; this.load();
  }
  reset() { this.search = this.status = this.hospital = this.agent = this.from = this.to = this.scopeLabel = ''; this.statuses = []; this.apply(); }
  clearScope() { this.statuses = []; this.scopeLabel = ''; this.apply(); }

  private query() {
    return {
      search: this.search, status: this.status ? [this.status] : this.statuses.length ? this.statuses : this.defaultStatuses(), hospital: this.hospital, assigned_to: this.agent,
      received_from: this.from, received_to: this.to, ordering: this.ordering, page: this.page,
    };
  }

  private silentReload() {
    if (!this.lastQuery) return;
    this.api.get<Page<DeclarationListItem>>('/declarations/', this.lastQuery).subscribe({
      next: p => { this.rows.set(p.results); this.total.set(p.count); this.error.set(''); }, error: () => undefined,
    });
  }

  load() {
    this.loading.set(true);
    this.lastQuery = this.query();
    this.api.get<Page<DeclarationListItem>>('/declarations/', this.lastQuery).subscribe({
      next: p => { this.rows.set(p.results); this.total.set(p.count); this.loading.set(false); this.error.set(''); },
      error: e => { this.loading.set(false); this.error.set(errorMessage(e)); },
    });
  }

  export() {
    this.api.blob('/declarations/export/', this.query()).subscribe({
      next: b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'declarations.csv'; a.click(); URL.revokeObjectURL(a.href); this.toast.success('Export téléchargé (action tracée).'); },
      error: e => this.toast.error(errorMessage(e)),
    });
  }
}
