import { CommonModule, DatePipe } from '@angular/common';
import { Component, EventEmitter, HostListener, Input, Output, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { OfflineGate } from '../core/offline/offline-gate.service';
import { SYNC_HELP, SYNC_LABELS, SyncState } from '../core/offline/types';
import { ToastService } from '../core/toast.service';
import { ConfirmComponent, IconComponent } from './ui';

const TONE: Record<SyncState, string> = { synced: 'ok', local: 'wait', pending: 'wait', sending: 'busy', error: 'bad', conflict: 'bad' };
const ICON: Record<SyncState, string> = { synced: 'cloud', local: 'phone', pending: 'phone', sending: 'refresh', error: 'alert', conflict: 'alert' };

/* ── Per-dossier indicator: is it on the server, or still on this device? ── */
@Component({
  selector: 'wk-sync', standalone: true, imports: [CommonModule, IconComponent],
  template: `
    @if (state) {
      <span class="sync" [ngClass]="tone" [title]="help" [attr.data-sync]="state">
        <wk-icon [name]="icon" [size]="13" /><span>{{ label }}</span>
      </span>
    }`,
  styles: [`
    .sync{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap;border:1px solid transparent}
    .ok{background:var(--wk-success-bg);color:#0b7a4f}
    .wait{background:var(--wk-warning-bg);color:#9a5b00;border-color:#f3d39b}
    .busy{background:var(--wk-info-bg);color:var(--wk-royal)}
    .bad{background:var(--wk-danger-bg);color:#b02a37;border-color:#f3b6bd}
    .busy wk-icon{animation:spin 1.2s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){.busy wk-icon{animation:none}}
  `],
})
export class SyncChipComponent {
  @Input() state: SyncState | null | undefined;
  get tone() { return this.state ? TONE[this.state] : ''; }
  get icon() { return this.state ? ICON[this.state] : 'cloud'; }
  get label() { return this.state ? SYNC_LABELS[this.state] : ''; }
  get help() { return this.state ? SYNC_HELP[this.state] : ''; }
}

/* ── Explanation and actions at the top of a dossier that is not (fully) on the server ── */
@Component({
  selector: 'wk-sync-banner', standalone: true, imports: [CommonModule, IconComponent, ConfirmComponent],
  template: `
    @if (state && state !== 'synced') {
      <div class="banner" [ngClass]="tone" role="status">
        <wk-icon [name]="icon" [size]="20" />
        <div class="text">
          <strong>{{ title }}</strong>
          <span>{{ detail }}</span>
        </div>
        <div class="row">
          @if (state === 'local' || state === 'pending') {
            <button class="btn btn-sm" type="button" [disabled]="gate.syncing() || !gate.online()" (click)="sync()">
              <wk-icon name="refresh" [size]="14" /> {{ gate.online() ? 'Synchroniser maintenant' : 'Hors connexion' }}</button>
          }
          @if (state === 'error') { <button class="btn btn-sm" type="button" (click)="retry()">Renvoyer</button> }
          @if (state === 'conflict' && canReapply) { <button class="btn btn-sm" type="button" (click)="retry()">Réappliquer mes modifications</button> }
          @if (state === 'error' || state === 'conflict') {
            <button class="btn btn-sm btn-ghost" type="button" (click)="asking.set(true)">{{ state === 'conflict' ? 'Garder la version du serveur' : 'Abandonner mes modifications' }}</button>
          }
        </div>
      </div>
      @if (asking()) {
        <wk-confirm [title]="state === 'conflict' ? 'Garder la version du serveur' : 'Abandonner les modifications locales'" confirmLabel="Abandonner mes modifications"
          [danger]="true" (cancel)="asking.set(false)" (confirm)="discard()">
          Les modifications et les photos de ce dossier qui n'ont pas été envoyées seront supprimées de cet appareil.
          @if (localOnly) { Ce dossier n'existe que sur cet appareil : il sera supprimé. } Cette action est définitive.
        </wk-confirm>
      }
    }`,
  styles: [`
    .banner{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:12px 16px;border-radius:12px;margin-bottom:16px;border:1px solid transparent}
    .text{display:flex;flex-direction:column;gap:2px;flex:1 1 260px;min-width:0}
    .text span{font-size:13px}
    .wait{background:var(--wk-warning-bg);border-color:#f3d39b;color:#7a4700}
    .busy{background:var(--wk-info-bg);color:var(--wk-royal)}
    .bad{background:var(--wk-danger-bg);border-color:#f3b6bd;color:#8f1f2b}
    .row{display:flex;gap:8px;flex-wrap:wrap}
  `],
})
export class SyncBannerComponent {
  gate = inject(OfflineGate);
  private toast = inject(ToastService);
  @Input() state: SyncState | null | undefined;
  @Input() error: { code?: string; detail?: string } | null | undefined;
  @Input() uuid = '';
  /** The dossier never reached the server (giving it up removes it). */
  @Input() localOnly = false;
  @Output() changed = new EventEmitter<'discarded' | 'retried'>();
  asking = signal(false);

  get tone() { return this.state ? TONE[this.state] : ''; }
  get icon() { return this.state ? ICON[this.state] : 'cloud'; }
  get canReapply() { return this.error?.code === 'version_conflict'; }
  get title() {
    switch (this.state) {
      case 'local': return 'Dossier enregistré sur cet appareil uniquement';
      case 'pending': return 'Modifications pas encore envoyées au serveur';
      case 'sending': return 'Envoi au serveur en cours…';
      case 'error': return 'Le serveur a refusé une opération de ce dossier';
      case 'conflict': return 'Ce dossier a changé sur le serveur';
      default: return '';
    }
  }
  get detail() {
    if (this.state === 'error' || this.state === 'conflict') {
      const why = this.error?.detail ? this.error.detail : SYNC_HELP[this.state];
      return this.state === 'error' ? `${why} Corrigez le dossier (« Modifier ») ou renvoyez-le.` : `${why} Rien n'a été écrasé : choisissez la version à garder.`;
    }
    return this.state ? SYNC_HELP[this.state] : '';
  }

  async sync() { await this.gate.syncNow(); if (this.gate.message()) this.toast.error(this.gate.message()); }
  async retry() { await this.gate.current()?.retry(this.uuid); this.changed.emit('retried'); }
  async discard() {
    this.asking.set(false);
    await this.gate.current()?.discard(this.uuid);
    this.toast.info('Modifications locales abandonnées.');
    this.changed.emit('discarded');
  }
}

/* ── Top bar: connection, pending operations, last synchronisation, lock ── */
@Component({
  selector: 'wk-connection', standalone: true, imports: [CommonModule, DatePipe, RouterLink, IconComponent],
  template: `
    <div class="wrap">
      <button type="button" class="pill" [ngClass]="gate.status()" (click)="open.set(!open()); $event.stopPropagation()"
        aria-haspopup="true" [attr.aria-expanded]="open()" [attr.aria-label]="label() + (gate.unsynced() ? ', ' + gate.unsynced() + ' opération(s) en attente' : '')">
        <wk-icon [name]="icon()" [size]="15" /><span class="txt">{{ label() }}</span>
        @if (gate.unsynced()) { <span class="n">{{ gate.unsynced() > 99 ? '99+' : gate.unsynced() }}</span> }
      </button>
      @if (open()) {
        <div class="panel" (click)="$event.stopPropagation()" role="dialog" aria-label="État de la synchronisation">
          <p class="state"><span class="dot" [ngClass]="gate.status()"></span><strong>{{ label() }}</strong></p>
          <dl>
            <dt>En attente d'envoi</dt><dd>{{ gate.waiting() }} opération(s)</dd>
            @if (gate.problems()) { <dt>À corriger</dt><dd class="bad">{{ gate.problems() }} opération(s)</dd> }
            <dt>Dernière synchronisation</dt><dd>{{ gate.lastSync() ? (gate.lastSync() | date: 'dd/MM/yyyy HH:mm') : 'Jamais' }}</dd>
          </dl>
          @if (gate.message()) { <p class="msg">{{ gate.message() }}</p> }
          <button type="button" class="btn btn-primary btn-sm full" [disabled]="gate.syncing()" (click)="sync()">
            <wk-icon name="refresh" [size]="14" /> {{ gate.syncing() ? 'Synchronisation…' : 'Synchroniser' }}</button>
          <a class="btn btn-sm full" routerLink="/synchronisation" (click)="open.set(false)">Voir le détail des opérations</a>
          <button type="button" class="btn btn-sm full" (click)="lock()"><wk-icon name="lock" [size]="14" /> Verrouiller l'appareil</button>
        </div>
      }
    </div>`,
  styles: [`
    .wrap{position:relative;flex:none}
    .pill{display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 12px;border-radius:999px;border:1px solid var(--wk-border);background:#fff;font:inherit;font-size:13px;font-weight:600;cursor:pointer;color:var(--wk-text-soft)}
    .pill.online{color:#0b7a4f;border-color:#b9ead4;background:var(--wk-success-bg)}
    .pill.offline{color:#7a4700;border-color:#f3d39b;background:var(--wk-warning-bg)}
    .pill.pending,.pill.syncing{color:var(--wk-royal);border-color:#c6d8fb;background:var(--wk-info-bg)}
    .pill.attention,.pill.expired{color:#b02a37;border-color:#f3b6bd;background:var(--wk-danger-bg)}
    .pill.syncing wk-icon{animation:spin 1.2s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){.pill.syncing wk-icon{animation:none}}
    .n{min-width:20px;height:20px;line-height:20px;border-radius:999px;background:currentColor;font-size:11px;padding:0 5px;text-align:center}
    .n{color:inherit}.n{-webkit-text-fill-color:#fff}
    .panel{position:absolute;right:0;top:calc(100% + 8px);width:290px;max-width:calc(100vw - 24px);background:#fff;border:1px solid var(--wk-border);border-radius:14px;box-shadow:var(--shadow-lg);padding:14px;z-index:300;display:flex;flex-direction:column;gap:8px}
    .state{display:flex;align-items:center;gap:8px;margin:0}
    .dot{width:10px;height:10px;border-radius:50%;background:var(--wk-success)}
    .dot.offline{background:var(--wk-warning)}.dot.pending,.dot.syncing{background:var(--wk-royal)}.dot.attention,.dot.expired{background:var(--wk-danger)}
    dl{display:grid;grid-template-columns:1fr auto;gap:4px 12px;margin:4px 0;font-size:13px}
    dt{color:var(--wk-text-soft)}dd{margin:0;font-weight:600;text-align:right}
    .bad{color:var(--wk-danger)}
    .msg{margin:0;font-size:12.5px;color:#8f1f2b;background:var(--wk-danger-bg);border-radius:8px;padding:8px 10px}
    .full{width:100%;justify-content:center}
    @media (max-width:560px){.txt{display:none}.pill{padding:0 10px}}
  `],
})
export class ConnectionIndicatorComponent {
  gate = inject(OfflineGate);
  open = signal(false);
  @HostListener('document:click') close() { this.open.set(false); }
  @HostListener('document:keydown.escape') esc() { this.open.set(false); }

  label() {
    switch (this.gate.status()) {
      case 'offline': return 'Hors connexion';
      case 'expired': return 'Session expirée';
      case 'syncing': return 'Synchronisation…';
      case 'attention': return 'À corriger';
      case 'pending': return 'En attente d\'envoi';
      default: return 'En ligne';
    }
  }
  icon() {
    const s = this.gate.status();
    return s === 'offline' ? 'cloudoff' : s === 'syncing' ? 'refresh' : s === 'attention' || s === 'expired' ? 'alert' : 'cloud';
  }
  sync() { void this.gate.syncNow(); }
  lock() { this.open.set(false); this.gate.lock(); }
}

/* ── Re-authentication after the session expired (same agent, the queue then resumes) ── */
@Component({
  selector: 'wk-reauth', standalone: true, imports: [CommonModule, FormsModule],
  template: `
    <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="reauth-title">
      <form class="box" (ngSubmit)="submit()">
        <h2 id="reauth-title">Session expirée</h2>
        <p class="soft">Saisissez le mot de passe de <strong>{{ gate.header()?.user?.username }}</strong> pour reprendre la synchronisation. Vos déclarations enregistrées sur cet appareil sont intactes.</p>
        @if (error()) { <div class="alert alert-danger" role="alert">{{ error() }}</div> }
        <div class="field"><label for="reauth-pw">Mot de passe</label>
          <input id="reauth-pw" class="input" type="password" name="password" autocomplete="current-password" [(ngModel)]="password" required /></div>
        <div class="row end">
          <button type="button" class="btn" (click)="done.emit()">Plus tard</button>
          <button type="submit" class="btn btn-primary" [disabled]="busy() || !password">{{ busy() ? 'Connexion…' : 'Se reconnecter' }}</button>
        </div>
      </form>
    </div>`,
  styles: [`
    .overlay{position:fixed;inset:0;background:rgba(8,34,79,.5);display:grid;place-items:center;z-index:1000;padding:16px}
    .box{background:#fff;border-radius:16px;padding:22px;width:min(440px,100%);display:flex;flex-direction:column;gap:12px;box-shadow:var(--shadow-lg)}
    .end{justify-content:flex-end;display:flex;gap:10px}
  `],
})
export class ReauthComponent {
  gate = inject(OfflineGate);
  private toast = inject(ToastService);
  @Output() done = new EventEmitter<void>();
  password = '';
  busy = signal(false);
  error = signal('');

  async submit() {
    if (!this.password) return;
    this.busy.set(true); this.error.set('');
    try {
      await this.gate.reauthenticate(this.password);
      this.toast.success('Session rétablie : la synchronisation reprend.');
      this.done.emit();
    } catch (e: any) {
      this.error.set(e?.status === 0 ? 'Serveur injoignable : réessayez quand la connexion sera revenue.'
        : e?.error?.detail ?? e?.message ?? 'Connexion impossible.');
    } finally { this.busy.set(false); }
  }
}
