import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService, errorMessage, fieldErrors } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { Me } from '../core/models';
import { ToastService } from '../core/toast.service';
import { PageHeaderComponent } from '../shared/ui';

@Component({
  selector: 'wk-profile', standalone: true,
  imports: [CommonModule, FormsModule, DatePipe, PageHeaderComponent],
  template: `
    <div class="page">
      <wk-page-header title="Mon profil" [subtitle]="auth.roleLabel()" />
      @if (forced) { <div class="alert alert-warning" style="margin-bottom:16px" role="alert">Pour des raisons de sécurité, vous devez choisir un nouveau mot de passe avant de continuer.</div> }
      <div class="grid grid-2">
        <section class="card">
          <div class="card-title"><h2>Informations personnelles</h2></div>
          @if (pErr()) { <div class="alert alert-danger" style="margin-bottom:12px">{{ pErr() }}</div> }
          <div class="form-grid">
            <div class="field"><label>Identifiant</label><input class="input" [value]="me.username" disabled /></div>
            <div class="field"><label>Prénom</label><input class="input" [(ngModel)]="me.first_name" /></div>
            <div class="field"><label>Nom</label><input class="input" [(ngModel)]="me.last_name" /></div>
            <div class="field"><label>E-mail</label><input class="input" type="email" [(ngModel)]="me.email" /></div>
            <div class="field"><label>Téléphone</label><input class="input" [(ngModel)]="me.phone" /></div>
            <div class="field wide"><label>Adresse</label><input class="input" [(ngModel)]="me.address" /></div>
          </div>
          <div class="modal-actions"><button class="btn btn-primary" (click)="saveProfile()">Enregistrer</button></div>
          <p class="soft">Membre depuis le {{ me.date_joined | date: 'dd/MM/yyyy' }} · Dernière connexion : {{ me.last_login ? (me.last_login | date: 'dd/MM/yyyy HH:mm') : '—' }}</p>
        </section>

        <section class="card">
          <div class="card-title"><h2>Changer le mot de passe</h2></div>
          @if (wErr()) { <div class="alert alert-danger" style="margin-bottom:12px">{{ wErr() }}</div> }
          <div class="form-grid" style="grid-template-columns:1fr">
            <div class="field"><label>Mot de passe actuel</label><input class="input" type="password" autocomplete="current-password" [(ngModel)]="pw.old_password" /></div>
            <div class="field"><label>Nouveau mot de passe</label><input class="input" type="password" autocomplete="new-password" [(ngModel)]="pw.new_password" [class.invalid]="werrs()['new_password']" /><span class="field-error">{{ werrs()['new_password'] }}</span></div>
            <div class="field"><label>Confirmer le nouveau mot de passe</label><input class="input" type="password" autocomplete="new-password" [(ngModel)]="confirm" /></div>
          </div>
          <div class="modal-actions"><button class="btn btn-primary" [disabled]="!pw.old_password || !pw.new_password" (click)="changePassword()">Modifier le mot de passe</button></div>
          <h3 style="margin-top:24px">Mes permissions</h3>
          <div class="chips">@for (p of auth.user()?.permissions ?? []; track p) { <span class="badge badge-neutral mono">{{ p }}</span> }</div>
        </section>
      </div>
    </div>
  `,
  styles: ['.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}'],
})
export class ProfileComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  auth = inject(AuthService);

  forced = false;
  me: Me = { ...(this.auth.user() as Me) };
  pw = { old_password: '', new_password: '' }; confirm = '';
  pErr = signal(''); wErr = signal(''); werrs = signal<Record<string, string>>({});

  ngOnInit() { this.forced = this.route.snapshot.queryParamMap.has('force') || !!this.auth.user()?.must_change_password; }

  saveProfile() {
    this.pErr.set('');
    const { first_name, last_name, email, phone, address } = this.me;
    this.api.patch<Me>('/auth/me/', { first_name, last_name, email, phone, address }).subscribe({
      next: () => { this.auth.reloadUser().subscribe(); this.toast.success('Profil mis à jour.'); },
      error: e => this.pErr.set(errorMessage(e)),
    });
  }

  changePassword() {
    this.wErr.set(''); this.werrs.set({});
    if (this.pw.new_password !== this.confirm) { this.wErr.set('La confirmation ne correspond pas au nouveau mot de passe.'); return; }
    this.api.post('/auth/change-password/', this.pw).subscribe({
      next: () => {
        this.pw = { old_password: '', new_password: '' }; this.confirm = '';
        this.auth.reloadUser().subscribe(u => { this.toast.success('Mot de passe modifié.'); if (this.forced) this.router.navigate([this.auth.can('stats.view') ? '/dashboard' : '/declarations']); this.forced = u.must_change_password; });
      },
      error: e => { this.werrs.set(fieldErrors(e)); this.wErr.set(errorMessage(e)); },
    });
  }
}
