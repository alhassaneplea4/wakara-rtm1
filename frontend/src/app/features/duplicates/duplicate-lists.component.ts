import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService, errorMessage } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { AutoRefreshService } from '../../core/auto-refresh.service';
import { DuplicateCase, DuplicateFilterOptions, DuplicateMatchRow, Page } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { IconComponent, PageHeaderComponent, PaginationComponent } from '../../shared/ui';
import { CaseStatusBadgeComponent, DupTabsComponent, RiskBadgeComponent, ScoreComponent } from './duplicates-shared';

/* ── Alerts: every correspondence found by the engine (with or without a case) ───────────── */
@Component({
  selector: 'wk-duplicate-alerts', standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, DatePipe, IconComponent, PageHeaderComponent, PaginationComponent, RiskBadgeComponent, ScoreComponent, CaseStatusBadgeComponent, DupTabsComponent],
  template: `
    <div class="page">
      <wk-page-header title="Alertes de correspondance" subtitle="Toutes les ressemblances détectées par l'analyse automatique, y compris à risque faible" />
      <wk-dup-tabs />
      <section class="card flush">
        <div class="filters">
          <div class="field grow"><label class="sr-only" for="q">Recherche</label><input id="q" class="input" [(ngModel)]="search" (keyup.enter)="apply()" placeholder="Référence, nom de l'enfant…" /></div>
          <div class="field"><label class="sr-only" for="r">Risque</label>
            <select id="r" class="input" [(ngModel)]="risk" (ngModelChange)="apply()"><option value="">Tous les risques</option>
              <option value="HIGH">Risque élevé</option><option value="MEDIUM">Risque moyen</option><option value="LOW">Risque faible</option></select></div>
          <div class="field"><label class="sr-only" for="c">Dossier</label>
            <select id="c" class="input" [(ngModel)]="hasCase" (ngModelChange)="apply()"><option value="">Avec ou sans dossier</option><option value="true">Dossier ouvert</option><option value="false">Sans dossier</option></select></div>
          <div class="field"><label class="sr-only" for="s">Score minimal</label><input id="s" type="number" min="0" max="100" class="input" [(ngModel)]="minScore" (ngModelChange)="apply()" placeholder="Score min." style="width:110px" /></div>
          <button class="btn" (click)="apply()"><wk-icon name="search" [size]="16" /> Filtrer</button>
        </div>
        @if (error()) { <div class="alert alert-danger m">{{ error() }}</div> }
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Déclaration</th><th>Ressemble à</th><th>Détectée le</th><th>Score</th><th>Qualité des données</th><th>Risque</th><th>Dossier</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              @if (loading()) { @for (i of [1,2,3,4]; track i) { <tr><td colspan="8"><div class="skeleton" style="height:20px"></div></td></tr> } }
              @else {
                @for (m of rows(); track m.uuid) {
                  <tr>
                    <td><span class="mono">{{ m.declaration.reference }}</span><div class="uc soft small">{{ m.declaration.child_name || '—' }} · {{ m.declaration.mother_name || '—' }}</div></td>
                    <td><span class="mono">{{ m.candidate.reference }}</span><div class="uc soft small">{{ m.candidate.child_name || '—' }} · {{ m.candidate.mother_name || '—' }}</div>
                      @if (m.candidate.official_number) { <div class="small"><span class="badge badge-info">Acte n° {{ m.candidate.official_number }}</span></div> }</td>
                    <td class="mono">{{ m.detected_at | date: 'dd/MM/yyyy HH:mm' }}</td>
                    <td><wk-score [score]="m.score" [risk]="m.risk_level" /></td>
                    <td class="mono">{{ m.data_quality }} %</td>
                    <td><wk-risk [level]="m.risk_level" />@if (m.flags.twin_suspected) { <div class="small soft">Naissance multiple possible</div> }</td>
                    <td>@if (m.case) { <a [routerLink]="['/duplicates/cases', m.case.uuid]" class="mono">{{ m.case.reference }}</a> <wk-case-status [status]="m.case.status" [label]="statusLabel(m.case.status)" /> } @else { <span class="soft">—</span> }</td>
                    <td class="act">
                      <a class="btn btn-sm" [routerLink]="['/duplicates/compare']" [queryParams]="{ a: m.declaration.uuid, b: m.candidate.uuid }"><wk-icon name="copy" [size]="14" /> Comparer</a>
                      @if (!m.case && auth.can('duplicate.investigate')) { <button class="btn btn-sm" [disabled]="busy() === m.uuid" (click)="openCase(m)">Ouvrir un dossier</button> }
                    </td>
                  </tr>
                } @empty { <tr><td colspan="8"><div class="empty"><strong>Aucune alerte</strong>Aucune correspondance pour ces filtres.</div></td></tr> }
              }
            </tbody>
          </table>
        </div>
        <wk-pagination [page]="page" [total]="total()" [pageSize]="20" (pageChange)="goto($event)" />
      </section>
    </div>`,
  styles: [LIST_STYLES()],
})
export class DuplicateAlertsComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);
  private autoRefresh = inject(AutoRefreshService);
  auth = inject(AuthService);
  search = ''; risk = ''; hasCase = ''; minScore: number | null = null; page = 1;
  rows = signal<DuplicateMatchRow[]>([]); total = signal(0); loading = signal(true); error = signal(''); busy = signal('');
  private labels: Record<string, string> = { OPEN: 'En attente de décision', IN_REVIEW: "En cours d'investigation", AWAITING_INFO: 'Vérification complémentaire', RESOLVED: 'Résolu' };
  statusLabel(s: string) { return this.labels[s] ?? s; }

  ngOnInit() { this.load(); this.autoRefresh.on(this.destroyRef, () => this.load(true)); }
  apply() { this.page = 1; this.load(); }
  goto(p: number) { this.page = p; this.load(); }
  load(silent = false) {
    if (!silent) this.loading.set(true);
    this.api.get<Page<DuplicateMatchRow>>('/duplicates/matches/', { search: this.search, risk_level: this.risk, has_case: this.hasCase, min_score: this.minScore ?? undefined, page: this.page }).subscribe({
      next: p => { this.rows.set(p.results); this.total.set(p.count); this.loading.set(false); this.error.set(''); },
      error: e => { this.loading.set(false); if (!silent) this.error.set(errorMessage(e)); },
    });
  }
  openCase(m: DuplicateMatchRow) {
    this.busy.set(m.uuid);
    this.api.post<DuplicateCase>(`/duplicates/matches/${m.uuid}/open-case/`).subscribe({
      next: c => { this.busy.set(''); this.toast.success('Dossier d\'investigation ouvert.'); this.router.navigate(['/duplicates/cases', c.uuid]); },
      error: e => { this.busy.set(''); this.toast.error(errorMessage(e)); },
    });
  }
}

