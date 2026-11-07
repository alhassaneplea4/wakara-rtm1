import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService, errorMessage } from '../core/api.service';
import { AutoRefreshService } from '../core/auto-refresh.service';
import { HistoryDetail, HistoryEvent } from '../core/models';
import { relativeTime } from '../shared/relative-time';
import { IconComponent, PageHeaderComponent, StatusBadgeComponent } from '../shared/ui';

/** The steps of a dossier, in order; a dossier that was sent back or rejected waits at the step it left. */
const FLOW = [
  { key: 'created', label: 'Déclaration saisie', icon: 'file' },
  { key: 'transmitted', label: 'Transmise au secrétariat', icon: 'arrow' },
  { key: 'in_completion', label: 'Prise en charge', icon: 'paper' },
  { key: 'pending_validation', label: 'Envoyée à la validation', icon: 'shield' },
  { key: 'validated', label: 'Validée définitivement', icon: 'check' },
  { key: 'delivered', label: 'Acte délivré', icon: 'download' },
];

/**
 * The whole story of one dossier, readable at a glance: where it stands, who did each important step, who
 * intervened, then every event (what, who, when, from which address, and the before/after of each change).
 */
@Component({
  selector: 'wk-history-detail', standalone: true,
  imports: [CommonModule, DatePipe, RouterLink, IconComponent, PageHeaderComponent, StatusBadgeComponent],
  template: `
    @if (data(); as h) {
      <div class="page">
        <wk-page-header [title]="h.dossier.reference" [subtitle]="(h.dossier.child_name || 'Enfant non renseigné') + (h.dossier.hospital_name ? ' · ' + h.dossier.hospital_name : '')"
          back="/history" backLabel="Retour aux historiques">
          <a class="btn" [routerLink]="['/declarations', h.dossier.uuid]"><wk-icon name="file" [size]="16" /> Voir le dossier</a>
          @if (h.dossier.acte_uuid && ['VALIDATED','DELIVERED'].includes(h.dossier.status)) {
            <a class="btn" [routerLink]="['/actes', h.dossier.acte_uuid, 'document']"><wk-icon name="certificate" [size]="16" /> Voir l'acte</a>
          }
          <button class="btn" (click)="exportCsv(h)"><wk-icon name="download" [size]="16" /> Exporter (CSV)</button>
        </wk-page-header>

        <!-- 1. where it stands -->
        <section class="card glance">
          <div class="facts">
            <wk-status [status]="h.dossier.status" />
            @if (h.dossier.is_archived) { <span class="badge badge-neutral">Archivé</span> }
            <span><small>N° de l'acte</small><b class="mono">{{ h.dossier.official_number || 'non attribué' }}</b></span>
            @if (h.dossier.registre) { <span><small>Registre</small><b>{{ h.dossier.registre }}{{ h.dossier.annee ? ' / ' + h.dossier.annee : '' }}</b></span> }
            <span><small>Né(e) le</small><b>{{ h.dossier.birth_date | date: 'dd/MM/yyyy' }}</b></span>
            <span><small>Ouvert</small><b>{{ ago(h.dossier.created_at) }}</b></span>
          </div>
          <ol class="flow" aria-label="Progression du dossier">
            @for (st of flow(h); track st.key) {
              <li [class.done]="st.state === 'done'" [class.current]="st.state === 'current'" [attr.aria-current]="st.state === 'current' ? 'step' : null">
                <span class="bubble"><wk-icon [name]="st.state === 'done' ? 'check' : st.icon" [size]="14" /></span><span class="lbl">{{ st.label }}</span>
              </li>
            }
          </ol>
          @if (note(h); as n) { <p class="note" [class.bad]="n.bad">{{ n.text }}</p> }

          <h2 class="sec">Les étapes clés : qui, quand</h2>
          <ul class="miles">
            @for (m of milestones(h); track m.label) {
              <li [class.todo]="!m.e">
                <span class="mark" [ngClass]="m.e ? m.e.tone : ''"><wk-icon [name]="m.icon" [size]="15" /></span>
                <div>
                  <strong>{{ m.label }}@if (m.count > 1) { <span class="badge badge-info">×{{ m.count }}</span> }</strong>
                  @if (m.e) { <span class="who">{{ m.e.who }}@if (m.e.roles.length) { <em> · {{ m.e.roles.join(', ') }}</em> }</span>
                    <small class="muted" [title]="m.e.at | date: 'dd/MM/yyyy HH:mm:ss'">{{ m.e.at | date: 'dd/MM/yyyy à HH:mm' }} · {{ ago(m.e.at) }}</small> }
                  @else { <small class="muted">Pas encore</small> }
                </div>
              </li>
            }
          </ul>
        </section>

        <!-- 2. who -->
        <section class="card">
          <div class="card-title"><h2>Qui est intervenu ({{ h.people.length }})</h2><span class="soft">dans l'ordre de leur première action</span></div>
          <div class="people">
            @for (p of h.people; track p.name) {
              <article class="person">
                <span class="avatar" aria-hidden="true">{{ initials(p.name) }}</span>
                <div>
                  <strong>{{ p.name }}</strong>
                  @if (p.roles.length) { <span class="badge badge-info">{{ p.roles.join(', ') }}</span> }
                  <small class="muted">{{ p.count }} action{{ p.count > 1 ? 's' : '' }} · du {{ p.first_at | date: 'dd/MM/yyyy HH:mm' }} au {{ p.last_at | date: 'dd/MM/yyyy HH:mm' }}</small>
                  <span class="chips">@for (k of p.kinds; track k.kind) { <span class="chip">{{ k.label }} <b>{{ k.count }}</b></span> }</span>
                </div>
              </article>
            } @empty { <p class="muted">Aucune intervention enregistrée.</p> }
          </div>
        </section>

        <!-- 3. everything that happened -->
        <section class="card">
          <div class="card-title"><h2>Chronologie complète ({{ shown().length }}{{ shown().length !== h.events.length ? ' sur ' + h.events.length : '' }})</h2>
            <div class="row tools">
              <button class="btn btn-sm" (click)="newestFirst.set(!newestFirst())">{{ newestFirst() ? 'Du plus récent au plus ancien' : 'Du plus ancien au plus récent' }}</button>
              <button class="btn btn-sm" (click)="expanded.set(!expanded())">{{ expanded() ? 'Tout replier' : 'Tout déplier' }}</button>
            </div></div>
          <div class="kinds" role="group" aria-label="Filtrer par type d'action">
            <button type="button" class="kind" [class.on]="!kind()" (click)="kind.set('')">Tout <b>{{ h.events.length }}</b></button>
            @for (k of h.kinds; track k.kind) { <button type="button" class="kind" [class.on]="kind() === k.kind" (click)="kind.set(k.kind)">{{ k.label }} <b>{{ k.count }}</b></button> }
          </div>

          @for (g of groups(); track g.day) {
            <h3 class="day">{{ g.label }}</h3>
            <ol class="timeline">
              @for (e of g.events; track e.id) {
                <li>
                  <span class="mark" [ngClass]="e.tone"><wk-icon [name]="e.icon" [size]="15" /></span>
                  <div class="body">
                    <div class="head"><strong>{{ e.title }}</strong><span class="badge badge-neutral">{{ e.object }}</span></div>
                    <div class="line"><span class="who">{{ e.who }}</span>@if (e.roles.length) { <em class="muted">{{ e.roles.join(', ') }}</em> }
                      <span class="mono muted">{{ e.at | date: 'HH:mm:ss' }}</span>@if (e.ip) { <span class="mono muted" title="Adresse IP">{{ e.ip }}</span> }</div>
                    @if (e.reason) { <p class="why"><span>Motif</span> {{ e.reason }}</p> }
                    @if (e.details.length) {
                      <details [open]="expanded()">
                        <summary>{{ e.details.length > 1 ? e.details.length + ' éléments' : '1 élément' }}</summary>
                        <table class="diff"><tbody>
                          @for (d of e.details; track d.label) {
                            <tr><th>{{ d.label }}</th>
                              @if (d.value !== undefined) { <td colspan="2">{{ d.value }}</td> }
                              @else { <td class="old">{{ d.from }}</td><td class="new">{{ d.to }}</td> }</tr>
                          }
                        </tbody></table>
                      </details>
                    }
                  </div>
                </li>
              }
            </ol>
          } @empty { <p class="muted" style="margin-top:12px">Aucun événement pour ce filtre.</p> }
        </section>
      </div>
    } @else if (error()) { <div class="page"><div class="alert alert-danger">{{ error() }}</div></div> }
    @else { <div class="page"><div class="card"><div class="skeleton" style="height:320px"></div></div></div> }
  `,
  styles: [`
    .glance .facts{display:flex;gap:22px;flex-wrap:wrap;align-items:center;margin-bottom:16px}
    .facts span{display:flex;flex-direction:column}.facts small{color:var(--wk-text-soft);font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}
    .flow{list-style:none;margin:4px 0 6px;padding:0;display:flex;gap:6px;overflow-x:auto}
    .flow li{flex:1 1 0;min-width:96px;display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;position:relative;font-size:12px;color:var(--wk-text-mute)}
    .flow li:not(:last-child)::after{content:'';position:absolute;top:13px;left:calc(50% + 16px);right:calc(-50% + 16px);height:2px;background:var(--wk-border)}
    .flow li.done:not(:last-child)::after{background:var(--wk-success)}
    .flow .bubble{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:#fff;border:2px solid var(--wk-border);z-index:1}
    .flow .done .bubble{background:var(--wk-success);border-color:var(--wk-success);color:#fff}
    .flow .current .bubble{background:var(--wk-royal);border-color:var(--wk-royal);color:#fff;box-shadow:0 0 0 4px var(--wk-info-bg)}
    .flow .current .lbl{color:var(--wk-royal);font-weight:700}.flow .done .lbl{color:var(--wk-text)}
    .note{margin:6px 0 0;padding:8px 12px;border-radius:8px;background:var(--wk-warning-bg);color:var(--wk-warning);font-size:13px}.note.bad{background:var(--wk-danger-bg);color:var(--wk-danger)}
    .sec{margin:20px 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:var(--wk-royal)}
    .miles{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:10px 18px}
    .miles li{display:flex;gap:12px;align-items:flex-start}.miles li>div{display:flex;flex-direction:column;min-width:0}
    .miles li.todo{opacity:.55}
    .mark{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;flex:none;background:var(--wk-info-bg);color:var(--wk-royal)}
    .mark.success{background:var(--wk-success-bg);color:var(--wk-success)}.mark.warning{background:var(--wk-warning-bg);color:var(--wk-warning)}.mark.danger{background:var(--wk-danger-bg);color:var(--wk-danger)}
    .who{font-weight:600}.who em,.line em{font-weight:400;font-style:normal}
    .people{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
    .person{display:flex;gap:12px;padding:12px;border:1px solid var(--wk-border);border-radius:12px;align-items:flex-start}
    .person>div{display:flex;flex-direction:column;gap:3px;min-width:0}
    .avatar{width:40px;height:40px;border-radius:50%;background:var(--wk-royal);color:#fff;display:grid;place-items:center;font-weight:700;font-size:14px;flex:none}
    .chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}.chip{font-size:12px;padding:2px 8px;border-radius:999px;background:var(--wk-sky-50);border:1px solid var(--wk-border)}
    .tools{gap:8px;flex-wrap:wrap}
    .kinds{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 4px}
    .kind{border:1px solid var(--wk-border);background:#fff;border-radius:999px;padding:5px 12px;font-size:13px;cursor:pointer}
    .kind b{margin-left:4px;color:var(--wk-royal)}.kind.on{background:var(--wk-royal);border-color:var(--wk-royal);color:#fff}.kind.on b{color:#fff}
    .day{margin:20px 0 8px;font-size:13px;text-transform:capitalize;color:var(--wk-text-soft);border-bottom:1px solid var(--wk-border);padding-bottom:4px}
    .timeline{list-style:none;margin:0;padding:0}
    .timeline>li{display:flex;gap:14px;padding-bottom:16px;position:relative}
    .timeline>li:not(:last-child)::before{content:'';position:absolute;left:15px;top:34px;bottom:2px;width:2px;background:var(--wk-border)}
    .body{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
    .head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .line{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px}
    .why{margin:4px 0 0;padding:8px 12px;border-left:3px solid var(--wk-royal);background:var(--wk-sky-50);border-radius:0 8px 8px 0;font-size:13px}.why span{font-weight:700;margin-right:4px}
    details{margin-top:4px;font-size:13px}summary{cursor:pointer;color:var(--wk-royal);font-weight:600}
    .diff{width:100%;border-collapse:collapse;margin-top:6px}
    .diff th{text-align:left;font-weight:600;width:34%;padding:5px 8px 5px 0;vertical-align:top;color:var(--wk-text-soft)}
    .diff td{padding:5px 8px;vertical-align:top;overflow-wrap:anywhere}
    .diff td.old{background:var(--wk-danger-bg);color:var(--wk-danger);text-decoration:line-through;text-decoration-color:rgba(220,53,69,.45)}
    .diff td.new{background:var(--wk-success-bg);color:var(--wk-success);font-weight:600}
    .diff tr+tr th,.diff tr+tr td{border-top:1px solid var(--wk-border)}
  `],
})
export class HistoryDetailComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);
  private autoRefresh = inject(AutoRefreshService);

  data = signal<HistoryDetail | null>(null);
  error = signal('');
  kind = signal('');
  newestFirst = signal(true);
  expanded = signal(false);
  ago = relativeTime;

  /** Events of the selected kind, in the chosen order. */
  shown = computed(() => {
    const d = this.data();
    if (!d) return [] as HistoryEvent[];
    const list = this.kind() ? d.events.filter(e => e.kind === this.kind()) : [...d.events];
    return this.newestFirst() ? list.reverse() : list;
  });

  /** The same events grouped by day (local time), with the day written in full. */
  groups = computed(() => {
    const out: { day: string; label: string; events: HistoryEvent[] }[] = [];
    for (const e of this.shown()) {
      const dt = new Date(e.at);
      const day = `${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}`;
      let g = out[out.length - 1];
      if (!g || g.day !== day) {
        g = { day, label: dt.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), events: [] };
        out.push(g);
      }
      g.events.push(e);
    }
    return out;
  });

  ngOnInit() {
    this.route.paramMap.subscribe(() => this.load());
    this.autoRefresh.on(this.destroyRef, () => this.load());
  }

  load() {
    this.api.get<HistoryDetail>(`/history/${this.route.snapshot.paramMap.get('uuid')}/`).subscribe({
      next: d => { this.data.set(d); this.error.set(''); }, error: e => this.error.set(errorMessage(e)),
    });
  }

  initials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase()).join('') || '?'; }

  flow(h: HistoryDetail) {
    // a dossier sent back waits where it was sent back to, a rejected one at the decision, a validated one for its delivery
    const waits: Record<string, string> = { TO_CORRECT_COLLECTION: 'created', TO_CORRECT_SECRETARIAT: 'in_completion', REJECTED: 'pending_validation', VALIDATED: 'delivered' };
    const status = h.dossier.status as string;
    const idx = FLOW.findIndex(s => s.key === (waits[status] ?? ({ DRAFT: 'created', TRANSMITTED: 'transmitted', IN_COMPLETION: 'in_completion', PENDING_VALIDATION: 'pending_validation', DELIVERED: 'delivered' } as Record<string, string>)[status]));
    return FLOW.map((s, i) => ({ ...s, state: status === 'DELIVERED' || i < idx ? 'done' : i === idx ? 'current' : 'todo' }));
  }

  note(h: HistoryDetail): { text: string; bad: boolean } | null {
    switch (h.dossier.status) {
      case 'TO_CORRECT_COLLECTION': return { text: "Renvoyé à l'agent de collecte pour correction : en attente de sa nouvelle transmission.", bad: false };
      case 'TO_CORRECT_SECRETARIAT': return { text: 'Renvoyé au secrétariat pour correction : en attente d\'une nouvelle soumission à la validation.', bad: false };
      case 'REJECTED': return { text: 'Dossier rejeté : la procédure est close, aucun acte ne sera établi.', bad: true };
      default: return null;
    }
  }

  /** The key steps of the dossier with the person who did each (the last occurrence when a step can be repeated). */
  milestones(h: HistoryDetail) {
    const ev = h.events;
    const of = (m: string) => ev.filter(e => e.milestone === m);
    const pick = (m: string, last = false) => { const l = of(m); return l.length ? (last ? l[l.length - 1] : l[0]) : null; };
    const row = (label: string, icon: string, m: string, last = false) => ({ label, icon, e: pick(m, last), count: of(m).length });
    const rows = [
      row('Déclaration créée', 'file', 'created'),
      row('Transmise au secrétariat', 'arrow', 'transmitted', true),
      row('Prise en charge par le secrétariat', 'paper', 'in_completion'),
      row('Envoyée à la validation', 'shield', 'pending_validation', true),
      row('Validée définitivement', 'check', 'validated'),
      row('Numéro officiel attribué', 'certificate', 'number'),
      row('Acte imprimé', 'print', 'printed', true),
      row('Acte délivré', 'download', 'delivered', true),
    ];
    const lastEdit = [...ev].reverse().find(e => e.kind === 'modification') ?? null;
    rows.push({ label: 'Dernière modification', icon: 'edit', e: lastEdit, count: ev.filter(e => e.kind === 'modification').length });
    for (const [label, icon, m] of [['Renvoyée pour correction', 'history', 'returned'], ['Rejetée', 'x', 'rejected']] as const) {
      if (of(m).length) rows.push(row(label, icon, m, true));
    }
    return rows;
  }

  /** CSV of the timeline; cells starting with = + - @ are neutralised so a spreadsheet never runs them. */
  exportCsv(h: HistoryDetail) {
    const safe = (v: unknown) => { const s = String(v ?? ''); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; };
    const cell = (v: unknown) => `"${safe(v).replace(/"/g, '""')}"`;
    const lines = [['Date', 'Heure', 'Personne', 'Rôle', 'Objet', 'Action', 'Détail', 'Motif', 'Adresse IP'].map(cell).join(';')];
    for (const e of h.events) {
      const dt = new Date(e.at);
      const detail = e.details.map(d => d.value !== undefined ? `${d.label} : ${d.value}` : `${d.label} : ${d.from} → ${d.to}`).join(' | ');
      lines.push([dt.toLocaleDateString('fr-FR'), dt.toLocaleTimeString('fr-FR'), e.who, e.roles.join(', '), e.object, e.title, detail, e.reason, e.ip ?? ''].map(cell).join(';'));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `historique-${h.dossier.reference}.csv`; a.click(); URL.revokeObjectURL(a.href);
  }
}
