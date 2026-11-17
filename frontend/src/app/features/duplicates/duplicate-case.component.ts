import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService, errorMessage } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { AutoRefreshService } from '../../core/auto-refresh.service';
import { CompareDoc, DecisionCode, DeclarationBrief, DuplicateCaseDetail, DuplicateComparison, DuplicateFilterOptions } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { ConfirmComponent, IconComponent, PageHeaderComponent } from '../../shared/ui';
import {
  CaseStatusBadgeComponent, DupCompareComponent, DupCriteriaComponent, DupTabsComponent, RiskBadgeComponent, ScoreComponent, openDocument,
} from './duplicates-shared';

type Tab = 'analysis' | 'compare' | 'evidence' | 'decisions' | 'history';
type Dialog = '' | 'note' | 'verify' | 'decide' | 'reopen' | 'assign';

const DECISION_HELP: Record<DecisionCode, string> = {
  CONFIRMED_DUPLICATE: "Les deux déclarations concernent la même naissance. L'une est désignée comme saisie redondante : elle est rejetée, retirée de la liste des déclarations et liée au dossier principal, qui reste valide. Rien n'est supprimé.",
  DISTINCT_CHILDREN: 'Ce sont deux enfants distincts : les deux dossiers peuvent poursuivre leur circuit.',
  MULTIPLE_BIRTH: 'Naissance multiple (jumeaux…) : deux enfants distincts de la même mère.',
  DATA_ENTRY_ERROR: "Erreur de saisie : l'une des déclarations a été saisie à tort (double saisie). Elle est rejetée, retirée de la liste des déclarations et liée à l'autre, qui reste valide.",
  INSUFFICIENT_INFO: 'Les informations ne permettent pas de conclure : le dossier reste ouvert et la validation reste bloquée.',
  FURTHER_VERIFICATION: 'Une vérification complémentaire est nécessaire : le dossier reste ouvert et la validation reste bloquée.',
};

