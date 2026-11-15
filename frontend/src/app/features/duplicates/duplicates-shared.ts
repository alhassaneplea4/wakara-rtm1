import { CommonModule, DatePipe } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { ApiService, errorMessage } from '../../core/api.service';
import {
  CASE_STATUS_TONE, CaseStatus, CompareDoc, Criterion, DuplicateComparison, RISK_LABELS, RISK_TONE, RiskLevel,
} from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../shared/ui';

/** Risk level as a badge (high / medium / low). */
@Component({
  selector: 'wk-risk', standalone: true, imports: [CommonModule],
  template: `<span class="badge" [ngClass]="'badge-' + tone">{{ label }}</span>`,
})
export class RiskBadgeComponent {
  @Input() level: RiskLevel | string = 'LOW';
  get tone() { return RISK_TONE[this.level as RiskLevel] ?? 'neutral'; }
  get label() { return RISK_LABELS[this.level as RiskLevel] ?? this.level; }
}

@Component({
  selector: 'wk-case-status', standalone: true, imports: [CommonModule],
  template: `<span class="badge" [ngClass]="'badge-' + tone">{{ label }}</span>`,
})
export class CaseStatusBadgeComponent {
  @Input() status: CaseStatus | string = 'OPEN';
  @Input() label = '';
  get tone() { return CASE_STATUS_TONE[this.status as CaseStatus] ?? 'neutral'; }
}

/** Score 0-100 as a small bar + figure (a score is an aid, never a verdict). */
@Component({
  selector: 'wk-score', standalone: true, imports: [CommonModule],
  template: `<span class="sc" [title]="'Score de correspondance : ' + score + ' / 100 (aide à la décision, pas une conclusion)'">
    <b class="mono">{{ score | number: '1.0-0' }}</b>
    <i class="bar"><i [style.width.%]="score" [ngClass]="level"></i></i></span>`,
  styles: [`
    .sc{display:inline-flex;align-items:center;gap:8px;min-width:96px}
    .bar{flex:1;height:6px;border-radius:99px;background:#e6ebf5;overflow:hidden;min-width:44px;display:block}
    .bar i{display:block;height:100%;border-radius:99px}
    .HIGH{background:var(--wk-danger)} .MEDIUM{background:var(--wk-warning)} .LOW{background:#9aa6c0}
  `],
})
export class ScoreComponent {
  @Input() score = 0;
  @Input() risk: RiskLevel | string = '';
  get level() { return this.risk || (this.score >= 85 ? 'HIGH' : this.score >= 60 ? 'MEDIUM' : 'LOW'); }
}

/** Navigation between the screens of the control centre. */
@Component({
  selector: 'wk-dup-tabs', standalone: true, imports: [RouterLink, RouterLinkActive, IconComponent],
  template: `
    <nav class="tabs" aria-label="Centre de contrôle des doublons">
      <a class="tab" routerLink="/duplicates" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Dossiers suspects</a>
      <a class="tab" routerLink="/duplicates/alerts" routerLinkActive="active">Alertes</a>
      <a class="tab" routerLink="/duplicates/sync" routerLinkActive="active">Conflits de synchronisation</a>
      <a class="tab" routerLink="/duplicates/history" routerLinkActive="active">Historique des conflits résolus</a>
      <a class="tab" routerLink="/duplicates/compare" routerLinkActive="active">Comparer deux dossiers</a>
    </nav>`,
  styles: ['.tab{text-decoration:none}'],
})
export class DupTabsComponent {}

const DOC_NOTE = 'Consultation tracée dans le dossier et le journal d\'audit.';

/**
 * Side-by-side comparison of two declarations: scoring detail, then every field with its status
 * (identical / similar / different / missing), then the supporting documents (access is audited).
 */
