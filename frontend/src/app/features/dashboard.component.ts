import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ChartConfiguration } from 'chart.js';
import { ApiService, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { Dashboard, DeclarationListItem, Page } from '../core/models';
import { ChartComponent, IconComponent, PageHeaderComponent, StatusBadgeComponent } from '../shared/ui';

const PALETTE = ['#1f5ed8', '#4f9bff', '#12a36a', '#8b7cf6', '#e58a0a', '#c3cde0'];

@Component({
  selector: 'wk-dashboard', standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, DatePipe, ChartComponent, IconComponent, PageHeaderComponent, StatusBadgeComponent],
  template: `
    <div class="page">
      <wk-page-header title="Tableau de bord" subtitle="Vue d'ensemble de l'état civil de la mairie de Ratoma">
        <select class="input period" [(ngModel)]="year" (ngModelChange)="load()" aria-label="Période">
          @for (y of years; track y) { <option [ngValue]="y">{{ y === currentYear ? 'Cette année' : y }}</option> }
        </select>
      </wk-page-header>

      @if (error()) { <div class="alert alert-danger">{{ error() }}</div> }

      <div class="grid grid-4 kpis">
        @for (k of kpiCards(); track k.label) {
          <article class="card kpi" [class.skeleton]="!data()">
            <span class="ico" [ngClass]="k.tone"><wk-icon [name]="k.icon" [size]="22" /></span>
            <div><strong class="mono">{{ k.value }}</strong><span>{{ k.label }}</span></div>
          </article>
        }
      </div>

      <div class="grid charts">
        <section class="card">
          <div class="card-title"><h2>Évolution des déclarations</h2><span class="legend"><i class="b"></i>Déclarations reçues <i class="g"></i>Actes validés</span></div>
          @if (line) { <wk-chart [config]="line" [height]="270" /> }
        </section>
        <section class="card">
          <div class="card-title"><h2>Répartition par hôpital</h2></div>
          @if (data() && !data()!.by_hospital.length) { <p class="empty">Aucune donnée sur la période.</p> }
          @else if (hospitalDonut) {
            <div class="donut">
              <div class="chart"><wk-chart [config]="hospitalDonut" [height]="190" /><div class="center"><strong>{{ data()!.kpis.births_declared }}</strong><span>naissances</span></div></div>
              <ul class="leg">
                @for (h of data()!.by_hospital.slice(0, 6); track h.name; let i = $index) {
                  <li><i [style.background]="color(i)"></i><span>{{ h.name }}</span><b class="mono">{{ h.count }}</b><em>{{ pct(h.count) }}%</em></li>
                }
              </ul>
            </div>
          }
        </section>
      </div>

      <div class="grid bottom">
        <section class="card flush">
          <div class="card-title pad"><h2>Dossiers récents</h2><a routerLink="/declarations">Voir tout</a></div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Référence</th><th>Nom de l'enfant</th><th>Hôpital</th><th>Statut</th><th>Date</th></tr></thead>
              <tbody>
                @for (d of recent(); track d.uuid) {
                  <tr class="clickable" (click)="open(d.uuid)">
                    <td class="mono">{{ d.reference }}</td><td>{{ d.child_name || '—' }}</td><td>{{ d.hospital_name || '—' }}</td>
                    <td><wk-status [status]="d.status" /></td><td class="mono">{{ d.updated_at | date: 'dd/MM/yyyy' }}</td>
                  </tr>
                } @empty { <tr><td colspan="5"><div class="empty"><strong>Aucun dossier</strong>Les dossiers enregistrés apparaîtront ici.</div></td></tr> }
              </tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <div class="card-title"><h2>Répartition par sexe</h2></div>
          @if (!data()?.by_gender) { <p class="empty">Statistique non activée.</p> }
          @else {
            <div class="donut">
              <div class="chart"><wk-chart [config]="genderDonut!" [height]="170" /><div class="center"><strong>{{ data()!.kpis.births_declared }}</strong><span>naissances</span></div></div>
              <ul class="leg">
                <li><i style="background:#1f5ed8"></i><span>Masculin</span><b class="mono">{{ data()!.by_gender!.M }}</b></li>
                <li><i style="background:#ff8fa8"></i><span>Féminin</span><b class="mono">{{ data()!.by_gender!.F }}</b></li>
                @if (data()!.by_gender!.unknown) { <li><i style="background:#c3cde0"></i><span>Non renseigné</span><b class="mono">{{ data()!.by_gender!.unknown }}</b></li> }
              </ul>
            </div>
          }
          <p class="delay soft">
            <wk-icon name="clock" [size]="16" /> Délai moyen de traitement :
            <strong>{{ data()?.delays?.avg_days_transmission_to_validation ?? '—' }}</strong>
            @if (data()?.delays?.avg_days_transmission_to_validation !== null && data()?.delays?.avg_days_transmission_to_validation !== undefined) { jour(s) }
          </p>
        </section>
      </div>
    </div>
  `,
  styles: [`
    .period{width:auto;min-width:150px}
    .kpis{margin-bottom:var(--s4)}
    .kpi{display:flex;gap:16px;align-items:center;min-height:104px}
    .kpi strong{display:block;font-size:30px;line-height:1.1;font-weight:800}
    .kpi span{color:var(--wk-text-soft);font-size:13px}
    .ico{width:50px;height:50px;border-radius:50%;display:grid;place-items:center;flex:none}
    .ico.info{background:var(--wk-info-bg);color:var(--wk-royal)} .ico.success{background:var(--wk-success-bg);color:var(--wk-success)}
    .ico.warning{background:var(--wk-warning-bg);color:var(--wk-warning)} .ico.danger{background:var(--wk-danger-bg);color:var(--wk-danger)}
    .charts{grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);margin-bottom:var(--s4)}
    .bottom{grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)}
    .legend{font-size:12px;color:var(--wk-text-soft);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .legend i{width:9px;height:9px;border-radius:50%;display:inline-block;margin-left:10px}
    .legend .b{background:#1f5ed8;margin-left:0}.legend .g{background:#12a36a}
    .donut{display:grid;grid-template-columns:minmax(150px,.9fr) minmax(0,1.1fr);gap:16px;align-items:center}
    .chart{position:relative}.center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
    .center strong{font-size:22px}.center span{font-size:11px;color:var(--wk-text-mute)}
    .leg{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px;font-size:13px}
    .leg li{display:grid;grid-template-columns:10px minmax(0,1fr) auto auto;gap:8px;align-items:center}
    .leg i{width:9px;height:9px;border-radius:50%}.leg span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .leg em{font-style:normal;color:var(--wk-text-mute);min-width:34px;text-align:right}
    .pad{padding:var(--s5) var(--s5) 0}
    .delay{margin-top:var(--s4);display:flex;gap:6px;align-items:center;flex-wrap:wrap}
    @media (max-width:1100px){.charts,.bottom{grid-template-columns:minmax(0,1fr)}}
    @media (max-width:520px){.donut{grid-template-columns:minmax(0,1fr)}}
  `],
})
export class DashboardComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  auth = inject(AuthService);

  currentYear = new Date().getFullYear();
  years = Array.from({ length: 5 }, (_, i) => this.currentYear - i);
  year = this.currentYear;
  data = signal<Dashboard | null>(null);
  recent = signal<DeclarationListItem[]>([]);
  error = signal('');
  line?: ChartConfiguration<'line'>;
  hospitalDonut?: ChartConfiguration<'doughnut'>;
  genderDonut?: ChartConfiguration<'doughnut'>;

  kpiCards = () => {
    const k = this.data()?.kpis;
    const v = (n?: number) => (k ? n : '—');
    return [
      { label: 'Naissances déclarées', value: v(k?.births_declared), icon: 'baby', tone: 'info' },
      { label: 'Déclarations reçues', value: v(k?.declarations_received), icon: 'file', tone: 'info' },
      { label: 'Actes validés', value: v(k?.validated), icon: 'check', tone: 'success' },
      { label: 'Dossiers rejetés', value: v(k?.rejected), icon: 'x', tone: 'danger' },
      { label: 'Dossiers en cours', value: v(k?.in_progress), icon: 'clock', tone: 'warning' },
      { label: 'En attente de validation', value: v(k?.pending_validation), icon: 'shield', tone: 'warning' },
      { label: 'Actes délivrés', value: v(k?.delivered), icon: 'certificate', tone: 'success' },
    ];
  };

  color(i: number) { return PALETTE[i % PALETTE.length]; }
  pct(n: number) { const t = this.data()?.kpis.births_declared || 0; return t ? Math.round((n / t) * 100) : 0; }
  open(uuid: string) { this.router.navigate(['/declarations', uuid]); }

  ngOnInit() { this.load(); }

  load() {
    this.error.set('');
    this.api.get<Dashboard>('/stats/dashboard/', { year: this.year }).subscribe({
      next: d => { this.data.set(d); this.buildCharts(d); },
      error: e => this.error.set(errorMessage(e)),
    });
    if (this.auth.can('declaration.view')) {
      this.api.get<Page<DeclarationListItem>>('/declarations/', { page_size: 6, ordering: '-updated_at' })
        .subscribe(p => this.recent.set(p.results));
    }
  }

  private buildCharts(d: Dashboard) {
    this.line = {
      type: 'line',
      data: {
        labels: d.monthly.map(m => m.month),
        datasets: [
          { label: 'Déclarations reçues', data: d.monthly.map(m => m.received), borderColor: '#1f5ed8', backgroundColor: 'rgba(31,94,216,.12)', fill: true, tension: .35, pointRadius: 3 },
          { label: 'Actes validés', data: d.monthly.map(m => m.validated), borderColor: '#12a36a', backgroundColor: 'rgba(18,163,106,.12)', fill: true, tension: .35, pointRadius: 3 },
        ],
      },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#eef2fa' } }, x: { grid: { display: false } } } },
    };
    this.hospitalDonut = {
      type: 'doughnut',
      data: { labels: d.by_hospital.map(h => h.name), datasets: [{ data: d.by_hospital.map(h => h.count), backgroundColor: d.by_hospital.map((_, i) => this.color(i)), borderWidth: 2, borderColor: '#fff' }] },
      options: { cutout: '68%', plugins: { legend: { display: false } } },
    };
    if (d.by_gender) {
      this.genderDonut = {
        type: 'doughnut',
        data: { labels: ['Masculin', 'Féminin', 'Non renseigné'], datasets: [{ data: [d.by_gender.M, d.by_gender.F, d.by_gender.unknown], backgroundColor: ['#1f5ed8', '#ff8fa8', '#c3cde0'], borderWidth: 2, borderColor: '#fff' }] },
        options: { cutout: '68%', plugins: { legend: { display: false } } },
      };
    }
  }
}
