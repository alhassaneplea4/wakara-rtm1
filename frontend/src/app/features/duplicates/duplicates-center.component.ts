import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService, Query, errorMessage } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { AutoRefreshService } from '../../core/auto-refresh.service';
import { DuplicateCase, DuplicateConfig, DuplicateFilterOptions, DuplicateSummary, Hospital, Page } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { IconComponent, PageHeaderComponent, PaginationComponent } from '../../shared/ui';
import { CaseStatusBadgeComponent, DupTabsComponent, RiskBadgeComponent, ScoreComponent } from './duplicates-shared';

const WEIGHT_LABELS: Record<string, string> = {
  mother: 'Identité de la mère', birth_date: 'Date de naissance', birth_place: 'Lieu de naissance',
  birth_time: 'Heure de naissance', father: 'Identité du père', complementary: 'Informations complémentaires',
};

@Component({
    selector: 'wk-duplicates-center',
    imports: [CommonModule, FormsModule, RouterLink, DatePipe, IconComponent, PageHeaderComponent, PaginationComponent, RiskBadgeComponent, CaseStatusBadgeComponent, ScoreComponent, DupTabsComponent],
    template: `
    <div class="page">
      <wk-page-header title="Centre de contrôle des doublons" subtitle="Prévention des enregistrements multiples d'une même naissance — Mairie de Ratoma">
        @if (auth.can('duplicate.view')) { <button class="btn" (click)="toggleConfig()"><wk-icon name="settings" [size]="16" /> Règles de détection</button> }
      </wk-page-header>
      <wk-dup-tabs />

      <div class="alert alert-info note">Un score est une <strong>aide à la décision</strong>, jamais une conclusion juridique : seul un responsable habilité qualifie un dossier suspect. Aucune déclaration n'est supprimée ni fusionnée automatiquement.</div>

      @if (showConfig() && config(); as c) {
        <section class="card cfg">
          <div class="card-title"><h2>Règles de détection</h2><button class="btn btn-ghost btn-sm" (click)="showConfig.set(false)">Fermer</button></div>
          <div class="cfg-grid">
            @for (k of weightKeys; track k) {
              <div class="field"><label [for]="'w-' + k">{{ weightLabels[k] }} (points)</label>
                <input [id]="'w-' + k" type="number" min="0" max="100" class="input" [(ngModel)]="c.weights[k]" [disabled]="!auth.can('duplicate.configure')" /></div>
            }
            <div class="field"><label for="th-h">Seuil « risque élevé »</label><input id="th-h" type="number" class="input" [(ngModel)]="c.thresholds.high" [disabled]="!auth.can('duplicate.configure')" /></div>
            <div class="field"><label for="th-m">Seuil « risque moyen »</label><input id="th-m" type="number" class="input" [(ngModel)]="c.thresholds.medium" [disabled]="!auth.can('duplicate.configure')" /></div>
            <div class="field"><label for="th-q">Qualité minimale pour un risque élevé (%)</label><input id="th-q" type="number" class="input" [(ngModel)]="c.min_quality_for_high" [disabled]="!auth.can('duplicate.configure')" /></div>
          </div>
          <p class="soft small">Somme des pondérations : <strong [class.bad]="weightSum() !== 100">{{ weightSum() }}</strong> / 100. Un critère non renseigné est exclu du calcul : le score est normalisé sur les critères réellement comparables. À calibrer sur des cas réels avant tout usage définitif.</p>
          @if (meta()?.customized) {
            <p class="alert alert-info small">Règles personnalisées le {{ meta()!.updated_at | date: 'dd/MM/yyyy HH:mm' }} par <strong>{{ meta()!.updated_by }}</strong> — {{ meta()!.reason }}</p>
          }
          <p class="soft small">Limites fixées par le système : seuil « élevé » entre 70 et 95, seuil « moyen » entre 40 et 80, mère ≥ 20 points, date de naissance ≥ 15 points. Le risque élevé bloque toujours la validation officielle.</p>
          @if (auth.can('duplicate.configure')) {
            <div class="field"><label for="cfg-reason">Motif de la modification (obligatoire, conservé dans le journal)</label>
              <textarea id="cfg-reason" class="input" rows="2" [(ngModel)]="reason" placeholder="Ex. : calibrage décidé en comité du … avec la mairie"></textarea></div>
            <div class="row"><button class="btn btn-primary" [disabled]="weightSum() !== 100 || saving() || reason.trim().length < 10" (click)="saveConfig()">Enregistrer</button></div>
          } @else { <p class="soft small">Modification réservée aux administrateurs (permission « régler la détection des doublons »).</p> }
        </section>
      }

      <div class="grid kpis">
        @for (k of kpis(); track k.label) {
          <button type="button" class="card kpi" [ngClass]="k.tone" (click)="k.apply()" [attr.aria-label]="k.label + ' : ' + k.value">
            <strong class="mono">{{ k.value }}</strong><span>{{ k.label }}</span>
          </button>
        }
      </div>

      <section class="card flush">
        <div class="filters">
          <div class="field grow"><label class="sr-only" for="q">Recherche</label>
            <input id="q" class="input" [(ngModel)]="search" (keyup.enter)="apply()" placeholder="Référence, enfant, mère…" /></div>
          <div class="field"><label class="sr-only" for="state">État</label>
            <select id="state" class="input" [(ngModel)]="state" (ngModelChange)="apply()">
              <option value="unresolved">Dossiers non résolus</option><option value="resolved">Dossiers résolus</option><option value="all">Tous les dossiers</option></select></div>
          <div class="field"><label class="sr-only" for="risk">Niveau de risque</label>
            <select id="risk" class="input" [(ngModel)]="risk" (ngModelChange)="apply()"><option value="">Tous les risques</option>
              @for (o of options()?.risk_levels ?? []; track o.value) { <option [value]="o.value">{{ o.label }}</option> }</select></div>
          <div class="field"><label class="sr-only" for="stat">Statut</label>
            <select id="stat" class="input" [(ngModel)]="status" (ngModelChange)="apply()"><option value="">Tous les statuts</option>
              @for (o of options()?.statuses ?? []; track o.value) { <option [value]="o.value">{{ o.label }}</option> }</select></div>
          <div class="field"><label class="sr-only" for="an">Type d'anomalie</label>
            <select id="an" class="input" [(ngModel)]="anomaly" (ngModelChange)="apply()"><option value="">Toutes les anomalies</option>
              @for (o of options()?.anomaly_types ?? []; track o.value) { <option [value]="o.value">{{ o.label }}</option> }</select></div>
          <div class="field"><label class="sr-only" for="ag">Agent collecteur</label>
            <select id="ag" class="input" [(ngModel)]="agent" (ngModelChange)="apply()"><option value="">Tous les agents</option>
              @for (o of options()?.agents ?? []; track o.uuid) { <option [value]="o.uuid">{{ o.name }}</option> }</select></div>
          <div class="field"><label class="sr-only" for="hp">Établissement</label>
            <select id="hp" class="input" [(ngModel)]="hospital" (ngModelChange)="apply()"><option value="">Tous les établissements</option>
              @for (h of hospitals(); track h.uuid) { <option [value]="h.uuid">{{ h.name }}</option> }</select></div>
          <div class="field"><label class="sr-only" for="df">Détectés depuis</label><input id="df" type="date" class="input" [(ngModel)]="from" (ngModelChange)="apply()" title="Détectés à partir du" /></div>
          <div class="field"><label class="sr-only" for="dt">Détectés jusqu'au</label><input id="dt" type="date" class="input" [(ngModel)]="to" (ngModelChange)="apply()" title="Détectés jusqu'au" /></div>
          <button class="btn" (click)="apply()"><wk-icon name="search" [size]="16" /> Filtrer</button>
          @if (hasFilters()) { <button class="btn btn-ghost" (click)="reset()">Réinitialiser</button> }
        </div>

        @if (error()) { <div class="alert alert-danger m">{{ error() }}</div> }

        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th>Dossier</th><th>Déclaration</th><th>Enfant</th>
              <th class="sortable" (click)="sort('detected_at')">Détecté le {{ arrow('detected_at') }}</th>
              <th>Mère</th><th>Agent collecteur</th>
              <th class="sortable" (click)="sort('score')">Score {{ arrow('score') }}</th><th>Risque</th><th>Statut</th>
            </tr></thead>
            <tbody>
              @if (loading()) { @for (i of [1,2,3,4,5]; track i) { <tr><td colspan="9"><div class="skeleton" style="height:20px"></div></td></tr> } }
              @else {
                @for (c of rows(); track c.uuid) {
                  <tr class="clickable" (click)="open(c.uuid)" tabindex="0" (keyup.enter)="open(c.uuid)">
                    <td class="mono"><a [routerLink]="['/duplicates/cases', c.uuid]" (click)="$event.stopPropagation()">{{ c.reference }}</a>
                      <div class="soft small">{{ c.anomaly_label }}@if (c.twin_suspected) { · jumeaux ? }</div></td>
                    <td class="mono">{{ c.declaration.reference }}<div class="soft small">≈ {{ c.other_declaration.reference }}</div></td>
                    <td class="uc">{{ c.declaration.child_name || '—' }}<div class="soft small">{{ c.declaration.birth_date | date: 'dd/MM/yyyy' }}</div></td>
                    <td class="mono">{{ c.detected_at | date: 'dd/MM/yyyy HH:mm' }}</td>
                    <td class="uc">{{ c.declaration.mother_name || '—' }}</td>
                    <td>{{ c.declaration.agent_name || '—' }}</td>
                    <td><wk-score [score]="c.score" [risk]="c.risk_level" /></td>
                    <td><wk-risk [level]="c.risk_level" /></td>
                    <td><wk-case-status [status]="c.status" [label]="c.status_label" />@if (c.assigned_to_name) { <div class="soft small">{{ c.assigned_to_name }}</div> }</td>
                  </tr>
                } @empty {
                  <tr><td colspan="9"><div class="empty"><strong>Aucun dossier suspect</strong>{{ hasFilters() ? 'Aucun résultat pour ces filtres.' : 'Aucune anomalie à traiter pour le moment.' }}</div></td></tr>
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
    .note{margin-bottom:16px}
    .kpis{grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:16px}
    .kpi{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;cursor:pointer;font:inherit;border-left:4px solid var(--wk-border)}
    .kpi strong{font-size:28px;color:var(--wk-navy-800)} .kpi span{font-size:13px;color:var(--wk-text-soft)}
    .kpi.danger{border-left-color:var(--wk-danger)} .kpi.warning{border-left-color:var(--wk-warning)}
    .kpi.info{border-left-color:var(--wk-royal)} .kpi.success{border-left-color:var(--wk-success)}
    .kpi:hover{background:var(--wk-sky-50)}
    .filters{display:flex;gap:10px;flex-wrap:wrap;padding:16px;border-bottom:1px solid var(--wk-border);align-items:center}
    .filters .input{min-height:40px} .grow{flex:1;min-width:200px}
    .m{margin:16px} .small{font-size:12px}
    .cfg{margin-bottom:16px} .cfg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:10px}
    .bad{color:var(--wk-danger)}
    .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
    @media (max-width:960px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media (max-width:420px){.kpi strong{font-size:22px}}
  `]
})
export class DuplicatesCenterComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);
  private autoRefresh = inject(AutoRefreshService);
  auth = inject(AuthService);

  search = ''; state = 'unresolved'; risk = ''; status = ''; anomaly = ''; agent = ''; hospital = ''; from = ''; to = '';
  ordering = '-detected_at'; page = 1;
  rows = signal<DuplicateCase[]>([]);
  total = signal(0);
  loading = signal(true);
  error = signal('');
  summary = signal<DuplicateSummary | null>(null);
  options = signal<DuplicateFilterOptions | null>(null);
  hospitals = signal<Hospital[]>([]);
  showConfig = signal(false);
  config = signal<DuplicateConfig | null>(null);
  meta = signal<{ customized: boolean; updated_at?: string; updated_by?: string; reason?: string } | null>(null);
  reason = '';
  saving = signal(false);
  weightKeys = Object.keys(WEIGHT_LABELS);
  weightLabels = WEIGHT_LABELS;

  kpis = () => {
    const s = this.summary();
    const v = (n?: number) => (s ? n ?? 0 : '…');
    return [
      { label: 'Dossiers suspects', value: v(s?.total), tone: 'info', apply: () => { this.state = 'all'; this.risk = ''; this.status = ''; this.apply(); } },
      { label: 'Correspondances à risque élevé', value: v(s?.high), tone: 'danger', apply: () => { this.state = 'all'; this.risk = 'HIGH'; this.status = ''; this.apply(); } },
      { label: 'Correspondances à risque moyen', value: v(s?.medium), tone: 'warning', apply: () => { this.state = 'all'; this.risk = 'MEDIUM'; this.status = ''; this.apply(); } },
      { label: "En cours d'investigation", value: v(s?.in_review), tone: 'info', apply: () => { this.state = 'all'; this.risk = ''; this.status = 'IN_REVIEW'; this.apply(); } },
      { label: 'Confirmés comme doublons', value: v(s?.confirmed_duplicates), tone: 'danger', apply: () => { this.state = 'resolved'; this.risk = ''; this.status = ''; this.apply(); } },
      { label: 'Déclarés distincts', value: v((s?.distinct ?? 0) + (s?.multiple_birth ?? 0)), tone: 'success', apply: () => { this.state = 'resolved'; this.risk = ''; this.status = ''; this.apply(); } },
      { label: 'En attente de décision', value: v(s?.awaiting_decision), tone: 'warning', apply: () => { this.state = 'unresolved'; this.risk = ''; this.status = ''; this.apply(); } },
      { label: 'Dossiers résolus', value: v(s?.resolved), tone: 'success', apply: () => { this.state = 'resolved'; this.risk = ''; this.status = ''; this.apply(); } },
    ];
  };

  ngOnInit() {
    this.api.get<DuplicateFilterOptions>('/duplicates/cases/filter-options/').subscribe(o => this.options.set(o));
    if (this.auth.can('hospital.view')) this.api.get<Page<Hospital>>('/hospitals/', { page_size: 100 }).subscribe(p => this.hospitals.set(p.results));
    this.load();
    this.autoRefresh.on(this.destroyRef, () => this.load(true));
  }

  hasFilters = () => !!(this.search || this.risk || this.status || this.anomaly || this.agent || this.hospital || this.from || this.to || this.state !== 'unresolved');
  arrow(f: string) { return this.ordering === f ? '↑' : this.ordering === '-' + f ? '↓' : ''; }
  sort(f: string) { this.ordering = this.ordering === f ? '-' + f : f; this.load(); }
  open(uuid: string) { this.router.navigate(['/duplicates/cases', uuid]); }
  goto(p: number) { this.page = p; this.load(); }
  apply() { this.page = 1; this.load(); }
  reset() { this.search = this.risk = this.status = this.anomaly = this.agent = this.hospital = this.from = this.to = ''; this.state = 'unresolved'; this.apply(); }

  private common(): Query {
    return { search: this.search, risk_level: this.risk, anomaly_type: this.anomaly, agent: this.agent, hospital: this.hospital, detected_from: this.from, detected_to: this.to };
  }

  load(silent = false) {
    if (!silent) this.loading.set(true);
    this.api.get<Page<DuplicateCase>>('/duplicates/cases/', { ...this.common(), state: this.state, status: this.status, ordering: this.ordering, page: this.page }).subscribe({
      next: p => { this.rows.set(p.results); this.total.set(p.count); this.loading.set(false); this.error.set(''); },
      error: e => { this.loading.set(false); if (!silent) this.error.set(errorMessage(e)); },
    });
    // the indicators ignore the state/status filters: they describe the whole picture for the chosen period
    this.api.get<DuplicateSummary>('/duplicates/cases/summary/', { ...this.common(), risk_level: '' }).subscribe({ next: s => this.summary.set(s), error: () => undefined });
  }

  toggleConfig() {
    if (this.showConfig()) { this.showConfig.set(false); return; }
    this.api.get<{ config: DuplicateConfig; meta: { customized: boolean; updated_at?: string; updated_by?: string; reason?: string } }>('/duplicates/config/').subscribe({
      next: r => { this.config.set(r.config); this.meta.set(r.meta); this.showConfig.set(true); }, error: e => this.toast.error(errorMessage(e)),
    });
  }
  weightSum() { const w = this.config()?.weights ?? {}; return Object.values(w).reduce((a, b) => a + (Number(b) || 0), 0); }
  saveConfig() {
    this.saving.set(true);
    this.api.patch<{ config: DuplicateConfig; meta: any }>('/duplicates/config/', { ...this.config(), reason: this.reason.trim() }).subscribe({
      next: r => { this.config.set(r.config); this.meta.set(r.meta); this.reason = ''; this.saving.set(false); this.toast.success('Règles de détection enregistrées (action tracée).'); },
      error: e => { this.saving.set(false); this.toast.error(errorMessage(e)); },
    });
  }
}
