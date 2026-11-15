import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService, errorMessage } from '../../core/api.service';
import { DeclarationListItem, DuplicateComparison, Page } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { IconComponent, PageHeaderComponent } from '../../shared/ui';
import { DupCompareComponent, DupCriteriaComponent, DupTabsComponent, RiskBadgeComponent, ScoreComponent, openDocument } from './duplicates-shared';

/** Free comparison of any two declarations (the score is computed on the fly; nothing is stored). */
@Component({
  selector: 'wk-duplicate-compare-page', standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, PageHeaderComponent, DupCompareComponent, DupCriteriaComponent, DupTabsComponent, RiskBadgeComponent, ScoreComponent],
  template: `
    <div class="page">
      <wk-page-header title="Comparer deux déclarations" subtitle="Mettez côte à côte deux dossiers pour repérer les ressemblances et les divergences" />
      <wk-dup-tabs />
      <section class="card pick">
        @for (side of ['a', 'b']; track side) {
          <div class="field"><label [for]="'s-' + side">Déclaration {{ side.toUpperCase() }}</label>
            <input [id]="'s-' + side" class="input" [(ngModel)]="terms[side]" (ngModelChange)="search(side)" placeholder="Référence ou nom de l'enfant…" autocomplete="off" />
            @if (found()[side].length) {
              <ul class="found">@for (d of found()[side]; track d.uuid) { <li><button type="button" (click)="choose(side, d)"><span class="mono">{{ d.reference }}</span> — {{ d.child_name || 'Enfant non nommé' }}</button></li> }</ul>
            }
            @if (chosen[side]) { <small class="soft">Choisie : <strong class="mono">{{ chosen[side]!.reference }}</strong></small> }</div>
        }
        <button class="btn btn-primary go" [disabled]="!chosen['a'] || !chosen['b'] || loading()" (click)="compare()"><wk-icon name="copy" [size]="16" /> Comparer</button>
      </section>
      @if (error()) { <div class="alert alert-danger" style="margin-bottom:16px">{{ error() }}</div> }
      @if (data(); as d) {
        <section class="card score-card">
          <wk-score [score]="d.score ?? 0" [risk]="d.risk_level ?? ''" /> <wk-risk [level]="d.risk_level ?? 'LOW'" />
          <span class="soft">Qualité des données comparées : {{ d.data_quality }} % · simple aide à la décision (non enregistrée)</span>
        </section>
        <section class="card" style="margin-bottom:16px"><div class="card-title"><h2>Critères</h2></div><wk-dup-criteria [criteria]="d.criteria" /></section>
        <wk-dup-compare [data]="d" (view)="open($event)" />
      }
    </div>`,
  styles: [`
    .pick{display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:start;margin-bottom:16px}
    .go{margin-top:24px} .found{list-style:none;margin:4px 0 0;padding:0;border:1px solid var(--wk-border);border-radius:var(--r-sm);max-height:200px;overflow:auto}
    .found button{width:100%;text-align:left;border:0;background:#fff;padding:8px 10px;cursor:pointer;font:inherit} .found button:hover{background:var(--wk-sky-50)}
    .score-card{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
    @media (max-width:760px){.pick{grid-template-columns:1fr}.go{margin-top:0}}
  `],
})
export class DuplicateComparePageComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);
  terms: Record<string, string> = { a: '', b: '' };
  chosen: Record<string, DeclarationListItem | null> = { a: null, b: null };
  found = signal<Record<string, DeclarationListItem[]>>({ a: [], b: [] });
  data = signal<DuplicateComparison | null>(null);
  loading = signal(false);
  error = signal('');
  private timer: Record<string, ReturnType<typeof setTimeout> | undefined> = {};

  ngOnInit() {
    const q = this.route.snapshot.queryParamMap;
    if (q.get('a') && q.get('b')) this.run(q.get('a')!, q.get('b')!);
  }

  search(side: string) {
    clearTimeout(this.timer[side]);
    const term = this.terms[side].trim();
    if (term.length < 2) { this.found.update(f => ({ ...f, [side]: [] })); return; }
    this.timer[side] = setTimeout(() => {
      this.api.get<Page<DeclarationListItem>>('/declarations/', { search: term, page_size: 8 }).subscribe(p => this.found.update(f => ({ ...f, [side]: p.results })));
    }, 250);
  }
  choose(side: string, d: DeclarationListItem) { this.chosen[side] = d; this.terms[side] = d.reference; this.found.update(f => ({ ...f, [side]: [] })); }
  compare() { this.router.navigate([], { queryParams: { a: this.chosen['a']!.uuid, b: this.chosen['b']!.uuid } }); this.run(this.chosen['a']!.uuid, this.chosen['b']!.uuid); }
  private run(a: string, b: string) {
    this.loading.set(true); this.error.set('');
    this.api.get<DuplicateComparison>('/duplicates/compare/', { a, b }).subscribe({
      next: d => { this.data.set(d); this.loading.set(false); this.terms['a'] = d.a.reference; this.terms['b'] = d.b.reference; },
      error: e => { this.loading.set(false); this.error.set(errorMessage(e)); },
    });
  }
  open(doc: { uuid: string }) { openDocument(this.api, this.toast, doc); }
}