/* ── History of the cases that were resolved ───────────────────────────────────────────── */
@Component({
  selector: 'wk-duplicate-history', standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, DatePipe, IconComponent, PageHeaderComponent, PaginationComponent, RiskBadgeComponent, DupTabsComponent],
  template: `
    <div class="page">
      <wk-page-header title="Historique des conflits résolus" subtitle="Décisions rendues, avec leur motif — consultables mais jamais modifiables" />
      <wk-dup-tabs />
      <section class="card flush">
        <div class="filters">
          <div class="field grow"><label class="sr-only" for="q">Recherche</label><input id="q" class="input" [(ngModel)]="search" (keyup.enter)="apply()" placeholder="Référence, nom de l'enfant…" /></div>
          <div class="field"><label class="sr-only" for="d">Décision</label>
            <select id="d" class="input" [(ngModel)]="decision" (ngModelChange)="apply()"><option value="">Toutes les décisions</option>
              @for (o of options()?.decisions ?? []; track o.value) { @if (o.final) { <option [value]="o.value">{{ o.label }}</option> } }</select></div>
          <button class="btn" (click)="apply()"><wk-icon name="search" [size]="16" /> Filtrer</button>
        </div>
        @if (error()) { <div class="alert alert-danger m">{{ error() }}</div> }
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Dossier</th><th>Déclarations</th><th>Enfant</th><th>Résolu le</th><th>Décision</th><th>Risque initial</th></tr></thead>
            <tbody>
              @if (loading()) { @for (i of [1,2,3,4]; track i) { <tr><td colspan="6"><div class="skeleton" style="height:20px"></div></td></tr> } }
              @else {
                @for (c of rows(); track c.uuid) {
                  <tr class="clickable" (click)="open(c.uuid)" tabindex="0" (keyup.enter)="open(c.uuid)">
                    <td class="mono"><a [routerLink]="['/duplicates/cases', c.uuid]" (click)="$event.stopPropagation()">{{ c.reference }}</a></td>
                    <td class="mono">{{ c.declaration.reference }} ≈ {{ c.other_declaration.reference }}</td>
                    <td class="uc">{{ c.declaration.child_name || '—' }}</td>
                    <td class="mono">{{ c.resolved_at | date: 'dd/MM/yyyy HH:mm' }}</td>
                    <td><span class="badge" [ngClass]="c.final_decision === 'CONFIRMED_DUPLICATE' ? 'badge-danger' : 'badge-success'">{{ c.decision_label }}</span></td>
                    <td><wk-risk [level]="c.risk_level" /></td>
                  </tr>
                } @empty { <tr><td colspan="6"><div class="empty"><strong>Aucun conflit résolu</strong>Les dossiers traités apparaîtront ici.</div></td></tr> }
              }
            </tbody>
          </table>
        </div>
        <wk-pagination [page]="page" [total]="total()" [pageSize]="20" (pageChange)="goto($event)" />
      </section>
    </div>`,
  styles: [LIST_STYLES()],
})
export class DuplicateHistoryComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  search = ''; decision = ''; page = 1;
  rows = signal<DuplicateCase[]>([]); total = signal(0); loading = signal(true); error = signal('');
  options = signal<DuplicateFilterOptions | null>(null);
  ngOnInit() { this.api.get<DuplicateFilterOptions>('/duplicates/cases/filter-options/').subscribe(o => this.options.set(o)); this.load(); }
  apply() { this.page = 1; this.load(); }
  goto(p: number) { this.page = p; this.load(); }
  open(uuid: string) { this.router.navigate(['/duplicates/cases', uuid]); }
  load() {
    this.loading.set(true);
    this.api.get<Page<DuplicateCase>>('/duplicates/cases/', { state: 'resolved', search: this.search, decision: this.decision, ordering: '-resolved_at', page: this.page }).subscribe({
      next: p => { this.rows.set(p.results); this.total.set(p.count); this.loading.set(false); this.error.set(''); },
      error: e => { this.loading.set(false); this.error.set(errorMessage(e)); },
    });
  }
}