@Component({
  selector: 'wk-dup-compare', standalone: true, imports: [CommonModule, DatePipe, RouterLink, IconComponent],
  template: `
    @if (data) {
      <div class="heads">
        <article class="side"><span class="tag">Déclaration A</span>
          <a [routerLink]="['/declarations', data.a.uuid]"><strong class="mono">{{ data.a.reference }}</strong></a>
          <span class="uc">{{ data.a.child_name || 'Enfant non nommé' }}</span>
          <small>{{ data.a.status_label }}@if (data.a.official_number) { · acte n° {{ data.a.official_number }} }@if (data.a.is_archived) { · archivée }</small></article>
        <article class="side"><span class="tag">Déclaration B</span>
          <a [routerLink]="['/declarations', data.b.uuid]"><strong class="mono">{{ data.b.reference }}</strong></a>
          <span class="uc">{{ data.b.child_name || 'Enfant non nommé' }}</span>
          <small>{{ data.b.status_label }}@if (data.b.official_number) { · acte n° {{ data.b.official_number }} }@if (data.b.is_archived) { · archivée }</small></article>
      </div>

      <div class="legend" aria-hidden="true">
        <span class="lg same">Identique <b>{{ data.counts['same'] }}</b></span>
        <span class="lg similar">Proche <b>{{ data.counts['similar'] }}</b></span>
        <span class="lg different">Différent <b>{{ data.counts['different'] }}</b></span>
        <span class="lg missing">Non renseigné <b>{{ data.counts['missing'] }}</b></span>
      </div>

      @for (s of data.sections; track s.key) {
        <section class="card flush sec">
          <h3>{{ s.title }}</h3>
          <div class="table-wrap">
            <table class="table cmp">
              <thead><tr><th>Information</th><th>Déclaration A</th><th>Déclaration B</th><th class="st">Constat</th></tr></thead>
              <tbody>
                @for (r of s.rows; track r.label) {
                  <tr [ngClass]="'r-' + r.status">
                    <td class="lab">{{ r.label }}</td>
                    <td class="v" [attr.data-side]="'A'">{{ r.a || '—' }}</td>
                    <td class="v" [attr.data-side]="'B'">{{ r.b || '—' }}</td>
                    <td class="st"><span class="chip" [ngClass]="r.status">{{ label(r.status) }}</span></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      <section class="card flush sec">
        <h3>Justificatifs disponibles</h3>
        @if (!data.documents_visible) {
          <p class="soft pad">Vous n'avez pas l'autorisation de consulter les pièces justificatives.</p>
        } @else {
          <div class="docs">
            @for (side of ['a', 'b']; track side) {
              <div>
                <strong>Déclaration {{ side.toUpperCase() }}</strong>
                <ul>
                  @for (doc of docsOf(side); track doc.uuid) {
                    <li><span>{{ doc.kind_label }} — {{ doc.original_name }}<small class="soft"> · {{ doc.created_at | date: 'dd/MM/yyyy' }}</small></span>
                      <button class="btn btn-sm" (click)="view.emit(doc)" [title]="note"><wk-icon name="eye" [size]="14" /> Consulter</button></li>
                  } @empty { <li class="soft">Aucune pièce.</li> }
                </ul>
              </div>
            }
          </div>
          <p class="soft pad small">{{ note }}</p>
        }
      </section>
    }
  `,
  styles: [`
    :host{display:block}
    .heads{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
    .side{background:#fff;border:1px solid var(--wk-border);border-radius:var(--r-md);padding:12px 14px;display:flex;flex-direction:column;gap:2px;min-width:0}
    .side .tag{font-size:11px;font-weight:700;color:var(--wk-royal);text-transform:uppercase;letter-spacing:.05em}
    .side small{color:var(--wk-text-soft)}
    .legend{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
    .lg{font-size:12px;font-weight:600;padding:3px 10px;border-radius:99px}
    .lg b{margin-left:4px}
    .same{background:var(--wk-success-bg);color:#0b7a4f} .similar{background:var(--wk-warning-bg);color:#a35f00}
    .different{background:var(--wk-danger-bg);color:#b3202e} .missing{background:#eceff6;color:var(--wk-text-soft)}
    .sec{margin-bottom:12px} .sec h3{padding:12px 16px;font-size:14px;border-bottom:1px solid var(--wk-border);background:var(--wk-sky-50)}
    .cmp td.lab{color:var(--wk-text-soft);width:24%} .cmp td.v{font-weight:600;word-break:break-word}
    .cmp .st{width:1%;white-space:nowrap}
    .chip{font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px}
    tr.r-same td.v{background:rgba(18,163,106,.07)} tr.r-similar td.v{background:rgba(229,138,10,.12)}
    tr.r-different td.v{background:rgba(220,53,69,.10)}
    .docs{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:14px 16px}
    .docs ul{list-style:none;padding:0;margin:6px 0 0;display:flex;flex-direction:column;gap:6px}
    .docs li{display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap}
    .pad{padding:12px 16px} .small{font-size:12px;margin:0}
    @media (max-width:760px){
      .heads,.docs{grid-template-columns:1fr}
      .cmp thead{display:none}
      .cmp tr{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--wk-border);padding:6px 0}
      .cmp td{border:0;padding:4px 12px}
      .cmp td.lab{grid-column:1 / -1;width:auto;font-size:12px;padding-bottom:0}
      .cmp td.st{grid-column:1 / -1}
      .cmp td.v::before{content:attr(data-side) ' · ';color:var(--wk-text-mute);font-weight:700}
    }
  `],
})
export class DupCompareComponent {
  @Input() data: DuplicateComparison | null = null;
  @Output() view = new EventEmitter<CompareDoc>();
  note = DOC_NOTE;
  private labels: Record<string, string> = { same: 'Identique', similar: 'Proche', different: 'Différent', missing: 'Non renseigné' };
  label(s: string) { return this.labels[s] ?? s; }
  docsOf(side: string): CompareDoc[] { return (side === 'a' ? this.data?.documents.a : this.data?.documents.b) ?? []; }
}

