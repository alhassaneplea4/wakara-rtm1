import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { ApiService, Query, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { AutoRefreshService } from '../core/auto-refresh.service';
import { AuditEntry, Delivery, DeliveryDetail, DeliverySummary, Hospital, Page, STATUS_LABELS, Status } from '../core/models';
import { IconComponent, PageHeaderComponent, PaginationComponent } from '../shared/ui';

/**
 * Follow-up of the acts handed over. Every row opens a detail panel (the delivery, the act, the path of the dossier,
 * the printed copies, the other deliveries). Administrators — who may read the audit log — also see who validated the
 * dossier and how many copies were printed in the table, and the audit trail of the dossier in the panel.
 */
@Component({
  selector: 'wk-deliveries', standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, DatePipe, IconComponent, PageHeaderComponent, PaginationComponent],
  template: `
    <div class="page">
      <wk-page-header title="Suivi des délivrances" subtitle="Historique des actes remis aux demandeurs" />

      <div class="grid counters" aria-label="Chiffres des délivrances">
        @for (c of counters(); track c.label) {
          <div class="card counter"><strong class="mono">{{ c.value }}</strong><span>{{ c.label }}</span></div>
        }
      </div>

      <section class="card flush">
        <div class="filters">
          <input class="input grow" [(ngModel)]="search" (keyup.enter)="reload()" placeholder="Bénéficiaire, pièce, n° d'acte, référence, enfant…" aria-label="Recherche" />
          <select class="input" [(ngModel)]="type" (ngModelChange)="reload()" aria-label="Type de délivrance">
            <option value="">Tous les types</option><option value="false">Première délivrance</option><option value="true">Duplicata</option>
          </select>
          <select class="input" [(ngModel)]="hospital" (ngModelChange)="reload()" aria-label="Établissement">
            <option value="">Tous les établissements</option>
            @for (h of hospitals(); track h.uuid) { <option [value]="h.uuid">{{ h.name }}</option> }
          </select>
          <input class="input date" type="date" [(ngModel)]="from" (ngModelChange)="reload()" title="Délivrées à partir du" aria-label="Délivrées à partir du" />
          <input class="input date" type="date" [(ngModel)]="to" (ngModelChange)="reload()" title="Délivrées jusqu'au" aria-label="Délivrées jusqu'au" />
          <button class="btn" (click)="reload()"><wk-icon name="search" [size]="16" /> Rechercher</button>
          @if (hasFilters()) { <button class="btn btn-ghost" (click)="reset()">Réinitialiser</button> }
        </div>
        @if (error()) { <div class="alert alert-danger" style="margin:16px">{{ error() }}</div> }
        <div class="table-wrap"><table class="table">
          <thead><tr>
            <th>Date</th><th>N° officiel</th><th>Enfant</th><th>Remis à</th><th>Qualité</th><th>Type</th><th>Établissement</th><th>Agent</th>
            @if (admin()) { <th>Validé par</th><th>Copies</th> }
            <th><span class="sr-only">Détail</span></th>
          </tr></thead>
          <tbody>
            @for (d of rows(); track d.uuid) {
              <tr class="clickable" tabindex="0" (click)="open(d)" (keydown.enter)="open(d)" [attr.aria-label]="'Détail de la délivrance du ' + (d.delivered_at | date: 'dd/MM/yyyy') + ' à ' + d.recipient_name">
                <td class="mono">{{ d.delivered_at | date: 'dd/MM/yyyy HH:mm' }}</td>
                <td class="mono"><strong>{{ d.official_number || d.reference }}</strong></td>
                <td class="uc">{{ d.child_name || '—' }}</td>
                <td class="uc">{{ d.recipient_name }}</td>
                <td>{{ d.recipient_relationship || '—' }}</td>
                <td><span class="badge" [ngClass]="d.is_duplicate ? 'badge-warning' : 'badge-success'">{{ d.is_duplicate ? 'Duplicata' : 'Première délivrance' }}</span></td>
                <td>{{ d.hospital_name || '—' }}</td>
                <td>{{ d.delivered_by_name || '—' }}</td>
                @if (admin()) { <td>{{ d.validated_by_name || '—' }}</td><td class="mono">{{ d.print_count }}</td> }
                <td class="go"><wk-icon name="arrow" [size]="16" /></td>
              </tr>
            } @empty { <tr><td [attr.colspan]="admin() ? 11 : 9"><div class="empty"><strong>Aucune délivrance</strong>Les délivrances enregistrées apparaîtront ici.</div></td></tr> }
          </tbody></table></div>
        <wk-pagination [page]="page" [total]="total()" (pageChange)="page = $event; load()" />
      </section>
    </div>

    @if (selected(); as s) {
      <div class="modal-backdrop" (click)="close()">
        <div class="panel" role="dialog" aria-modal="true" aria-label="Détail de la délivrance" (click)="$event.stopPropagation()">
          <header class="ph">
            <div>
              <h2>Délivrance du {{ s.delivered_at | date: 'dd/MM/yyyy' }} à {{ s.delivered_at | date: 'HH:mm' }}</h2>
              <p class="soft"><span class="badge" [ngClass]="s.is_duplicate ? 'badge-warning' : 'badge-success'">{{ s.is_duplicate ? 'Duplicata' : 'Première délivrance' }}</span>
                &nbsp;Acte n° <strong class="mono">{{ s.official_number || s.reference }}</strong> · {{ s.reference }}</p>
            </div>
            <button type="button" class="btn btn-icon btn-ghost" (click)="close()" aria-label="Fermer">×</button>
          </header>

          @if (detail(); as d) {
            <div class="pbody">
              <div class="row actions">
                <a class="btn btn-primary btn-sm" [routerLink]="['/actes', s.acte_uuid, 'document']" (click)="close()"><wk-icon name="eye" [size]="14" /> Voir l'acte</a>
                <a class="btn btn-sm" [routerLink]="['/declarations', s.declaration_uuid]" (click)="close()"><wk-icon name="file" [size]="14" /> Voir le dossier</a>
              </div>

              <section><h3>Remise de l'acte</h3>
                <dl class="kv uc">
                  <dt>Remis à</dt><dd>{{ d.recipient_name }}</dd>
                  <dt>Qualité</dt><dd>{{ d.recipient_relationship || '—' }}</dd>
                  <dt>Pièce présentée</dt><dd>{{ d.recipient_id_type || d.recipient_id_number ? (d.recipient_id_type + ' ' + d.recipient_id_number).trim() : '—' }}</dd>
                  <dt>Délivré par</dt><dd>{{ d.delivered_by_name || '—' }}</dd>
                  <dt>Observations</dt><dd class="nouc">{{ d.notes || '—' }}</dd>
                </dl>
              </section>

              <section><h3>Acte de naissance</h3>
                <dl class="kv uc">
                  <dt>Enfant</dt><dd>{{ d.child_name || '—' }} @if (d.acte.child_gender) { · {{ d.acte.child_gender === 'M' ? 'Masculin' : 'Féminin' }} }</dd>
                  <dt>Né(e)</dt><dd>{{ d.acte.birth_date | date: 'dd/MM/yyyy' }}@if (d.acte.birth_place) { à {{ d.acte.birth_place }} }</dd>
                  @if (d.acte.child_npi) { <dt>NPI</dt><dd>{{ d.acte.child_npi }}</dd> }
                  <dt>Établissement</dt><dd>{{ d.hospital_name || '—' }}</dd>
                  <dt>N° / année</dt><dd>{{ d.acte.numero_acte || '—' }} / {{ d.acte.annee ?? '—' }}</dd>
                  <dt>Registre / feuillet</dt><dd>{{ d.acte.registre || '—' }} / {{ d.acte.feuillet || '—' }}</dd>
                  <dt>Date de déclaration</dt><dd>{{ d.acte.declaration_date ? (d.acte.declaration_date | date: 'dd/MM/yyyy') : '—' }}</dd>
                  <dt>Statut du dossier</dt><dd>{{ d.acte.status_label }}</dd>
                </dl>
              </section>

              <section><h3>Qui a fait quoi</h3>
                <ul class="trace">
                  <li><span class="who">{{ d.acte.created_by_name || '—' }}</span> a enregistré la déclaration</li>
                  @if (d.validated_by_name) { <li><span class="who">{{ d.validated_by_name }}</span> a validé définitivement le dossier@if (d.acte.validated_at) { <small class="muted"> · {{ d.acte.validated_at | date: 'dd/MM/yyyy HH:mm' }}</small> }</li> }
                  @if (d.acte.numero_assigned_by_name) { <li><span class="who">{{ d.acte.numero_assigned_by_name }}</span> a attribué le n° officiel {{ d.acte.numero_acte }}@if (d.acte.numero_assigned_at) { <small class="muted"> · {{ d.acte.numero_assigned_at | date: 'dd/MM/yyyy HH:mm' }}</small> }</li> }
                  @for (p of d.prints; track p.printed_at) { <li><span class="who">{{ p.printed_by_name || '—' }}</span> a imprimé l'exemplaire n° {{ p.copy_number }}<small class="muted"> · {{ p.printed_at | date: 'dd/MM/yyyy HH:mm' }}</small></li> }
                  <li><span class="who">{{ d.delivered_by_name || '—' }}</span> a remis l'acte à <span class="uc">{{ d.recipient_name }}</span><small class="muted"> · {{ d.delivered_at | date: 'dd/MM/yyyy HH:mm' }}</small></li>
                </ul>
                @if (d.other_deliveries.length) {
                  <p class="soft sub">Autres remises de ce même acte :</p>
                  <ul class="trace">@for (o of d.other_deliveries; track o.uuid) {
                    <li><span class="who">{{ o.delivered_by_name || '—' }}</span> → <span class="uc">{{ o.recipient_name }}</span> <span class="badge" [ngClass]="o.is_duplicate ? 'badge-warning' : 'badge-success'">{{ o.is_duplicate ? 'Duplicata' : 'Première délivrance' }}</span><small class="muted"> · {{ o.delivered_at | date: 'dd/MM/yyyy HH:mm' }}</small></li>
                  }</ul>
                }
              </section>

              <section><h3>Parcours du dossier</h3>
                <ol class="steps">
                  @for (h of d.history; track $index) {
                    <li><strong>{{ label(h.to_status) }}</strong><small class="muted"> · {{ h.changed_by_name || 'Système' }} · {{ h.changed_at | date: 'dd/MM/yyyy HH:mm' }}</small>
                      @if (h.reason) { <p class="soft">« {{ h.reason }} »</p> }</li>
                  }
                </ol>
              </section>

              @if (admin()) {
                <section class="adm"><h3>Traçabilité (administrateur)</h3>
                  <p class="soft">Journal d'audit du dossier et de l'acte : adresse IP et motif de chaque action.</p>
                  @for (e of audit(); track e.id) {
                    <div class="jrow"><span class="mono muted">{{ e.created_at | date: 'dd/MM/yyyy HH:mm:ss' }}</span><strong>{{ e.username || 'Système' }}</strong>
                      <span class="badge badge-info">{{ e.action }}</span><span class="soft">{{ e.object_type }}</span>
                      @if (e.ip_address) { <span class="mono muted">{{ e.ip_address }}</span> }
                      @if (e.reason) { <em class="soft">« {{ e.reason }} »</em> }</div>
                  } @empty { <p class="muted">Aucun événement.</p> }
                </section>
              }
            </div>
          } @else if (detailError()) { <div class="alert alert-danger" style="margin:16px">{{ detailError() }}</div> }
          @else { <div class="pbody"><div class="skeleton" style="height:220px"></div></div> }
        </div>
      </div>
    }
  `,
  styles: [`
    .counters{grid-template-columns:repeat(5,minmax(0,1fr));margin-bottom:var(--s4)}
    .counter{display:flex;flex-direction:column;gap:2px;padding:14px 18px}.counter strong{font-size:26px;font-weight:800}.counter span{color:var(--wk-text-soft);font-size:13px}
    @media (max-width:900px){.counters{grid-template-columns:repeat(2,minmax(0,1fr))}}
    .filters{display:flex;gap:10px;flex-wrap:wrap;padding:16px;border-bottom:1px solid var(--wk-border)}
    .filters .input{width:auto;min-height:40px}.filters .grow{flex:1;min-width:240px}.filters .date{width:150px}
    tr.clickable:focus-visible{outline:2px solid var(--wk-royal);outline-offset:-2px}
    td.go{color:var(--wk-text-mute);width:28px}tr.clickable:hover td.go{color:var(--wk-royal)}
    .panel{background:#fff;border-radius:16px;box-shadow:var(--shadow-lg);width:min(720px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;overflow:hidden}
    .ph{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;padding:18px 22px;border-bottom:1px solid var(--wk-border)}
    .ph h2{margin:0 0 4px;font-size:18px}.ph p{margin:0}
    .pbody{padding:16px 22px 22px;overflow:auto;display:flex;flex-direction:column;gap:18px}
    .actions{gap:8px;flex-wrap:wrap}
    h3{margin:0 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:var(--wk-royal)}
    .nouc{text-transform:none}
    .trace{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:13.5px}
    .trace li{padding-left:14px;position:relative}.trace li::before{content:'';position:absolute;left:0;top:8px;width:6px;height:6px;border-radius:50%;background:var(--wk-royal)}
    .who{font-weight:700}.sub{margin:10px 0 4px}
    .steps{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:13.5px}.steps p{margin:2px 0 0}
    .adm{border-top:2px dashed var(--wk-border);padding-top:14px}
    .jrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:7px 0;border-top:1px solid var(--wk-border);font-size:13px}
  `],
})
export class DeliveriesComponent implements OnInit {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private autoRefresh = inject(AutoRefreshService);
  auth = inject(AuthService);
  private last: Query | null = null;

