import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { Page } from '../core/models';
import { ToastService } from '../core/toast.service';
import { ConfirmComponent, IconComponent, PageHeaderComponent, PaginationComponent } from '../shared/ui';

interface Device {
  id: number; device_id: string; username: string; user_name: string; label: string; user_agent: string;
  created_at: string; last_seen_at: string | null; last_sync_at: string | null; is_revoked: boolean; revoked_at: string | null;
  has_recovery: boolean; recovery_set_at: string | null; recovery_revealed_at: string | null; recovery_revealed_by_name: string;
}

/** Devices used to work offline. Revoking one makes the server refuse what it sends; the recovery code opens it for an agent who forgot the PIN. */
@Component({
    selector: 'wk-devices',
    imports: [CommonModule, DatePipe, FormsModule, IconComponent, PageHeaderComponent, PaginationComponent, ConfirmComponent],
    template: `
    <div class="page">
      <wk-page-header title="Appareils hors connexion" subtitle="Téléphones et ordinateurs enregistrés par les agents pour travailler sans connexion" />
      @if (error()) { <div class="alert alert-danger" role="alert" style="margin-bottom:16px">{{ error() }}</div> }
      <section class="card flush">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Agent</th><th>Appareil</th><th>Enregistré le</th><th>Dernier contact</th><th>Dernière synchronisation</th><th>État</th><th>Code de récupération</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              @for (d of rows(); track d.id) {
                <tr>
                  <td><strong>{{ d.user_name }}</strong><br /><small class="muted mono">{{ d.username }}</small></td>
                  <td [title]="d.user_agent">{{ d.label || 'Appareil' }}</td>
                  <td class="mono">{{ d.created_at | date: 'dd/MM/yyyy HH:mm' }}</td>
                  <td class="mono">{{ d.last_seen_at ? (d.last_seen_at | date: 'dd/MM/yyyy HH:mm') : '—' }}</td>
                  <td class="mono">{{ d.last_sync_at ? (d.last_sync_at | date: 'dd/MM/yyyy HH:mm') : '—' }}</td>
                  <td><span class="badge" [ngClass]="d.is_revoked ? 'badge-danger' : 'badge-success'">{{ d.is_revoked ? 'Révoqué' : 'Autorisé' }}</span></td>
                  <td>
                    @if (d.has_recovery) {
                      <span class="badge badge-success">Enregistré</span>
                      @if (d.recovery_revealed_at) {
                        <br /><small class="muted">Communiqué le {{ d.recovery_revealed_at | date: 'dd/MM/yyyy HH:mm' }}{{ d.recovery_revealed_by_name ? ' par ' + d.recovery_revealed_by_name : '' }}</small>
                      }
                    } @else { <span class="badge">Pas encore</span> }
                  </td>
                  <td class="act">
                    @if (auth.can('device.recover') && d.has_recovery) {
                      <button class="btn btn-sm" type="button" (click)="openRecovery(d)"><wk-icon name="lock" [size]="14" /> Code de récupération</button>
                    }
                    @if (auth.can('user.manage_status')) {
                      @if (d.is_revoked) { <button class="btn btn-sm" type="button" (click)="set(d, false)">Rétablir</button> }
                      @else { <button class="btn btn-sm btn-ghost" type="button" (click)="asking.set(d)"><wk-icon name="lock" [size]="14" /> Révoquer</button> }
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="8"><div class="empty"><strong>Aucun appareil</strong>Aucun agent n'a encore activé le mode hors connexion.</div></td></tr>
              }
            </tbody>
          </table>
        </div>
        <wk-pagination [page]="page" [total]="total()" [pageSize]="20" (pageChange)="goto($event)" />
      </section>
      <p class="soft note">Révoquer un appareil ne supprime rien : le serveur refuse simplement ses synchronisations (appareil perdu ou volé, agent parti). Les déclarations déjà reçues sont conservées ; celles restées sur l'appareil y demeurent chiffrées.</p>
      <p class="soft note">Un agent qui a oublié son code de verrouillage vous appelle : après avoir <strong>vérifié qui il est</strong>, affichez le code de récupération de son appareil et dictez-le lui. Il ouvre l'appareil, garde ses déclarations non synchronisées et choisit un nouveau code ; un nouveau code de récupération est alors enregistré. Chaque lecture est inscrite au journal d'audit.</p>
    </div>
    @if (asking(); as d) {
      <wk-confirm title="Révoquer cet appareil" confirmLabel="Révoquer" [danger]="true" (cancel)="asking.set(null)" (confirm)="set(d, true)">
        Le serveur refusera toutes les synchronisations de l'appareil « {{ d.label || 'Appareil' }} » de {{ d.user_name }}. Vous pourrez le rétablir à tout moment.
      </wk-confirm>
    }
    @if (recovering(); as d) {
      <div class="modal-backdrop" (click)="closeRecovery()" role="presentation">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Code de récupération de l'appareil" (click)="$event.stopPropagation()">
          <h2>Code de récupération</h2>
          <p class="soft">Appareil « {{ d.label || 'Appareil' }} » de <strong>{{ d.user_name }}</strong>.</p>
          @if (!revealed()) {
            <div class="alert alert-warning" role="note">Ne communiquez ce code qu'à l'agent lui-même, <strong>après avoir vérifié son identité</strong> (rappel sur le numéro que vous connaissez, collègue qui le reconnaît…). Un appareil volé ne doit jamais être ouvert par ce moyen : révoquez-le plutôt.</div>
            <form (ngSubmit)="reveal(d)" novalidate>
              <div class="field" style="margin-top:12px"><label class="req" for="rr">Motif</label>
                <textarea id="rr" class="input" rows="2" name="reason" [(ngModel)]="reason" placeholder="Ex. : l'agent a oublié son code, identité vérifiée par téléphone"></textarea></div>
              <div class="field" style="margin-top:12px"><label class="req" for="rp">Votre mot de passe</label>
                <input id="rp" class="input" type="password" name="password" autocomplete="current-password" [(ngModel)]="password" /></div>
              @if (recoveryError()) { <div class="alert alert-danger" role="alert" style="margin-top:12px">{{ recoveryError() }}</div> }
              <div class="modal-actions">
                <button class="btn" type="button" (click)="closeRecovery()">Annuler</button>
                <button class="btn btn-primary" type="submit" [disabled]="busy() || reason.trim().length < 10 || !password">Afficher le code</button>
              </div>
            </form>
          } @else {
            <p class="code-box mono" aria-live="polite">{{ revealed() }}</p>
            <p class="soft">Dictez-le à l'agent, groupe par groupe. Il n'est plus valable dès que l'agent l'a utilisé : l'appareil en enregistre un nouveau. Cette lecture est inscrite au journal d'audit.</p>
            <div class="modal-actions">
              <button class="btn" type="button" (click)="copy()">Copier</button>
              <button class="btn btn-primary" type="button" (click)="closeRecovery()">Fermer</button>
            </div>
          }
        </div>
      </div>
    }`,
    styles: [`
      .act{text-align:right;white-space:nowrap}.note{margin-top:14px;max-width:820px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
      .code-box{font-size:22px;font-weight:700;letter-spacing:.06em;text-align:center;padding:16px 8px;margin:14px 0;border-radius:12px;background:var(--wk-info-bg);color:var(--wk-royal);word-break:break-all;user-select:all}
    `]
})
export class DevicesComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  auth = inject(AuthService);
  rows = signal<Device[]>([]);
  total = signal(0);
  error = signal('');
  asking = signal<Device | null>(null);
  recovering = signal<Device | null>(null);
  revealed = signal('');
  recoveryError = signal('');
  busy = signal(false);
  reason = ''; password = '';
  page = 1;

  ngOnInit() { this.load(); }
  goto(p: number) { this.page = p; this.load(); }

  load() {
    this.api.get<Page<Device>>('/sync/devices/', { page: this.page }).subscribe({
      next: p => { this.rows.set(p.results); this.total.set(p.count); this.error.set(''); },
      error: e => this.error.set(errorMessage(e)),
    });
  }

  set(d: Device, revoked: boolean) {
    this.asking.set(null);
    this.api.post(`/sync/devices/${d.id}/${revoked ? 'revoke' : 'restore'}/`).subscribe({
      next: () => { this.toast.success(revoked ? 'Appareil révoqué.' : 'Appareil rétabli.'); this.load(); },
      error: e => this.toast.error(errorMessage(e)),
    });
  }

  openRecovery(d: Device) { this.reason = ''; this.password = ''; this.revealed.set(''); this.recoveryError.set(''); this.recovering.set(d); }

  /** The code leaves the screen (and this component) as soon as the dialog closes. */
  closeRecovery() {
    const read = !!this.revealed();
    this.recovering.set(null); this.revealed.set(''); this.reason = ''; this.password = ''; this.recoveryError.set('');
    if (read) this.load();
  }

  reveal(d: Device) {
    if (this.busy()) return;
    this.busy.set(true); this.recoveryError.set('');
    this.api.post<{ code: string }>(`/sync/devices/${d.id}/recovery/`, { reason: this.reason.trim(), password: this.password }).subscribe({
      next: r => { this.revealed.set(r.code); this.password = ''; this.busy.set(false); },
      error: e => { this.recoveryError.set(errorMessage(e)); this.password = ''; this.busy.set(false); },
    });
  }

  async copy() {
    try { await navigator.clipboard.writeText(this.revealed()); this.toast.success('Code copié.'); }
    catch { this.toast.error('Copie impossible : recopiez le code à la main.'); }
  }
}
