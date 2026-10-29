import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService, errorMessage } from '../core/api.service';
import { Acte, Page, STATUS_LABELS, Status } from '../core/models';
import { PageHeaderComponent, PaginationComponent, StatusBadgeComponent } from '../shared/ui';

@Component({
  selector: 'wk-actes-list', standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, PageHeaderComponent, PaginationComponent, StatusBadgeComponent],
  template: `
    <div class="page">
      <wk-page-header title="Actes de naissance" subtitle="Dossiers d'actes en cours d'élaboration, validés et délivrés" />
      <section class="card flush">
        <div class="filters">
          <input class="input grow" [(ngModel)]="search" (keyup.enter)="reload()" placeholder="N° d'acte, référence, nom de l'enfant…" aria-label="Recherche" />
          <select class="input" [(ngModel)]="status" (ngModelChange)="reload()" aria-label="Statut">
            <option value="">Tous les statuts</option>
            @for (s of statuses; track s) { <option [value]="s">{{ labels[s] }}</option> }
          </select>
          <input class="input year" type="number" [(ngModel)]="annee" (change)="reload()" placeholder="Année" aria-label="Année" />
          <button class="btn" (click)="reload()">Filtrer</button>
        </div>
        @if (error()) { <div class="alert alert-danger" style="margin:16px">{{ error() }}</div> }
        <div class="table-wrap"><table class="table">
          <thead><tr><th>N° officiel</th><th>Année</th><th>Registre</th><th>Feuillet</th><th>Enfant</th><th>Référence</th><th>Établissement</th><th>Statut</th></tr></thead>
          <tbody>
            @for (a of rows(); track a.uuid) {
              <tr class="clickable" (click)="open(a)">
                <td class="mono"><strong>{{ a.numero_acte || '—' }}</strong></td><td class="mono">{{ a.annee ?? '—' }}</td><td>{{ a.registre || '—' }}</td><td>{{ a.feuillet || '—' }}</td>
                <td>{{ a.child_name || '—' }}</td><td class="mono">{{ a.reference }}</td><td>{{ a.hospital_name || '—' }}</td><td><wk-status [status]="a.status" /></td>
              </tr>
            } @empty { <tr><td colspan="8"><div class="empty"><strong>Aucun acte</strong>Les actes apparaissent lorsque le secrétariat prend un dossier en charge.</div></td></tr> }
          </tbody></table></div>
        <wk-pagination [page]="page" [total]="total()" (pageChange)="page = $event; load()" />
      </section>
    </div>
  `,
  styles: ['.filters{display:flex;gap:10px;flex-wrap:wrap;padding:16px;border-bottom:1px solid var(--wk-border)}.grow{flex:1;min-width:220px}.year{width:110px}.filters .input{min-height:40px;width:auto}.filters .grow{width:auto}'],
})
export class ActesListComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  labels = STATUS_LABELS;
  statuses: Status[] = ['IN_COMPLETION', 'PENDING_VALIDATION', 'TO_CORRECT_SECRETARIAT', 'VALIDATED', 'DELIVERED'];
  search = ''; status = ''; annee: number | null = null; page = 1;
  rows = signal<Acte[]>([]); total = signal(0); error = signal('');

  ngOnInit() { this.load(); }
  reload() { this.page = 1; this.load(); }
  open(a: Acte) { this.router.navigate(['/declarations', a.declaration_uuid]); }
  load() {
    this.api.get<Page<Acte>>('/actes/', { search: this.search, status: this.status ? [this.status] : [], annee: this.annee, page: this.page, ordering: '-updated_at' }).subscribe({
      next: p => { this.rows.set(p.results); this.total.set(p.count); this.error.set(''); },
      error: e => this.error.set(errorMessage(e)),
    });
  }
}