/** The 6 weighted criteria of a match, with their comparable / missing state. */
@Component({
  selector: 'wk-dup-criteria', standalone: true, imports: [CommonModule],
  template: `
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Critère</th><th>Poids</th><th>Concordance</th><th>Points</th><th>Détail</th></tr></thead>
        <tbody>
          @for (c of rows(); track c.key) {
            <tr [class.dim]="!c.comparable">
              <td><strong>{{ c.label }}</strong></td>
              <td class="mono">{{ c.weight }}</td>
              <td>@if (c.comparable) { <span class="bar"><i [style.width.%]="(c.similarity ?? 0) * 100"></i></span>
                <span class="mono">{{ ((c.similarity ?? 0) * 100) | number: '1.0-0' }} %</span>
                @if (c.exact) { <span class="badge badge-success">Exacte</span> } @else if ((c.similarity ?? 0) >= 0.6) { <span class="badge badge-warning">Approchée</span> }
              } @else { <span class="soft">Non comparable (information manquante) — exclue du calcul</span> }</td>
              <td class="mono">{{ c.comparable ? (c.points | number: '1.0-1') : '—' }}</td>
              <td class="soft small">
                @if (c.detail) { {{ c.detail }} }
                @for (p of c.parts; track p.label) { @if (p.similarity !== null) { <div>{{ p.label }} : {{ (p.similarity * 100) | number: '1.0-0' }} %</div> } }
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>`,
  styles: ['tr.dim td{opacity:.7}.bar{display:inline-block;width:70px;height:6px;border-radius:99px;background:#e6ebf5;overflow:hidden;margin-right:8px;vertical-align:middle}.bar i{display:block;height:100%;background:var(--wk-royal)}.small{font-size:12px}'],
})
export class DupCriteriaComponent {
  @Input() criteria: Record<string, Criterion> | undefined;
  rows(): Criterion[] {
    const order = ['mother', 'birth_date', 'birth_place', 'birth_time', 'father', 'complementary'];
    return order.map(k => this.criteria?.[k]).filter((c): c is Criterion => !!c);
  }
}

/** Opens a supporting document in a new tab (authenticated download, audited server-side). */
export function openDocument(api: ApiService, toast: ToastService, doc: { uuid: string }) {
  api.blob(`/documents/${doc.uuid}/download/`).subscribe({
    next: b => { const url = URL.createObjectURL(b); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60000); },
    error: e => toast.error(errorMessage(e)),
  });
}

export const DUP_SHARED = [RiskBadgeComponent, CaseStatusBadgeComponent, ScoreComponent, DupTabsComponent, DupCompareComponent, DupCriteriaComponent] as const;
