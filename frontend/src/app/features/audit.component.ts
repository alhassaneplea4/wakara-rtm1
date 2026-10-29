import { CommonModule, DatePipe, JsonPipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { AuditEntry, Page } from '../core/models';
import { ToastService } from '../core/toast.service';
import { IconComponent, PageHeaderComponent, PaginationComponent } from '../shared/ui';

@Component({
  selector: 'wk-audit', standalone: true,
  imports: [CommonModule, FormsModule, DatePipe, JsonPipe, IconComponent, PageHeaderComponent, PaginationComponent],
  template: `
    <div class="page">
      <wk-page-header title="Journal d'activité" subtitle="Historique infalsifiable des opérations. La consultation et l'export sont eux-mêmes tracés.">
        @if (auth.can('data.export')) { <button class="btn" (click)="export()"><wk-icon name="download" [size]="16" /> Exporter (CSV)</button> }
      </wk-page-header>
      <section class="card flush">
        <div class="filters">
          <input class="input" [(ngModel)]="search" (keyup.enter)="reload()" placeholder="Utilisateur, objet, motif…" aria-label="Recherche" />
          <select class="input" [(ngModel)]="action" (ngModelChange)="reload()" aria-label="Action"><option value="">Toutes les actions</option>@for (a of actions(); track a) { <option [value]="a">{{ a }}</option> }</select>
          <input class="input" type="date" [(ngModel)]="from" (ngModelChange)="reload()" aria-label="Du" />
          <input class="input" type="date" [(ngModel)]="to" (ngModelChange)="reload()" aria-label="Au" />
          <button class="btn" (click)="reload()">Filtrer</button>
        </div>
        @if (error()) { <div class="alert alert-danger" style="margin:16px">{{ error() }}</div> }
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Date</th><th>Utilisateur</th><th>Action</th><th>Objet</th><th>IP</th><th></th></tr></thead>
          <tbody>
            @for (e of rows(); track e.id) {
              <tr><td class="mono">{{ e.created_at | date: 'dd/MM/yyyy HH:mm:ss' }}</td><td>{{ e.username || 'Système' }}</td>
                <td><span class="badge badge-info">{{ e.action }}</span></td><td>{{ e.object_type }} <span class="muted">{{ e.object_repr }}</span></td>
                <td class="mono">{{ e.ip_address || '—' }}</td>
                <td><button class="btn btn-sm btn-ghost" (click)="open.set(open() === e.id ? null : e.id)">Détails</button></td></tr>
              @if (open() === e.id) {
                <tr><td colspan="6" class="detail">
                  @if (e.reason) { <p><strong>Motif :</strong> {{ e.reason }}</p> }
                  <pre>{{ e.changes | json }}</pre></td></tr>
              }
            } @empty { <tr><td colspan="6"><div class="empty"><strong>Aucun événement</strong></div></td></tr> }
          </tbody></table></div>
        <wk-pagination [page]="page" [total]="total()" [pageSize]="20" (pageChange)="page = $event; load()" />
      </section>
    </div>
  `,
  styles: ['.filters{display:flex;gap:10px;flex-wrap:wrap;padding:16px;border-bottom:1px solid var(--wk-border)}.filters .input{width:auto;min-width:170px;min-height:40px}.detail{background:var(--wk-sky-50)}pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px}'],
})
export class AuditComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  auth = inject(AuthService);
  search = ''; action = ''; from = ''; to = ''; page = 1;
  rows = signal<AuditEntry[]>([]); total = signal(0); error = signal(''); actions = signal<string[]>([]); open = signal<number | null>(null);

  ngOnInit() { this.load(); this.api.get<string[]>('/audit/actions/').subscribe({ next: a => this.actions.set(a), error: () => undefined }); }
  reload() { this.page = 1; this.load(); }
  private q() { return { search: this.search, action: this.action, date_from: this.from, date_to: this.to, page: this.page }; }
  load() {
    this.api.get<Page<AuditEntry>>('/audit/', this.q()).subscribe({
      next: p => { this.rows.set(p.results); this.total.set(p.count); this.error.set(''); }, error: e => this.error.set(errorMessage(e)) });
  }
  export() {
    this.api.blob('/audit/export/', this.q()).subscribe({
      next: b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'journal-audit.csv'; a.click(); URL.revokeObjectURL(a.href); },
      error: e => this.toast.error(errorMessage(e)) });
  }
}
