import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, ViewChild, inject } from '@angular/core';
import {
  ArcElement, BarController, BarElement, CategoryScale, Chart, ChartConfiguration, DoughnutController, Filler, Legend,
  LineController, LineElement, LinearScale, PointElement, Tooltip,
} from 'chart.js';
import { STATUS_LABELS, STATUS_TONE, Status } from '../core/models';
import { ToastService } from '../core/toast.service';

Chart.register(ArcElement, BarController, BarElement, CategoryScale, DoughnutController, Filler, Legend, LineController,
  LineElement, LinearScale, PointElement, Tooltip);

/* ── Icons (stroke set, 24px grid) ───────────────── */
const ICONS: Record<string, string> = {
  dashboard: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6M8 13h8M8 17h6',
  certificate: 'M4 4h16v13H4zM8 8h8M8 12h5M15 17l1.5 4 1.5-2 2 .5-1-4',
  hospital: 'M3 21V7l9-4 9 4v14M9 21v-6h6v6M12 8v4M10 10h4',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  chart: 'M3 3v18h18M7 15v3M12 9v9M17 5v13',
  shield: 'M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5l8-3zM9 12l2 2 4-4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeoff: 'M17.9 17.9A10.1 10.1 0 0 1 12 20C5 20 1 12 1 12a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2M1 1l22 22M14.1 14.1a3 3 0 1 1-4.2-4.2',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18M6 6l12 12',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  print: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  menu: 'M3 6h18M3 12h18M3 18h18',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  baby: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM5 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  paper: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
};

@Component({
  selector: 'wk-icon', standalone: true,
  template: `<svg [attr.width]="size" [attr.height]="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path [attr.d]="d"/></svg>`,
  styles: [':host{display:inline-flex;line-height:0;flex:none}'],
})
export class IconComponent {
  @Input() name = 'file';
  @Input() size = 18;
  get d() { return ICONS[this.name] ?? ICONS['file']; }
}

/* ── Logo ────────────────────────────────────────── */
@Component({
  selector: 'wk-logo', standalone: true, imports: [CommonModule],
  template: `
    <div class="logo" [class.light]="light" [class.big]="big">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <defs><linearGradient id="wkg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f9bff"/><stop offset="1" stop-color="#1f5ed8"/></linearGradient></defs>
        <path d="M44 10C30 4 12 14 12 33c0 15 10 24 22 24 9 0 17-5 19-14" fill="none" stroke="url(#wkg)" stroke-width="6" stroke-linecap="round"/>
        <circle cx="36" cy="24" r="7" fill="url(#wkg)"/>
        <path d="M24 46c1-8 6-12 12-12s11 4 12 12c-4 5-8 7-12 7s-9-2-12-7z" fill="url(#wkg)"/>
      </svg>
      <div class="txt"><strong>Wakara</strong><span>{{ subtitle }}</span></div>
    </div>`,
  styles: [`
    .logo{display:flex;align-items:center;gap:10px}
    svg{width:38px;height:38px;flex:none}
    .big svg{width:64px;height:64px}
    .txt{display:flex;flex-direction:column;line-height:1.1}
    strong{font-size:22px;font-weight:800;letter-spacing:-.02em;color:var(--wk-navy-800)}
    .big strong{font-size:44px}
    span{font-size:11px;color:var(--wk-text-soft)}
    .big span{font-size:14px}
    .light strong{color:#fff} .light span{color:rgba(255,255,255,.72)}
  `],
})
export class LogoComponent {
  @Input() subtitle = 'État civil · Ratoma';
  @Input() light = false;
  @Input() big = false;
}

/* ── Status badge ────────────────────────────────── */
@Component({
  selector: 'wk-status', standalone: true,
  template: `<span class="badge" [ngClass]="'badge-' + tone">{{ label }}</span>`,
  imports: [CommonModule],
})
export class StatusBadgeComponent {
  @Input() status: Status | string = 'DRAFT';
  get tone() { return STATUS_TONE[this.status as Status] ?? 'neutral'; }
  get label() { return STATUS_LABELS[this.status as Status] ?? this.status; }
}

/* ── Pagination ──────────────────────────────────── */
@Component({
  selector: 'wk-pagination', standalone: true, imports: [CommonModule],
  template: `
    @if (total > 0) {
      <div class="pager">
        <span class="soft">{{ from }}–{{ to }} sur {{ total }}</span>
        <div class="row">
          <button class="btn btn-sm" [disabled]="page <= 1" (click)="go(page - 1)">Précédent</button>
          <span class="soft mono">Page {{ page }} / {{ pages }}</span>
          <button class="btn btn-sm" [disabled]="page >= pages" (click)="go(page + 1)">Suivant</button>
        </div>
      </div>
    }`,
  styles: ['.pager{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid var(--wk-border)}'],
})
export class PaginationComponent {
  @Input() page = 1;
  @Input() total = 0;
  @Input() pageSize = 20;
  @Output() pageChange = new EventEmitter<number>();
  get pages() { return Math.max(1, Math.ceil(this.total / this.pageSize)); }
  get from() { return (this.page - 1) * this.pageSize + 1; }
  get to() { return Math.min(this.total, this.page * this.pageSize); }
  go(p: number) { this.pageChange.emit(p); }
}