  search = ''; type = ''; hospital = ''; from = ''; to = ''; page = 1;
  rows = signal<Delivery[]>([]); total = signal(0); error = signal('');
  hospitals = signal<Hospital[]>([]);
  summary = signal<DeliverySummary | null>(null);
  selected = signal<Delivery | null>(null);
  detail = signal<DeliveryDetail | null>(null);
  detailError = signal('');
  audit = signal<AuditEntry[]>([]);

  /** Whoever may read the audit log (the administrator) sees the most: validator, printed copies, audit trail. */
  admin = () => this.auth.can('audit.view');
  label(s: string) { return STATUS_LABELS[s as Status] ?? s; }
  hasFilters = () => !!(this.search || this.type || this.hospital || this.from || this.to);

  counters = () => {
    const s = this.summary();
    const v = (n?: number) => (s ? n : '—');
    return [
      { label: 'Délivrances (selon les filtres)', value: v(s?.total) },
      { label: 'Premières délivrances', value: v(s?.first) },
      { label: 'Duplicata', value: v(s?.duplicates) },
      { label: "Aujourd'hui", value: v(s?.today) },
      { label: 'Ce mois-ci', value: v(s?.this_month) },
    ];
  };

  ngOnInit() {
    this.load();
    this.autoRefresh.on(this.destroyRef, () => { if (!this.selected()) this.fetch(this.last); });
    if (this.auth.can('hospital.view')) this.api.get<Page<Hospital>>('/hospitals/', { page_size: 100 }).subscribe({ next: p => this.hospitals.set(p.results), error: () => undefined });
  }