@Component({
    selector: 'wk-duplicate-case',
    imports: [CommonModule, FormsModule, RouterLink, DatePipe, IconComponent, PageHeaderComponent, ConfirmComponent, RiskBadgeComponent, CaseStatusBadgeComponent, ScoreComponent, DupCompareComponent, DupCriteriaComponent, DupTabsComponent],
    template: `
    @if (c(); as c) {
      <div class="page">
        <wk-page-header [title]="c.reference" [subtitle]="c.anomaly_label + ' · détecté le ' + (c.detected_at | date: 'dd/MM/yyyy HH:mm')" [back]="['/duplicates']" backLabel="Centre de contrôle des doublons">
          <wk-risk [level]="c.risk_level" /> <wk-case-status [status]="c.status" [label]="c.status_label" />
        </wk-page-header>

        @if (error()) { <div class="alert alert-danger" role="alert" style="margin-bottom:16px">{{ error() }}</div> }
        @if (c.status !== 'RESOLVED') {
          <div class="alert alert-warning" style="margin-bottom:16px"><strong>Dossier non résolu.</strong> Tant qu'une décision n'est pas rendue, l'attribution d'un numéro officiel est bloquée pour les déclarations concernées. Le score est une aide : il ne vaut pas conclusion juridique.</div>
        } @else {
          <div class="alert alert-info" style="margin-bottom:16px"><strong>{{ c.decision_label }}</strong>@if (c.duplicate) { — saisie redondante : <span class="mono">{{ c.duplicate }}</span> (dossier principal : <span class="mono">{{ c.principal }}</span>)@if (redundantRejected(c)) { — rejetée, retirée de la liste des déclarations } } · le {{ c.resolved_at | date: 'dd/MM/yyyy HH:mm' }}</div>
        }
        @for (w of warnings(); track w) { <div class="alert alert-warning" style="margin-bottom:16px">{{ w }}</div> }

        <section class="card pair">
          @for (side of [c.declaration, c.other_declaration]; track side.uuid; let i = $index) {
            <article>
              <span class="tag">Déclaration {{ i === 0 ? 'A' : 'B' }}@if (side.is_synced) { · synchronisée }@if (side.is_archived) { · archivée }</span>
              <a [routerLink]="['/declarations', side.uuid]"><strong class="mono">{{ side.reference }}</strong></a>
              <span class="uc">{{ side.child_name || 'Enfant non nommé' }}</span>
              <small>Né(e) le {{ side.birth_date | date: 'dd/MM/yyyy' }} · mère : {{ side.mother_name || '—' }}</small>
              <small>{{ side.status_label }}@if (side.official_number) { · acte n° {{ side.official_number }} } · saisi par {{ side.agent_name || '—' }}</small>
            </article>
          }
          <article class="score">
            <wk-score [score]="c.score" [risk]="c.risk_level" />
            <small>Qualité des données comparées : <strong>{{ c.data_quality }} %</strong></small>
            <small>{{ c.assigned_to_name ? 'Pris en charge par ' + c.assigned_to_name : 'Non attribué' }}</small>
          </article>
        </section>

        <section class="card actions">
          <div class="row wrap">
            @if (c.permissions.investigate) {
              <button class="btn" (click)="take()" [disabled]="busy()"><wk-icon name="user" [size]="16" /> Prendre en charge</button>
              <button class="btn" (click)="dialog.set('note')"><wk-icon name="edit" [size]="16" /> Ajouter une observation</button>
              <button class="btn" (click)="dialog.set('verify')"><wk-icon name="search" [size]="16" /> Demander une vérification</button>
            }
            @if (c.permissions.decide) {
              @if (c.status !== 'RESOLVED') {
                <button class="btn" (click)="dialog.set('assign')"><wk-icon name="users" [size]="16" /> Attribuer</button>
                <button class="btn btn-primary" (click)="openDecision()"><wk-icon name="shield" [size]="16" /> Rendre une décision</button>
              } @else { <button class="btn" (click)="dialog.set('reopen')"><wk-icon name="history" [size]="16" /> Rouvrir le dossier</button> }
            }
            @if (!c.permissions.investigate && !c.permissions.decide) { <span class="soft">Consultation seule : vous n'avez pas le droit d'investiguer ni de décider.</span> }
          </div>
        </section>

        <div class="tabs" role="tablist">
          @for (t of tabs; track t.id) { <button class="tab" role="tab" [class.active]="tab() === t.id" (click)="select(t.id)">{{ t.label }}</button> }
        </div>

        @switch (tab()) {
          @case ('analysis') {
            <div class="grid grid-2">
              <section class="card"><div class="card-title"><h2>Résultat de l'analyse automatique</h2></div>
                <dl class="kv">
                  <dt>Score normalisé</dt><dd><wk-score [score]="c.score" [risk]="c.risk_level" /></dd>
                  <dt>Points obtenus</dt><dd class="mono">{{ c.flags.raw_points }} / {{ c.flags.comparable_points }} points comparables</dd>
                  <dt>Qualité des données</dt><dd>{{ c.data_quality }} % des 100 points étaient comparables</dd>
                  <dt>Niveau retenu</dt><dd><wk-risk [level]="c.risk_level" />@if (c.flags.raw_risk && c.flags.raw_risk !== c.risk_level) { <span class="soft small"> (le score seul donnerait : {{ riskText(c.flags.raw_risk) }})</span> }</dd>
                </dl>
                @if (c.flags.risk_caps?.length) { <div class="alert alert-info" style="margin-top:12px"><strong>Prudence appliquée :</strong> {{ c.flags.risk_caps!.join(' · ') }}</div> }
                @if (c.flags.twin_suspected) { <div class="alert alert-warning" style="margin-top:12px"><strong>Naissance multiple possible.</strong> Éléments distinctifs : {{ c.flags.distinguishing!.join(', ') }}.</div> }
                @if (c.flags.corroboration?.length) { <p class="soft" style="margin-top:12px">Concordances propres à l'enfant : {{ c.flags.corroboration!.join(', ') }}.</p> }
              </section>
              <section class="card"><div class="card-title"><h2>Critères du rapprochement</h2></div><wk-dup-criteria [criteria]="c.criteria" /></section>
            </div>
          }
          @case ('compare') {
            @if (compareLoading()) { <div class="skeleton" style="height:240px"></div> }
            @else { <wk-dup-compare [data]="comparison()" (view)="viewDoc($event)" /> }
          }
          @case ('evidence') {
            <section class="card"><div class="card-title"><h2>Documents consultés et observations</h2></div>
              <ul class="timeline">
                @for (e of c.evidence; track e.uuid) {
                  <li><span class="dot"></span><div>
                    <strong>{{ e.kind_label }}</strong>@if (e.title) { — {{ e.title }} }<small class="soft"> · {{ e.added_by_name }} · {{ e.added_at | date: 'dd/MM/yyyy HH:mm' }}@if (e.declaration) { · {{ e.declaration }} }</small>
                    @if (e.content) { <p>{{ e.content }}</p> }
                  </div></li>
                } @empty { <li class="soft">Aucune observation ni pièce consultée pour l'instant.</li> }
              </ul></section>
          }
          @case ('decisions') {
            <section class="card flush"><div class="table-wrap"><table class="table">
              <thead><tr><th>Date</th><th>Décision</th><th>Par</th><th>Motif</th><th>Désignation</th></tr></thead>
              <tbody>
                @for (d of c.decisions; track d.uuid) {
                  <tr><td class="mono">{{ d.decided_at | date: 'dd/MM/yyyy HH:mm' }}</td><td><strong>{{ d.decision_label }}</strong></td><td>{{ d.decided_by_name }}</td><td class="reason">{{ d.reason }}</td>
                    <td class="mono">@if (d.duplicate) { redondante : {{ d.duplicate }}<br>principale : {{ d.principal }} } @else { — }</td></tr>
                } @empty { <tr><td colspan="5"><div class="empty"><strong>Aucune décision</strong>Le dossier attend une décision.</div></td></tr> }
              </tbody></table></div></section>
          }
          @case ('history') {
            <section class="card"><div class="card-title"><h2>Historique complet</h2><span class="soft small">Protégé : aucune ligne ne peut être modifiée ni supprimée</span></div>
              <ul class="timeline">
                @for (h of c.history; track h.id) {
                  <li><span class="dot"></span><div><strong>{{ h.action_label }}</strong><small class="soft"> · {{ h.actor_name }} · {{ h.at | date: 'dd/MM/yyyy HH:mm:ss' }}</small>
                    @if (h.note) { <p>{{ h.note }}</p> }</div></li>
                }
              </ul></section>
          }
        }
      </div>

      @switch (dialog()) {
        @case ('note') {
          <wk-confirm title="Ajouter une observation" confirmLabel="Enregistrer" [askReason]="true" reasonLabel="Observation" [busy]="busy()" (confirm)="addNote($event)" (cancel)="dialog.set('')">Elle sera ajoutée à la fiche d'investigation avec votre identité et l'heure.</wk-confirm>
        }
        @case ('verify') {
          <wk-confirm title="Demander une vérification complémentaire" confirmLabel="Envoyer la demande" [askReason]="true" reasonLabel="Vérification demandée (registre de la maternité, appel aux parents…)" [busy]="busy()" (confirm)="verify($event)" (cancel)="dialog.set('')">Le dossier passera en « vérification complémentaire » et restera bloqué.</wk-confirm>
        }
        @case ('reopen') {
          <wk-confirm title="Rouvrir le dossier" confirmLabel="Rouvrir" [askReason]="true" reasonLabel="Motif de la réouverture" [busy]="busy()" (confirm)="reopen($event)" (cancel)="dialog.set('')">La décision précédente est conservée dans l'historique.</wk-confirm>
        }
        @case ('assign') {
          <div class="modal-backdrop" (click)="dialog.set('')"><div class="modal" role="dialog" aria-modal="true" aria-label="Attribuer" (click)="$event.stopPropagation()">
            <h2>Attribuer le dossier</h2>
            <div class="field"><label for="asg">Responsable de l'investigation</label>
              <select id="asg" class="input" [(ngModel)]="assignee"><option value="">Choisir…</option>
                @for (u of options()?.investigators ?? []; track u.uuid) { <option [value]="u.uuid">{{ u.name }}</option> }</select></div>
            <div class="modal-actions"><button class="btn" (click)="dialog.set('')">Annuler</button><button class="btn btn-primary" [disabled]="!assignee || busy()" (click)="assign()">Attribuer</button></div></div></div>
        }
        @case ('decide') {
          <div class="modal-backdrop" (click)="dialog.set('')"><div class="modal wide" role="dialog" aria-modal="true" aria-label="Décision" (click)="$event.stopPropagation()">
            <h2>Rendre une décision</h2>
            <div class="decisions" role="radiogroup" aria-label="Décision">
              @for (o of options()?.decisions ?? []; track o.value) {
                <label class="opt" [class.on]="decision === o.value">
                  <input type="radio" name="dec" [value]="o.value" [(ngModel)]="decision" />
                  <span><strong>{{ o.label }}</strong><small>{{ help[o.value] }}</small></span>
                </label>
              }
            </div>
            @if (needsDuplicate()) {
              <div class="field" style="margin-top:12px"><label class="req" for="dup">Quelle déclaration est la saisie redondante ?</label>
                <select id="dup" class="input" [(ngModel)]="duplicateUuid"><option value="">Choisir…</option>
                  <option [value]="c.declaration.uuid">{{ c.declaration.reference }} — {{ c.declaration.child_name || 'Enfant non nommé' }}</option>
                  <option [value]="c.other_declaration.uuid">{{ c.other_declaration.reference }} — {{ c.other_declaration.child_name || 'Enfant non nommé' }}</option></select>
                @if (suggestion(); as sg) { <small class="soft">Suggestion : <strong class="mono">{{ sg.redundant.reference }}</strong> — {{ sg.why }}. <button type="button" class="btn btn-sm" (click)="duplicateUuid = sg.redundant.uuid">Appliquer</button></small> }
                <small class="soft">L'autre déclaration devient le dossier principal. Aucune donnée n'est supprimée ; un acte déjà établi n'est jamais modifié automatiquement.</small></div>
              @if (outcome(); as o) {
                <div class="alert" [ngClass]="o.protected ? 'alert-warning' : 'alert-info'" style="margin-top:12px">
                  @if (o.protected) {
                    <strong>{{ o.redundant.reference }}</strong> {{ o.protectedWhy }} Elle ne sera pas rejetée automatiquement et restera dans la liste des déclarations ; la rectification suit la procédure légale. <strong>{{ o.principal.reference }}</strong> reste le dossier principal.
                  } @else {
                    <strong>{{ o.redundant.reference }}</strong> sera <strong>rejetée</strong> (statut « Rejeté ») et n'apparaîtra plus dans la liste des déclarations. <strong>{{ o.principal.reference }}</strong> reste le dossier principal : son statut ne change pas. La décision peut être rouverte, ce qui rétablit la déclaration.
                  }
                </div>
              }
            }
            <div class="field" style="margin-top:12px"><label class="req" for="why">Motif de la décision</label>
              <textarea id="why" class="input" rows="3" [(ngModel)]="reason" placeholder="Pièces consultées, vérifications effectuées…"></textarea></div>
            @if (decideError()) { <div class="alert alert-danger" style="margin-top:12px">{{ decideError() }}</div> }
            <p class="soft small" style="margin-top:8px">Décision enregistrée au nom de {{ auth.fullName() }}, avec la date et l'heure. Elle ne peut être ni modifiée ni supprimée.</p>
            <div class="modal-actions"><button class="btn" (click)="dialog.set('')">Annuler</button>
              <button class="btn btn-primary" [disabled]="!canSubmitDecision() || busy()" (click)="decide()">Enregistrer la décision</button></div>
          </div></div>
        }
      }
    } @else if (error()) { <div class="page"><div class="alert alert-danger">{{ error() }}</div></div> }
    @else { <div class="page"><div class="skeleton" style="height:300px"></div></div> }
  `,
    styles: [`
    .pair{display:grid;grid-template-columns:1fr 1fr 220px;gap:16px;margin-bottom:16px}
    .pair article{display:flex;flex-direction:column;gap:3px;min-width:0}
    .tag{font-size:11px;font-weight:700;color:var(--wk-royal);text-transform:uppercase;letter-spacing:.05em}
    .pair small{color:var(--wk-text-soft)} .score{align-items:flex-start;justify-content:center}
    .actions{margin-bottom:16px;padding:14px 16px} .wrap{flex-wrap:wrap;gap:8px}
    .small{font-size:12px} .reason{white-space:pre-wrap;min-width:220px}
    .timeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px}
    .timeline li{display:flex;gap:12px} .timeline p{margin:4px 0 0;white-space:pre-wrap}
    .dot{width:10px;height:10px;border-radius:50%;background:var(--wk-royal);margin-top:6px;flex:none}
    .modal.wide{width:min(680px,100%)}
    .decisions{display:flex;flex-direction:column;gap:8px}
    .opt{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--wk-border);border-radius:var(--r-md);padding:10px 12px;cursor:pointer}
    .opt.on{border-color:var(--wk-royal);background:var(--wk-sky-50)}
    .opt span{display:flex;flex-direction:column;gap:2px} .opt small{color:var(--wk-text-soft);font-size:12px}
    .req::after{content:' *';color:var(--wk-danger)}
    @media (max-width:960px){.pair{grid-template-columns:1fr}}
  `]
})
export class DuplicateCaseComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);
  private autoRefresh = inject(AutoRefreshService);
  auth = inject(AuthService);

  uuid = '';
  c = signal<DuplicateCaseDetail | null>(null);
  comparison = signal<DuplicateComparison | null>(null);
  compareLoading = signal(false);
  options = signal<DuplicateFilterOptions | null>(null);
  tab = signal<Tab>('analysis');
  dialog = signal<Dialog>('');
  busy = signal(false);
  error = signal('');
  decideError = signal('');
  warnings = signal<string[]>([]);
  decision: DecisionCode | '' = '';
  duplicateUuid = '';
  reason = '';
  assignee = '';
  help = DECISION_HELP;
  tabs: { id: Tab; label: string }[] = [
    { id: 'analysis', label: 'Analyse' }, { id: 'compare', label: 'Comparaison' }, { id: 'evidence', label: 'Pièces et observations' },
    { id: 'decisions', label: 'Décisions' }, { id: 'history', label: 'Historique' },
  ];
  riskText(r: string) { return ({ HIGH: 'risque élevé', MEDIUM: 'risque moyen', LOW: 'risque faible' } as Record<string, string>)[r] ?? r; }

  ngOnInit() {
    this.uuid = this.route.snapshot.paramMap.get('uuid') ?? '';
    this.load();
    this.api.get<DuplicateFilterOptions>('/duplicates/cases/filter-options/').subscribe(o => this.options.set(o));
    this.autoRefresh.on(this.destroyRef, () => { if (!this.dialog()) this.load(true); });
  }

  load(silent = false) {
    this.api.get<DuplicateCaseDetail>(`/duplicates/cases/${this.uuid}/`).subscribe({
      next: c => { this.c.set(c); this.error.set(''); }, error: e => { if (!silent) this.error.set(errorMessage(e)); },
    });
  }

  select(t: Tab) {
    this.tab.set(t);
    if (t === 'compare' && !this.comparison()) this.loadComparison();
  }
  private loadComparison() {
    this.compareLoading.set(true);
    this.api.get<DuplicateComparison>(`/duplicates/cases/${this.uuid}/compare/`).subscribe({
      next: d => { this.comparison.set(d); this.compareLoading.set(false); },
      error: e => { this.compareLoading.set(false); this.error.set(errorMessage(e)); },
    });
  }

  viewDoc(doc: CompareDoc) {
    // an investigator's consultation is attached to the case (traced); otherwise only the audited download happens
    if (this.c()?.permissions.investigate) {
      this.api.post(`/duplicates/cases/${this.uuid}/attach-document/`, { document: doc.uuid }).subscribe({
        next: () => { this.load(true); openDocument(this.api, this.toast, doc); }, error: e => this.toast.error(errorMessage(e)),
      });
    } else openDocument(this.api, this.toast, doc);
  }

  private act(path: string, body: unknown, ok: string, after?: () => void) {
    this.busy.set(true);
    this.api.post<DuplicateCaseDetail>(`/duplicates/cases/${this.uuid}/${path}/`, body).subscribe({
      next: c => { this.busy.set(false); this.dialog.set(''); this.c.set(c); this.error.set(''); this.toast.success(ok); after?.(); },
      error: e => { this.busy.set(false); this.dialog.set(''); this.error.set(errorMessage(e)); },
    });
  }
  take() { this.act('take', {}, 'Dossier pris en charge.'); }
  addNote(content: string) { this.act('note', { content }, 'Observation enregistrée.'); }
  verify(content: string) { this.act('request-verification', { content }, 'Demande de vérification enregistrée.'); }
  reopen(reason: string) { this.act('reopen', { reason }, 'Dossier rouvert.'); }
  assign() { this.act('assign', { assignee: this.assignee }, 'Dossier attribué.'); }

  openDecision() { this.decision = ''; this.duplicateUuid = ''; this.reason = ''; this.decideError.set(''); this.dialog.set('decide'); }
  /** Which of the two dossiers looks like the redundant one: never the one holding an act, else the latest entry. */
  suggestion() {
    const c = this.c(); if (!c) return null;
    const a = c.declaration, b = c.other_declaration;
    const held = (d: DeclarationBrief) => !!d.official_number || d.status === 'VALIDATED' || d.status === 'DELIVERED';
    if (held(a) !== held(b)) return { redundant: held(a) ? b : a, why: "l'autre dossier porte déjà un acte" };
    if (a.created_at === b.created_at) return null;
    return { redundant: a.created_at > b.created_at ? a : b, why: "saisie la plus récente" };
  }
  /** What the decision will do to the dossier designated as redundant. */
  outcome() {
    const c = this.c(); if (!c || !this.duplicateUuid) return null;
    const [redundant, principal] = c.declaration.uuid === this.duplicateUuid ? [c.declaration, c.other_declaration] : [c.other_declaration, c.declaration];
    const frozen = redundant.status === 'VALIDATED' || redundant.status === 'DELIVERED';
    const numbered = !!redundant.official_number;
    return { redundant, principal, protected: frozen || numbered,
      protectedWhy: numbered ? `porte déjà l'acte n° ${redundant.official_number}.` : 'est déjà validée.' };
  }
  redundantRejected(c: DuplicateCaseDetail) {
    const d = c.duplicate === c.declaration.reference ? c.declaration : c.other_declaration;
    return d.status === 'REJECTED';
  }
  needsDuplicate() { return !!this.options()?.decisions.find(o => o.value === this.decision)?.designates_duplicate; }
  canSubmitDecision() { return !!this.decision && !!this.reason.trim() && (!this.needsDuplicate() || !!this.duplicateUuid); }
  decide() {
    this.busy.set(true);
    this.api.post<DuplicateCaseDetail>(`/duplicates/cases/${this.uuid}/decide/`, {
      decision: this.decision, reason: this.reason.trim(), duplicate_declaration: this.needsDuplicate() ? this.duplicateUuid : null,
    }).subscribe({
      next: c => {
        this.busy.set(false); this.dialog.set(''); this.warnings.set(c.warnings ?? []); this.c.set(c);
        this.toast.success(c.redundant_outcome === 'rejected' ? `Décision enregistrée : ${c.duplicate} est rejetée et retirée de la liste des déclarations.` : 'Décision enregistrée (action tracée).');
      },
      error: e => { this.busy.set(false); this.decideError.set(errorMessage(e)); },
    });
  }
}