/* ── Chart.js wrapper ────────────────────────────── */
@Component({
  selector: 'wk-chart', standalone: true,
  template: `<div class="box" [style.height.px]="height"><canvas #c></canvas></div>`,
  styles: ['.box{position:relative;width:100%}'],
})
export class ChartComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() config!: ChartConfiguration<any>;
  @Input() height = 260;
  @ViewChild('c') canvas!: ElementRef<HTMLCanvasElement>;
  private chart?: Chart;
  ngAfterViewInit() { this.render(); }
  ngOnChanges() { if (this.canvas) this.render(); }
  private render() {
    this.chart?.destroy();
    if (!this.config) return;
    this.chart = new Chart(this.canvas.nativeElement, {
      ...this.config,
      options: { responsive: true, maintainAspectRatio: false, ...(this.config.options ?? {}) },
    });
  }
  ngOnDestroy() { this.chart?.destroy(); }
}

/* ── Toast host ──────────────────────────────────── */
@Component({
  selector: 'wk-toasts', standalone: true, imports: [CommonModule],
  template: `
    <div class="host" aria-live="polite">
      @for (t of toast.toasts(); track t.id) {
        <div class="toast" [ngClass]="t.kind" role="status">
          <span>{{ t.text }}</span>
          <button class="x" (click)="toast.dismiss(t.id)" aria-label="Fermer">×</button>
        </div>
      }
    </div>`,
  styles: [`
    .host{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:800;max-width:min(420px,calc(100vw - 32px))}
    .toast{display:flex;gap:12px;justify-content:space-between;align-items:flex-start;padding:12px 14px;border-radius:12px;background:#fff;box-shadow:var(--shadow-lg);border-left:4px solid var(--wk-royal);animation:in .2s ease}
    .toast.success{border-color:var(--wk-success)} .toast.error{border-color:var(--wk-danger)}
    .x{border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:var(--wk-text-mute)}
    @keyframes in{from{transform:translateY(8px);opacity:0}to{transform:none;opacity:1}}
  `],
})
export class ToastHostComponent { toast = inject(ToastService); }

/* ── Confirm / reason modal ──────────────────────── */
@Component({
  selector: 'wk-confirm', standalone: true, imports: [CommonModule],
  template: `
    <div class="modal-backdrop" (click)="cancel.emit()" role="presentation">
      <div class="modal" role="dialog" aria-modal="true" [attr.aria-label]="title" (click)="$event.stopPropagation()">
        <h2>{{ title }}</h2>
        <p class="soft"><ng-content /></p>
        @if (askReason) {
          <div class="field" style="margin-top:16px">
            <label [class.req]="reasonRequired">{{ reasonLabel }}</label>
            <textarea class="input" [value]="reason" (input)="reason = $any($event.target).value" rows="3"></textarea>
          </div>
        }
        <div class="modal-actions">
          <button class="btn" (click)="cancel.emit()">Annuler</button>
          <button class="btn" [ngClass]="danger ? 'btn-danger' : 'btn-primary'" [disabled]="busy || (askReason && reasonRequired && !reason.trim())" (click)="confirm.emit(reason.trim())">
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </div>`,
})
export class ConfirmComponent {
  @Input() title = 'Confirmation';
  @Input() confirmLabel = 'Confirmer';
  @Input() danger = false;
  @Input() askReason = false;
  @Input() reasonRequired = true;
  @Input() reasonLabel = 'Motif';
  @Input() busy = false;
  @Output() confirm = new EventEmitter<string>();
  @Output() cancel = new EventEmitter<void>();
  reason = '';
}

/* ── Page header ─────────────────────────────────── */
@Component({
  selector: 'wk-page-header', standalone: true,
  template: `<div class="page-header"><div><h1>{{ title }}</h1>@if (subtitle) {<p>{{ subtitle }}</p>}</div><div class="row"><ng-content /></div></div>`,
})
export class PageHeaderComponent { @Input() title = ''; @Input() subtitle = ''; }

export const SHARED_UI = [IconComponent, LogoComponent, StatusBadgeComponent, PaginationComponent, ChartComponent, ConfirmComponent, PageHeaderComponent] as const;
