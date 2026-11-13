import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { ApiService, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { Page } from '../core/models';
import { ToastService } from '../core/toast.service';
import { ConfirmComponent, IconComponent, PageHeaderComponent, PaginationComponent } from '../shared/ui';

interface Device {
  id: number; device_id: string; username: string; user_name: string; label: string; user_agent: string;
  created_at: string; last_seen_at: string | null; last_sync_at: string | null; is_revoked: boolean; revoked_at: string | null;
}

/** Devices used by the collection agents to work offline. Revoking one makes the server refuse what it sends. */
@Component({
  selector: 'wk-devices', standalone: true,
  imports: [CommonModule, DatePipe, IconComponent, PageHeaderComponent, PaginationComponent, ConfirmComponent],
  template: `
    <div class="page">
      <wk-page-header title="Appareils hors connexion" subtitle="Téléphones et ordinateurs enregistrés par les agents de collecte pour travailler sans connexion" />
      @if (error()) { <div class="alert alert-danger" role="alert" style="margin-bottom:16px">{{ error() }}</div> }
      <section class="card flush">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Agent</th><th>Appareil</th><th>Enregistré le</th><th>Dernier contact</th><th>Dernière synchronisation</th><th>État</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              @for (d of rows(); track d.id) {
                <tr>
                  <td><strong>{{ d.user_name }}</strong><br /><small class="muted mono">{{ d.username }}</small></td>
                  <td [title]="d.user_agent">{{ d.label || 'Appareil' }}</td>
                  <td class="mono">{{ d.created_at | date: 'dd/MM/yyyy HH:mm' }}</td>
                  <td class="mono">{{ d.last_seen_at ? (d.last_seen_at | date: 'dd/MM/yyyy HH:mm') : '—' }}</td>
                  <td class="mono">{{ d.last_sync_at ? (d.last_sync_at | date: 'dd/MM/yyyy HH:mm') : '—' }}</td>
                  <td><span class="badge" [ngClass]="d.is_revoked ? 'badge-danger' : 'badge-success'">{{ d.is_revoked ? 'Révoqué' : 'Autorisé' }}</span></td>
                  <td class="act">
                    @if (auth.can('user.manage_status')) {
                      @if (d.is_revoked) { <button class="btn btn-sm" type="button" (click)="set(d, false)">Rétablir</button> }
                      @else { <button class="btn btn-sm btn-ghost" type="button" (click)="asking.set(d)"><wk-icon name="lock" [size]="14" /> Révoquer</button> }
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="7"><div class="empty"><strong>Aucun appareil</strong>Aucun agent n'a encore activé le mode hors connexion.</div></td></tr>
              }
            </tbody>
          </table>
        </div>
        <wk-pagination [page]="page" [total]="total()" [pageSize]="20" (pageChange)="goto($event)" />
      </section>
      <p class="soft note">Révoquer un appareil ne supprime rien : le serveur refuse simplement ses synchronisations (appareil perdu ou volé, agent parti). Les déclarations déjà reçues sont conservées ; celles restées sur l'appareil y demeurent chiffrées.</p>
    </div>
    @if (asking(); as d) {
      <wk-confirm title="Révoquer cet appareil" confirmLabel="Révoquer" [danger]="true" (cancel)="asking.set(null)" (confirm)="set(d, true)">
        Le serveur refusera toutes les synchronisations de l'appareil « {{ d.label || 'Appareil' }} » de {{ d.user_name }}. Vous pourrez le rétablir à tout moment.
      </wk-confirm>
    }`,
  styles: ['.act{text-align:right;white-space:nowrap}.note{margin-top:14px;max-width:820px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}'],
})
export class DevicesComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  auth = inject(AuthService);
  rows = signal<Device[]>([]);
  total = signal(0);
  error = signal('');
  asking = signal<Device | null>(null);
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
}
