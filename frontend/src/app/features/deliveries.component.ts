import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, errorMessage } from '../core/api.service';
import { Delivery, Page } from '../core/models';
import { PageHeaderComponent, PaginationComponent } from '../shared/ui';

@Component({
  selector: 'wk-deliveries', standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, DatePipe, PageHeaderComponent, PaginationComponent],
  template: `
    <div class="page">
      <wk-page-header title="Suivi des délivrances" subtitle="Historique des actes remis aux demandeurs" />
      <section class="card flush">
        <div class="filters"><input class="input" [(ngModel)]="search" (keyup.enter)="reload()" placeholder="Bénéficiaire, n° d'acte, référence…" aria-label="Recherche" /><button class="btn" (click)="reload()">Rechercher</button></div>
        @if (error()) { <div class="alert alert-danger" style="margin:16px">{{ error() }}</div> }
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Date</th><th>N° officiel</th><th>Enfant</th><th>Remis à</th><th>Qualité</th><th>Type</th><th>Agent</th></tr></thead>
          <tbody>
            @for (d of rows(); track d.uuid) {
              <tr><td class="mono">{{ d.delivered_at | date: 'dd/MM/yyyy HH:mm' }}</td>
                <td class="mono"><a [routerLink]="['/actes', d.acte_uuid, 'document']">{{ d.official_number || d.reference }}</a></td>
                <td>{{ d.child_name || '—' }}</td><td>{{ d.recipient_name }}</td><td>{{ d.recipient_relationship || '—' }}</td>
                <td><span class="badge" [ngClass]="d.is_duplicate ? 'badge-warning' : 'badge-success'">{{ d.is_duplicate ? 'Duplicata' : 'Première délivrance' }}</span></td>
                <td>{{ d.delivered_by_name }}</td></tr>
            } @empty { <tr><td colspan="7"><div class="empty"><strong>Aucune délivrance</strong>Les délivrances enregistrées apparaîtront ici.</div></td></tr> }
          </tbody></table></div>
        <wk-pagination [page]="page" [total]="total()" (pageChange)="page = $event; load()" />
      </section>
    </div>
  `,
  styles: ['.filters{display:flex;gap:10px;padding:16px;border-bottom:1px solid var(--wk-border)}.filters .input{max-width:420px;min-height:40px}'],
})
export class DeliveriesComponent implements OnInit {
  private api = inject(ApiService);
  search = ''; page = 1;
  rows = signal<Delivery[]>([]); total = signal(0); error = signal('');
  ngOnInit() { this.load(); }
  reload() { this.page = 1; this.load(); }
  load() {
    this.api.get<Page<Delivery>>('/actes/deliveries/', { search: this.search, page: this.page }).subscribe({
      next: p => { this.rows.set(p.results); this.total.set(p.count); this.error.set(''); }, error: e => this.error.set(errorMessage(e)),
    });
  }
}
