import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChartConfiguration } from 'chart.js';
import { ApiService, errorMessage } from '../core/api.service';
import { Dashboard, Hospital, Page, STATUS_LABELS, Status } from '../core/models';
import { ChartComponent, PageHeaderComponent } from '../shared/ui';

const COLORS: Record<string, string> = { DRAFT: '#c3cde0', TRANSMITTED: '#4f9bff', IN_COMPLETION: '#8b7cf6', PENDING_VALIDATION: '#e58a0a', TO_CORRECT_COLLECTION: '#ef8b95', TO_CORRECT_SECRETARIAT: '#dc3545', VALIDATED: '#12a36a', REJECTED: '#8d1a26', DELIVERED: '#0b7a4f' };

@Component({
  selector: 'wk-statistics', standalone: true,
  imports: [CommonModule, FormsModule, ChartComponent, PageHeaderComponent],
  template: `
    <div class="page">
      <wk-page-header title="Statistiques et rapports" subtitle="Chiffres calculés à partir des dossiers réellement enregistrés" />
      <section class="card filters">
        <div class="field"><label>Année</label><select class="input" [(ngModel)]="year" (ngModelChange)="load()">@for (y of years; track y) { <option [ngValue]="y">{{ y }}</option> }</select></div>
        <div class="field"><label>Établissement</label><select class="input" [(ngModel)]="hospital" (ngModelChange)="load()"><option value="">Tous</option>@for (h of hospitals(); track h.uuid) { <option [value]="h.uuid">{{ h.name }}</option> }</select></div>
        <div class="field"><label>Statut</label><select class="input" [(ngModel)]="status" (ngModelChange)="load()"><option value="">Tous</option>@for (s of statuses; track s) { <option [value]="s">{{ labels[s] }}</option> }</select></div>
        @if (agents().length) { <div class="field"><label>Responsable</label><select class="input" [(ngModel)]="agent" (ngModelChange)="load()"><option value="">Tous</option>@for (a of agents(); track a.uuid) { <option [value]="a.uuid">{{ a.name }}</option> }</select></div> }
        <div class="field"><label>Du</label><input type="date" class="input" [(ngModel)]="from" (ngModelChange)="load()" /></div>
        <div class="field"><label>Au</label><input type="date" class="input" [(ngModel)]="to" (ngModelChange)="load()" /></div>
      </section>
      @if (error()) { <div class="alert alert-danger" style="margin:16px 0">{{ error() }}</div> }
      @if (data(); as d) {
        <p class="soft period">Période : du {{ d.period.date_from }} au {{ d.period.date_to }}</p>
        <div class="grid grid-4">
          <div class="card k"><strong>{{ d.kpis.births_declared }}</strong><span>Naissances déclarées</span></div>
          <div class="card k"><strong>{{ d.kpis.declarations_received }}</strong><span>Déclarations reçues</span></div>
          <div class="card k"><strong>{{ d.kpis.validated }}</strong><span>Actes validés</span></div>
          <div class="card k"><strong>{{ d.kpis.delivered }}</strong><span>Actes délivrés</span></div>
          <div class="card k"><strong>{{ d.kpis.in_progress }}</strong><span>Dossiers en cours</span></div>
          <div class="card k"><strong>{{ d.kpis.pending_validation }}</strong><span>En attente de validation</span></div>
          <div class="card k"><strong>{{ d.kpis.rejected }}</strong><span>Dossiers rejetés</span></div>
          <div class="card k"><strong>{{ d.delays.avg_days_transmission_to_validation ?? '—' }}</strong><span>Délai moyen (jours) transmission → validation</span></div>
        </div>
        <div class="grid grid-2" style="margin-top:16px">
          <section class="card"><div class="card-title"><h2>Déclarations reçues et actes validés — {{ d.period.year }}</h2></div>@if (bars) { <wk-chart [config]="bars" [height]="300" /> }</section>
          <section class="card"><div class="card-title"><h2>Répartition par statut</h2></div>@if (byStatus) { <wk-chart [config]="byStatus" [height]="300" /> }</section>
          <section class="card"><div class="card-title"><h2>Par hôpital ou maternité</h2></div>
            <table class="table compact"><thead><tr><th>Établissement</th><th style="text-align:right">Dossiers</th></tr></thead>
              <tbody>@for (h of d.by_hospital; track h.name) { <tr><td>{{ h.name }}</td><td class="mono" style="text-align:right">{{ h.count }}</td></tr> } @empty { <tr><td colspan="2" class="empty">Aucune donnée.</td></tr> }</tbody></table></section>
          <section class="card"><div class="card-title"><h2>Répartition par sexe</h2></div>
            @if (d.by_gender) { <table class="table compact"><tbody><tr><td>Masculin</td><td class="mono">{{ d.by_gender.M }}</td></tr><tr><td>Féminin</td><td class="mono">{{ d.by_gender.F }}</td></tr><tr><td>Non renseigné</td><td class="mono">{{ d.by_gender.unknown }}</td></tr></tbody></table> }
            @else { <p class="muted">Cette statistique n'est pas activée (décision métier en attente).</p> }</section>
        </div>
      }
    </div>
  `,
  styles: ['.filters{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}.filters .field{min-width:160px}.period{margin:12px 0}.k{display:flex;flex-direction:column;gap:2px}.k strong{font-size:28px;font-weight:800}.k span{color:var(--wk-text-soft);font-size:13px}'],
})
export class StatisticsComponent implements OnInit {
  private api = inject(ApiService);
  labels = STATUS_LABELS;
  statuses = Object.keys(STATUS_LABELS) as Status[];
  currentYear = new Date().getFullYear();
  years = Array.from({ length: 6 }, (_, i) => this.currentYear - i);
  year = this.currentYear; hospital = ''; status = ''; agent = ''; from = ''; to = '';
  agents = signal<{ uuid: string; name: string }[]>([]);
  data = signal<Dashboard | null>(null); hospitals = signal<Hospital[]>([]); error = signal('');
  bars?: ChartConfiguration<'bar'>; byStatus?: ChartConfiguration<'doughnut'>;

  ngOnInit() {
    this.load();
    this.api.get<Page<Hospital>>('/hospitals/', { page_size: 100 }).subscribe({ next: p => this.hospitals.set(p.results), error: () => undefined });
    this.api.get<{ uuid: string; name: string }[]>('/declarations/agents/').subscribe({ next: a => this.agents.set(a), error: () => undefined });
  }
  load() {
    this.api.get<Dashboard>('/stats/dashboard/', { year: this.year, hospital: this.hospital, status: this.status, agent: this.agent, date_from: this.from, date_to: this.to }).subscribe({
      next: d => {
        this.data.set(d); this.error.set('');
        this.bars = { type: 'bar', data: { labels: d.monthly.map(m => m.month), datasets: [
          { label: 'Reçues', data: d.monthly.map(m => m.received), backgroundColor: '#1f5ed8', borderRadius: 6 },
          { label: 'Validées', data: d.monthly.map(m => m.validated), backgroundColor: '#12a36a', borderRadius: 6 }] },
          options: { scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { position: 'bottom' } } } };
        this.byStatus = { type: 'doughnut', data: { labels: d.by_status.map(s => s.label), datasets: [{ data: d.by_status.map(s => s.count), backgroundColor: d.by_status.map(s => COLORS[s.status]), borderColor: '#fff', borderWidth: 2 }] },
          options: { cutout: '60%', plugins: { legend: { position: 'bottom' } } } };
      },
      error: e => this.error.set(errorMessage(e)),
    });
  }
}