/* ── Synchronisation conflicts + device log ────────────────────────────────────────────── */
@Component({
  selector: 'wk-duplicate-sync', standalone: true,
  imports: [CommonModule, RouterLink, DatePipe, PageHeaderComponent, RiskBadgeComponent, ScoreComponent, CaseStatusBadgeComponent, DupTabsComponent],
  template: `
    <div class="page">
      <wk-page-header title="Conflits de synchronisation" subtitle="Naissances saisies hors connexion, sur plusieurs appareils, puis rapprochées par le serveur" />
      <wk-dup-tabs />
      <div class="alert alert-info note">La détection <strong>définitive</strong> est faite par le serveur sur toute la base de Ratoma, après synchronisation. Une vérification locale sur un appareil n'est jamais exhaustive. Les deux déclarations sont conservées ; aucune ne peut recevoir de numéro officiel avant la décision d'un responsable.</div>

      <section class="card flush sec">
        <h2 class="h">Conflits à examiner</h2>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Dossier</th><th>Déclarations</th><th>Détecté le</th><th>Score</th><th>Risque</th><th>Statut</th></tr></thead>
          <tbody>
            @for (c of conflicts(); track c.uuid) {
              <tr class="clickable" (click)="open(c.uuid)" tabindex="0" (keyup.enter)="open(c.uuid)">
                <td class="mono"><a [routerLink]="['/duplicates/cases', c.uuid]" (click)="$event.stopPropagation()">{{ c.reference }}</a></td>
                <td class="mono">{{ c.declaration.reference }} ≈ {{ c.other_declaration.reference }}<div class="soft small">{{ c.declaration.agent_name }} / {{ c.other_declaration.agent_name }}</div></td>
                <td class="mono">{{ c.detected_at | date: 'dd/MM/yyyy HH:mm' }}</td>
                <td><wk-score [score]="c.score" [risk]="c.risk_level" /></td><td><wk-risk [level]="c.risk_level" /></td>
                <td><wk-case-status [status]="c.status" [label]="c.status_label" /></td>
              </tr>
            } @empty { <tr><td colspan="6"><div class="empty"><strong>Aucun conflit de synchronisation</strong></div></td></tr> }
          </tbody></table></div>
      </section>

      <p class="soft">Le détail des appareils et des opérations reçues est dans <a routerLink="/appareils">Appareils hors connexion</a>.</p>
    </div>`,
  styles: [LIST_STYLES(), '.sec{margin-bottom:16px}.h{padding:14px 16px;font-size:15px;border-bottom:1px solid var(--wk-border)}.note{margin-bottom:16px}'],
})
export class DuplicateSyncComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  conflicts = signal<DuplicateCase[]>([]);
  ngOnInit() {
    this.api.get<Page<DuplicateCase>>('/duplicates/cases/', { anomaly_type: 'SYNC_CONFLICT', state: 'unresolved', page_size: 50 }).subscribe(p => this.conflicts.set(p.results));
  }
  open(uuid: string) { this.router.navigate(['/duplicates/cases', uuid]); }
}

function LIST_STYLES() {
  return `
    .filters{display:flex;gap:10px;flex-wrap:wrap;padding:16px;border-bottom:1px solid var(--wk-border);align-items:center}
    .filters .input{min-height:40px} .grow{flex:1;min-width:200px} .m{margin:16px} .small{font-size:12px}
    .act{text-align:right;white-space:nowrap}.act .btn{margin-left:6px}
    .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}`;
}
