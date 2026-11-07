import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService, Query, errorMessage } from '../core/api.service';
import { AutoRefreshService } from '../core/auto-refresh.service';
import { HistoryRow, HistorySummary, Hospital, Page, STATUS_LABELS, Status, UserRow } from '../core/models';
import { relativeTime } from '../shared/relative-time';
import { IconComponent, PageHeaderComponent, PaginationComponent, StatusBadgeComponent } from '../shared/ui';

const KINDS: [string, string][] = [
  ['creation', 'Créations'], ['modification', 'Modifications'], ['circuit', 'Circuit du dossier'], ['numero', 'Numérotation'],
  ['impression', 'Impressions'], ['delivrance', 'Délivrances'], ['piece', 'Pièces jointes'], ['archivage', 'Archivage'],
];

/**
 * « Historiques des actes » (administrator): every dossier with its last activity. Search by reference, act number,
 * child, parent, recipient or person; open a dossier to read its whole story.
 */
@Component({
  selector: 'wk-history-list', standalone: true,
  imports: [CommonModule, FormsModule, DatePipe, IconComponent, PageHeaderComponent, PaginationComponent, StatusBadgeComponent],
  template: `
    <div class="page">
      <wk-page-header title="Historiques des actes" subtitle="Qui a créé, modifié, validé, imprimé ou délivré chaque dossier — de la déclaration à la remise de l'acte" />

      <div class="grid counters" aria-label="Activité du jour">
        @for (c of counters(); track c.label) {
          <div class="card counter"><span class="ico"><wk-icon [name]="c.icon" [size]="18" /></span><div><strong class="mono">{{ c.value }}</strong><span>{{ c.label }}</span></div></div>
        }
      </div>

      <section class="card flush">
        <div class="filters">
          <input class="input grow" [(ngModel)]="q" (keyup.enter)="reload()" placeholder="Rechercher : référence, n° d'acte, enfant, parent, bénéficiaire, agent…" aria-label="Recherche" />
          <select class="input" [(ngModel)]="status" (ngModelChange)="reload()" aria-label="Statut du dossier">
            <option value="">Tous les statuts</option>
            @for (s of statuses; track s) { <option [value]="s">{{ labels[s] }}</option> }
          </select>
          <select class="input" [(ngModel)]="user" (ngModelChange)="reload()" aria-label="Personne intervenue">
            <option value="">Toutes les personnes</option>
            @for (u of users(); track u.uuid) { <option [value]="u.uuid">{{ u.first_name }} {{ u.last_name }} ({{ u.username }})</option> }
          </select>
          <select class="input" [(ngModel)]="kind" (ngModelChange)="reload()" aria-label="Type d'action">
            <option value="">Toutes les actions</option>
            @for (k of kinds; track k[0]) { <option [value]="k[0]">{{ k[1] }}</option> }
          </select>
          <select class="input" [(ngModel)]="hospital" (ngModelChange)="reload()" aria-label="Établissement">
            <option value="">Tous les établissements</option>
            @for (h of hospitals(); track h.uuid) { <option [value]="h.uuid">{{ h.name }}</option> }
          </select>
          <input class="input date" type="date" [(ngModel)]="from" (ngModelChange)="reload()" title="Activité à partir du" aria-label="Activité à partir du" />
          <input class="input date" type="date" [(ngModel)]="to" (ngModelChange)="reload()" title="Activité jusqu'au" aria-label="Activité jusqu'au" />
          <button class="btn" (click)="reload()"><wk-icon name="search" [size]="16" /> Rechercher</button>
          @if (hasFilters()) { <button class="btn btn-ghost" (click)="reset()">Réinitialiser</button> }
        </div>
        @if (error()) { <div class="alert alert-danger" style="margin:16px">{{ error() }}</div> }

        <div class="table-wrap"><table class="table">
          <thead><tr><th>Dossier</th><th>N° d'acte</th><th>Statut</th><th>Dernière activité</th><th>Créé par</th><th class="num">Événements</th><th><span class="sr-only">Ouvrir</span></th></tr></thead>
          <tbody>
            @for (r of rows(); track r.uuid) {
              <tr class="clickable" tabindex="0" (click)="open(r)" (keydown.enter)="open(r)" [attr.aria-label]="'Ouvrir l\\'historique du dossier ' + r.reference">
                <td><strong class="mono">{{ r.reference }}</strong>@if (r.is_archived) { <span class="badge badge-neutral">Archivé</span> }
                  <small class="sub uc">{{ r.child_name || 'Enfant non renseigné' }}@if (r.hospital_name) { · {{ r.hospital_name }} }</small></td>
                <td class="mono">{{ r.official_number || '—' }}</td>
                <td><wk-status [status]="r.status" /></td>
                <td><span class="last">{{ r.last_action || '—' }}</span>
                  <small class="sub">{{ r.last_actor ? 'par ' + r.last_actor + ' · ' : '' }}<span [title]="r.last_event_at | date: 'dd/MM/yyyy HH:mm:ss'">{{ ago(r.last_event_at) }}</span></small></td>
                <td>{{ r.created_by_name || '—' }}<small class="sub">{{ r.created_at | date: 'dd/MM/yyyy' }}</small></td>
                <td class="num"><span class="count">{{ r.event_count }}</span></td>
                <td class="go"><wk-icon name="arrow" [size]="16" /></td>
              </tr>
            } @empty { <tr><td colspan="7"><div class="empty"><strong>Aucun dossier</strong>@if (hasFilters()) { Aucun dossier ne correspond à cette recherche. } @else { Les dossiers apparaîtront ici dès qu'ils sont enregistrés. }</div></td></tr> }
          </tbody></table></div>
        <wk-pagination [page]="page" [total]="total()" (pageChange)="page = $event; load()" />
      </section>
    </div>
  `,
  styles: [`
    .counters{grid-template-columns:repeat(5,minmax(0,1fr));margin-bottom:var(--s4)}
    .counter{display:flex;gap:12px;align-items:center;padding:14px 16px}.counter>div{display:flex;flex-direction:column}
    .counter strong{font-size:24px;font-weight:800;line-height:1.1}.counter span:not(.ico){color:var(--wk-text-soft);font-size:12.5px}
    .counter .ico{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--wk-info-bg);color:var(--wk-royal);flex:none}
    @media (max-width:1000px){.counters{grid-template-columns:repeat(2,minmax(0,1fr))}}
    .filters{display:flex;gap:10px;flex-wrap:wrap;padding:16px;border-bottom:1px solid var(--wk-border)}
    .filters .input{width:auto;min-height:40px;max-width:100%}.filters .grow{flex:1 1 100%;min-width:240px}.filters .date{width:150px}
    .sub{display:block;color:var(--wk-text-soft);font-size:12px;margin-top:2px}
    .last{font-weight:600}
    th.num,td.num{text-align:right}
    .count{display:inline-block;min-width:30px;padding:2px 9px;border-radius:999px;background:var(--wk-info-bg);color:var(--wk-royal);font-weight:700;font-size:13px;text-align:center}
    td.go{color:var(--wk-text-mute);width:28px}tr.clickable:hover td.go{color:var(--wk-royal)}
    tr.clickable:focus-visible{outline:2px solid var(--wk-royal);outline-offset:-2px}
  `],
})
export class HistoryListComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  private autoRefresh = inject(AutoRefreshService);
  private last: Query | null = null;
  private request?: Subscription;   // a newer search cancels the previous one, so a slow answer never overwrites a fresh one

  labels = STATUS_LABELS;
  statuses = Object.keys(STATUS_LABELS) as Status[];
  kinds = KINDS;
  q = ''; status = ''; user = ''; kind = ''; hospital = ''; from = ''; to = ''; page = 1;
  rows = signal<HistoryRow[]>([]); total = signal(0); error = signal('');
  users = signal<UserRow[]>([]); hospitals = signal<Hospital[]>([]);
  summary = signal<HistorySummary | null>(null);

  hasFilters = () => !!(this.q || this.status || this.user || this.kind || this.hospital || this.from || this.to);
  ago = relativeTime;

  counters = () => {
    const s = this.summary();
    const v = (n?: number) => (s ? n : '—');
    return [
      { label: "Événements aujourd'hui", value: v(s?.events_today), icon: 'history' },
      { label: 'Dossiers concernés', value: v(s?.dossiers_today), icon: 'file' },
      { label: 'Personnes actives', value: v(s?.users_today), icon: 'users' },
      { label: 'Modifications', value: v(s?.changes_today), icon: 'edit' },
      { label: 'Délivrances', value: v(s?.deliveries_today), icon: 'download' },
    ];
  };

  ngOnInit() {
    this.load();
    this.autoRefresh.on(this.destroyRef, () => this.fetch(this.last));
    this.api.get<Page<UserRow>>('/users/', { page_size: 100 }).subscribe({ next: p => this.users.set(p.results), error: () => undefined });
    this.api.get<Page<Hospital>>('/hospitals/', { page_size: 100 }).subscribe({ next: p => this.hospitals.set(p.results), error: () => undefined });
  }

  reload() { this.page = 1; this.load(); }
  reset() { this.q = this.status = this.user = this.kind = this.hospital = this.from = this.to = ''; this.reload(); }
  open(r: HistoryRow) { this.router.navigate(['/history', r.uuid]); }

  load() {
    this.last = { q: this.q, status: this.status, user: this.user, kind: this.kind, hospital: this.hospital, from: this.from, to: this.to, page: this.page };
    this.fetch(this.last);
  }

  private fetch(query: Query | null) {
    if (!query) return;
    this.request?.unsubscribe();
    this.request = this.api.get<Page<HistoryRow>>('/history/', query).subscribe({
      next: p => { this.rows.set(p.results); this.total.set(p.count); this.error.set(''); }, error: e => this.error.set(errorMessage(e)),
    });
    this.api.get<HistorySummary>('/history/summary/').subscribe({ next: s => this.summary.set(s), error: () => undefined });
  }
}
