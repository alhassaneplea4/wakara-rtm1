import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, Query, errorMessage } from '../core/api.service';
import { AutoRefreshService } from '../core/auto-refresh.service';
import { Acte, Page, STATUS_LABELS, Status } from '../core/models';
import { PageHeaderComponent, PaginationComponent, StatusBadgeComponent } from '../shared/ui';

@Component({
  selector: 'wk-actes-list', standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, PageHeaderComponent, PaginationComponent, StatusBadgeComponent],
  template: `
    <div class="page">
      <wk-page-header title="Actes de naissance" subtitle="Dossiers terminés par le secrétariat : en attente de validation ou validés. Les actes remis sont dans « Délivrances »." />
      <section class="card flush">
        <div class="filters">
          <input class="input grow" [(ngModel)]="search" (keyup.enter)="reload()" placeholder="N° d'acte, référence, nom de l'enfant…" aria-label="Recherche" />
          <select class="input" [(ngModel)]="status" (ngModelChange)="reload()" aria-label="Statut">
            <option value="">Tous les statuts</option>
            @for (s of statuses; track s) { <option [value]="s">{{ labels[s] }}</option> }
          </select>
          <input class="input year" type="number" [(ngModel)]="annee" (change)="reload()" placeholder="Année" aria-label="Année" />
          <input class="input year" type="date" [(ngModel)]="from" (change)="reload()" title="Reçus à partir du" aria-label="Reçus à partir du" />
          <input class="input year" type="date" [(ngModel)]="to" (change)="reload()" title="Reçus jusqu'au" aria-label="Reçus jusqu'au" />
          <button class="btn" (click)="reload()">Filtrer</button>
          @if (hasScope()) { <button class="btn btn-ghost" (click)="clearScope()">Retirer la sélection du tableau de bord ×</button> }
        </div>
        @if (error()) { <div class="alert alert-danger" style="margin:16px">{{ error() }}</div> }
        <div class="table-wrap"><table class="table">
          <thead><tr><th>N° officiel</th><th>Année</th><th>Registre</th><th>Feuillet</th><th>Enfant</th><th>Référence</th><th>Établissement</th><th>Statut</th></tr></thead>
          <tbody>
            @for (a of rows(); track a.uuid) {
              <tr class="clickable" (click)="open(a)">
                <td class="mono"><strong>{{ a.numero_acte || '—' }}</strong></td><td class="mono">{{ a.annee ?? '—' }}</td><td>{{ a.registre || '—' }}</td><td>{{ a.feuillet || '—' }}</td>
                <td class="uc">{{ a.child_name || '—' }}</td><td class="mono">{{ a.reference }}</td><td>{{ a.hospital_name || '—' }}</td><td><wk-status [status]="a.status" /></td>
              </tr>
            } @empty { <tr><td colspan="8"><div class="empty"><strong>Aucun acte</strong>Un dossier apparaît ici dès que le secrétariat l'a envoyé à la validation.</div></td></tr> }
          </tbody></table></div>
        <wk-pagination [page]="page" [total]="total()" (pageChange)="page = $event; load()" />
      </section>
    </div>
  `,
  styles: ['.filters{display:flex;gap:10px;flex-wrap:wrap;padding:16px;border-bottom:1px solid var(--wk-border)}.grow{flex:1;min-width:220px}.year{width:150px}.filters .input{min-height:40px;width:auto}.filters .grow{width:auto}'],
})
export class ActesListComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);
  private autoRefresh = inject(AutoRefreshService);
  private last: Query | null = null;
  labels = STATUS_LABELS;
  statuses: Status[] = ['PENDING_VALIDATION', 'VALIDATED'];
  search = ''; status = ''; annee: number | null = null; page = 1;
  /** Filters coming from the dashboard figures (`?from=&to=&hospital=&agent=`), in the URL so the link can be shared. */
  from = ''; to = ''; hospital = ''; agent = '';
  rows = signal<Acte[]>([]); total = signal(0); error = signal('');

  ngOnInit() {
    const q = this.route.snapshot.queryParamMap;
    this.status = this.statuses.includes(q.get('status') as Status) ? q.get('status')! : '';
    this.from = q.get('from') ?? ''; this.to = q.get('to') ?? ''; this.hospital = q.get('hospital') ?? ''; this.agent = q.get('agent') ?? '';
    this.load(); this.autoRefresh.on(this.destroyRef, () => this.fetch(this.last));
  }
  hasScope = () => !!(this.from || this.to || this.hospital || this.agent);
  clearScope() { this.from = this.to = this.hospital = this.agent = ''; this.router.navigate([], { queryParams: {} }); this.reload(); }
  reload() { this.page = 1; this.load(); }
  open(a: Acte) { this.router.navigate(['/declarations', a.declaration_uuid]); }
  load() {
    this.last = { search: this.search, status: this.status ? [this.status] : [], annee: this.annee, received_from: this.from, received_to: this.to, hospital: this.hospital, assigned_to: this.agent, page: this.page, ordering: '-updated_at' };
    this.fetch(this.last);
  }
  private fetch(query: Query | null) {
    if (!query) return;
    this.api.get<Page<Acte>>('/actes/', query).subscribe({
      next: p => { this.rows.set(p.results); this.total.set(p.count); this.error.set(''); },
      error: e => this.error.set(errorMessage(e)),
    });
  }
}
