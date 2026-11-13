import { CommonModule, DatePipe } from '@angular/common';
import { Component, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { OfflineGate, deviceLabel } from '../core/offline/offline-gate.service';
import { LogRow, OP_LABELS, OP_STATUS_LABELS, OpStatus, OpView } from '../core/offline/types';
import { ToastService } from '../core/toast.service';
import { ConfirmComponent, IconComponent, PageHeaderComponent } from '../shared/ui';

const TONE: Record<OpStatus, string> = { pending: 'badge-warning', sending: 'badge-info', applied: 'badge-success', rejected: 'badge-danger', conflict: 'badge-danger' };

/** Everything this device still has to send, what was sent, and what went wrong. */
@Component({
  selector: 'wk-sync-center', standalone: true,
  imports: [CommonModule, DatePipe, RouterLink, IconComponent, PageHeaderComponent, ConfirmComponent],
  template: `
    <div class="page">
      <wk-page-header title="Synchronisation" subtitle="Ce que cet appareil a envoyé au serveur et ce qui attend encore">
        <button class="btn" type="button" (click)="gate.lock()"><wk-icon name="lock" [size]="16" /> Verrouiller</button>
        <button class="btn btn-primary" type="button" [disabled]="gate.syncing()" (click)="sync()">
          <wk-icon name="refresh" [size]="16" /> {{ gate.syncing() ? 'Synchronisation…' : 'Synchroniser' }}</button>
      </wk-page-header>

      @if (gate.revoked()) {
        <div class="alert alert-danger" role="alert">Cet appareil a été révoqué par l'administrateur : le serveur refuse ses envois. Vos déclarations restent enregistrées ici ; contactez l'administrateur pour rétablir l'appareil.</div>
      }
      @if (!gate.enabled()) {
        <div class="alert alert-warning" role="status">Le mode hors connexion a été désactivé par l'administrateur. Les opérations en attente restent synchronisables ; les nouvelles saisies se font en ligne.</div>
      }
      @if (gate.message()) { <div class="alert alert-warning" role="status">{{ gate.message() }}</div> }

      <section class="tiles">
        <div class="tile" [class.off]="!gate.online()"><span>Connexion</span><strong>{{ gate.online() ? 'En ligne' : 'Hors connexion' }}</strong></div>
        <div class="tile"><span>En attente d'envoi</span><strong>{{ gate.waiting() }}</strong></div>
        <div class="tile" [class.bad]="gate.problems() > 0"><span>À corriger</span><strong>{{ gate.problems() }}</strong></div>
        <div class="tile"><span>Dernière synchronisation</span><strong>{{ gate.lastSync() ? (gate.lastSync() | date: 'dd/MM/yyyy HH:mm') : 'Jamais' }}</strong></div>
      </section>

      <section class="card flush">
        <div class="card-title pad"><h2>Opérations de cet appareil</h2><span class="soft">{{ device }}</span></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Dossier</th><th>Opération</th><th>État</th><th>Saisie le</th><th>Détail</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              @for (op of ops(); track op.seq) {
                <tr>
                  <td><a [routerLink]="['/declarations', op.entity]">{{ op.reference || 'Dossier' }}</a>@if (op.childName) { <small class="muted uc"> · {{ op.childName }}</small> }</td>
                  <td>{{ opLabel(op) }}@if (op.fileName) { <small class="muted"> · {{ op.fileName }}</small> }</td>
                  <td><span class="badge" [ngClass]="tone(op.status)">{{ statusLabel(op.status) }}</span></td>
                  <td class="mono">{{ op.deviceTime | date: 'dd/MM/yyyy HH:mm' }}</td>
                  <td class="why">@if (op.status === 'applied') { Envoyée le {{ op.appliedAt | date: 'dd/MM/yyyy HH:mm' }} } @else { {{ op.error || (op.status === 'pending' ? 'Partira à la prochaine synchronisation.' : '') }} }</td>
                  <td class="act">
                    @if (op.status === 'rejected' || op.status === 'conflict') {
                      @if (op.status === 'rejected' || op.errorCode === 'version_conflict') { <button class="btn btn-sm" type="button" (click)="retry(op)">Renvoyer</button> }
                      <button class="btn btn-sm btn-ghost" type="button" (click)="dropping.set(op)">Abandonner</button>
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="6"><div class="empty"><strong>Aucune opération</strong>Tout ce qui a été saisi sur cet appareil est sur le serveur.</div></td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <section class="card" style="margin-top:16px">
        <div class="card-title"><h2>Journal des synchronisations</h2></div>
        @for (l of logs(); track l.id) {
          <div class="log" [class.err]="l.kind === 'error'"><span class="mono muted">{{ l.at | date: 'dd/MM/yyyy HH:mm' }}</span><span>{{ l.message }}</span></div>
        } @empty { <p class="muted">Aucune synchronisation enregistrée.</p> }
      </section>
    </div>

    @if (dropping(); as op) {
      <wk-confirm title="Abandonner les modifications locales" confirmLabel="Abandonner" [danger]="true" (cancel)="dropping.set(null)" (confirm)="discard(op)">
        Les opérations et les photos non envoyées du dossier {{ op.reference }} seront supprimées de cet appareil. Cette action est définitive.
      </wk-confirm>
    }`,
  styles: [`
    .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
    .tile{background:#fff;border:1px solid var(--wk-border);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:4px}
    .tile span{font-size:12.5px;color:var(--wk-text-soft)}.tile strong{font-size:18px}
    .tile.off strong{color:var(--wk-warning)}.tile.bad strong{color:var(--wk-danger)}
    .pad{padding:16px 16px 0}
    .why{max-width:340px;font-size:13px;color:var(--wk-text-soft)}
    .act{white-space:nowrap;text-align:right}
    .log{display:flex;gap:12px;padding:8px 0;border-top:1px solid var(--wk-border);font-size:13px;flex-wrap:wrap}
    .log.err{color:#8f1f2b}
    .alert{margin-bottom:16px}
    .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  `],
})
export class SyncCenterComponent {
  gate = inject(OfflineGate);
  private toast = inject(ToastService);
  ops = signal<OpView[]>([]);
  logs = signal<LogRow[]>([]);
  dropping = signal<OpView | null>(null);
  device = deviceLabel();

  constructor() {
    // reloads whenever something changes on the device (operation queued, sent, refused…)
    effect(() => { this.gate.revision(); void this.load(); });
  }

  opLabel(op: OpView) { return OP_LABELS[op.type]; }
  statusLabel(s: OpStatus) { return OP_STATUS_LABELS[s]; }
  tone(s: OpStatus) { return TONE[s]; }

  private async load() {
    const engine = this.gate.current();
    if (!engine) return;
    const [ops, logs] = await Promise.all([engine.operations(), engine.logs()]);
    this.ops.set(ops); this.logs.set(logs);
  }

  async sync() {
    await this.gate.syncNow();
    if (this.gate.message()) this.toast.error(this.gate.message());
    else if (!this.gate.unsynced()) this.toast.success('Tout est synchronisé.');
  }
  async retry(op: OpView) { await this.gate.current()?.retry(op.entity); }
  async discard(op: OpView) {
    this.dropping.set(null);
    if (op.type === 'document.upload') await this.gate.current()?.dropOperation(op.seq);
    else await this.gate.current()?.discard(op.entity);
    this.toast.info('Modifications locales abandonnées.');
  }
}
