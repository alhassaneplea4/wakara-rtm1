import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { DeclarationListItem, Hospital, Page, STATUS_LABELS, Status } from '../core/models';
import { ToastService } from '../core/toast.service';
import { IconComponent, PageHeaderComponent, PaginationComponent, StatusBadgeComponent } from '../shared/ui';

type Mode = 'all' | 'secretariat' | 'validation';

const MODE_TEXT: Record<Mode, { title: string; subtitle: string; statuses: Status[] }> = {
  all: { title: 'Déclarations de naissance', subtitle: 'Déclarations reçues des hôpitaux et maternités', statuses: [] },
  secretariat: { title: 'File du secrétariat', subtitle: 'Dossiers transmis à compléter et à soumettre à validation', statuses: ['TRANSMITTED', 'IN_COMPLETION', 'TO_CORRECT_SECRETARIAT'] },
  validation: { title: 'File de validation', subtitle: 'Dossiers en attente de la décision définitive', statuses: ['PENDING_VALIDATION'] },
};

@Component({
  selector: 'wk-declarations-list', standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, DatePipe, IconComponent, PageHeaderComponent, PaginationComponent, StatusBadgeComponent],
  template: `
    <div class="page">
      <wk-page-header [title]="text.title" [subtitle]="text.subtitle">
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
              <option value="">{{ mode === 'all' ? 'Tous les statuts' : 'Tous (file)' }}</option>
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
            </tr></thead>
            <tbody>
              @if (loading()) { @for (i of [1,2,3,4,5]; track i) { <tr><td colspan="8"><div class="skeleton" style="height:20px"></div></td></tr> } }
              @else {
                @for (d of rows(); track d.uuid) {
                  <tr class="clickable" (click)="open(d.uuid)" tabindex="0" (keyup.enter)="open(d.uuid)">
                    <td class="mono"><a [routerLink]="['/declarations', d.uuid]" (click)="$event.stopPropagation()">{{ d.reference }}</a></td>
                    <td>{{ d.child_name || '—' }}</td><td>{{ d.hospital_name || 'Non renseigné' }}</td>
                    <td class="mono">{{ d.birth_date | date: 'dd/MM/yyyy' }}</td><td class="mono">{{ d.received_at | date: 'dd/MM/yyyy' }}</td>
                    <td>{{ d.assigned_to_name || '—' }}</td><td><wk-status [status]="d.status" /></td>
                    <td class="mono">{{ d.updated_at | date: 'dd/MM/yyyy HH:mm' }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="8"><div class="empty"><strong>Aucun dossier</strong>{{ hasFilters() ? 'Aucun résultat pour ces filtres.' : 'Rien à afficher pour le moment.' }}</div></td></tr>
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
    .filters{display:flex;gap:10px;flex-wrap:wrap;padding:16px;border-bottom:1px solid var(--wk-border);align-items:center}
    .grow{flex:1;min-width:220px}
    .filters .input{min-height:40px}
    .m{margin:16px}
  `],
})
export class DeclarationsListComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);
  auth = inject(AuthService);

  mode: Mode = 'all';
  text = MODE_TEXT.all;
  labels = STATUS_LABELS;
  statusOptions: Status[] = [];

  search = ''; status = ''; hospital = ''; agent = ''; from = ''; to = ''; ordering = '-updated_at'; page = 1;
  rows = signal<DeclarationListItem[]>([]);
  total = signal(0);
  loading = signal(true);
  error = signal('');
  hospitals = signal<Hospital[]>([]);
  agents = signal<{ uuid: string; name: string }[]>([]);

  ngOnInit() {
    this.mode = (this.route.snapshot.data['mode'] as Mode) ?? 'all';
    this.text = MODE_TEXT[this.mode];
    this.statusOptions = this.mode === 'all' ? (Object.keys(STATUS_LABELS) as Status[]) : this.text.statuses;
    this.route.queryParamMap.subscribe(q => {
      this.search = q.get('search') ?? '';
      this.status = q.get('status') ?? '';
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

  hasFilters = () => !!(this.search || this.status || this.hospital || this.agent || this.from || this.to);
  arrow(f: string) { return this.ordering === f ? '↑' : this.ordering === '-' + f ? '↓' : ''; }
  sort(f: string) { this.ordering = this.ordering === f ? '-' + f : f; this.load(); }
  open(uuid: string) { this.router.navigate(['/declarations', uuid]); }
  goto(p: number) { this.router.navigate([], { queryParams: { page: p }, queryParamsHandling: 'merge' }); }
  apply() { this.router.navigate([], { queryParams: { search: this.search || null, status: this.status || null, page: null }, queryParamsHandling: 'merge' }); this.page = 1; this.load(); }
  reset() { this.search = this.status = this.hospital = this.agent = this.from = this.to = ''; this.apply(); }

  private query() {
    return {
      search: this.search, status: this.status ? [this.status] : this.text.statuses, hospital: this.hospital, assigned_to: this.agent,
      received_from: this.from, received_to: this.to, ordering: this.ordering, page: this.page,
    };
  }

  load() {
    this.loading.set(true);
    this.api.get<Page<DeclarationListItem>>('/declarations/', this.query()).subscribe({
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