  reload() { this.page = 1; this.load(); }
  reset() { this.search = this.type = this.hospital = this.from = this.to = ''; this.reload(); }
  load() {
    this.last = { search: this.search, is_duplicate: this.type, hospital: this.hospital, delivered_from: this.from, delivered_to: this.to, page: this.page };
    this.fetch(this.last);
  }

  private fetch(query: Query | null) {
    if (!query) return;
    this.api.get<Page<Delivery>>('/actes/deliveries/', query).subscribe({
      next: p => { this.rows.set(p.results); this.total.set(p.count); this.error.set(''); }, error: e => this.error.set(errorMessage(e)),
    });
    const { page, ...filters } = query;   // the counters follow the filters, not the page
    this.api.get<DeliverySummary>('/actes/deliveries/summary/', filters).subscribe({ next: s => this.summary.set(s), error: () => undefined });
  }

  open(d: Delivery) {
    this.selected.set(d); this.detail.set(null); this.detailError.set(''); this.audit.set([]);
    this.api.get<DeliveryDetail>(`/actes/deliveries/${d.uuid}/`).subscribe({
      next: det => {
        this.detail.set(det);
        if (this.admin()) {
          forkJoin([d.acte_uuid, d.declaration_uuid].map(id => this.api.get<Page<AuditEntry>>('/audit/', { object_id: id, page_size: 50 }))).subscribe({
            next: pages => this.audit.set(pages.flatMap(p => p.results).sort((a, b) => b.created_at.localeCompare(a.created_at))),
            error: () => this.audit.set([]),
          });
        }
      },
      error: e => this.detailError.set(errorMessage(e)),
    });
  }

  close() { this.selected.set(null); this.detail.set(null); }
}
