import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService, errorMessage, fieldErrors } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { Me } from '../core/models';
import { ToastService } from '../core/toast.service';
import { PageHeaderComponent } from '../shared/ui';

interface TwoFactorState { enabled: boolean; required: boolean; enabled_at: string | null; backup_codes_left: number; }

@Component({
    selector: 'wk-profile',
    imports: [CommonModule, FormsModule, DatePipe, PageHeaderComponent],
    template: `
    <div class="page">
      <wk-page-header title="Mon profil" [subtitle]="auth.roleLabel()" />
      @if (forced) { <div class="alert alert-warning" style="margin-bottom:16px" role="alert">Pour des raisons de sécurité, vous devez choisir un nouveau mot de passe avant de continuer.</div> }
      @if (force2fa) { <div class="alert alert-warning" style="margin-bottom:16px" role="alert">Votre rôle exige la double authentification : activez-la ci-dessous avant de continuer.</div> }
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

        <section class="card">
          <div class="card-title"><h2>Double authentification</h2></div>
          @if (tfErr()) { <div class="alert alert-danger" style="margin-bottom:12px" role="alert">{{ tfErr() }}</div> }
          @if (!tf()) { <p class="soft">Chargement…</p> }
          @else if (backupCodes().length) {
            <div class="alert alert-success" role="status"><strong>Double authentification activée.</strong> Conservez ces codes de secours : chacun remplace une fois le code de l'application si vous perdez votre téléphone. Ils ne seront plus affichés.</div>
            <ul class="codes mono">@for (c of backupCodes(); track c) { <li>{{ c }}</li> }</ul>
            <div class="modal-actions">
              <button class="btn" type="button" (click)="copyCodes()">Copier</button>
              <button class="btn" type="button" (click)="printCodes()">Imprimer</button>
              <button class="btn btn-primary" type="button" (click)="backupCodes.set([])">J'ai conservé mes codes</button>
            </div>
          }
          @else if (setup()) {
            <p class="soft">1. Dans votre application d'authentification (Google Authenticator, Microsoft Authenticator, Aegis…), ajoutez un compte et saisissez cette clé :</p>
            <p class="secret mono" aria-label="Clé de configuration">{{ setup()!.secret }}</p>
            <p class="soft"><a [href]="setupLink()" class="link">Ouvrir directement dans l'application (sur ce téléphone)</a></p>
            <p class="soft">2. Saisissez le code à 6 chiffres qu'elle affiche :</p>
            <div class="field"><input class="input code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" [(ngModel)]="tfCode" aria-label="Code à 6 chiffres" /></div>
            <div class="modal-actions">
              <button class="btn" type="button" (click)="setup.set(null)">Annuler</button>
              <button class="btn btn-primary" type="button" [disabled]="tfCode.replace(' ', '').length < 6" (click)="enableTwoFactor()">Activer</button>
            </div>
          }
          @else if (tf()!.enabled) {
            <p><span class="badge badge-success">Activée</span> @if (tf()!.enabled_at) { depuis le {{ tf()!.enabled_at | date: 'dd/MM/yyyy' }} } · {{ tf()!.backup_codes_left }} code(s) de secours restant(s)</p>
            @if (tf()!.backup_codes_left <= 2) { <div class="alert alert-warning" style="margin-bottom:12px">Il vous reste peu de codes de secours : générez-en de nouveaux.</div> }
            @if (confirming()) {
              <p class="soft">{{ confirming() === 'disable' ? 'Pour désactiver la double authentification' : 'Pour générer de nouveaux codes de secours' }}, confirmez avec votre mot de passe et un code actuel.</p>
              <div class="form-grid" style="grid-template-columns:1fr">
                <div class="field"><label>Mot de passe</label><input class="input" type="password" autocomplete="current-password" [(ngModel)]="tfPassword" /></div>
                <div class="field"><label>Code de l'application (ou code de secours)</label><input class="input" type="text" autocomplete="one-time-code" [(ngModel)]="tfCode" /></div>
              </div>
              <div class="modal-actions">
                <button class="btn" type="button" (click)="cancelConfirm()">Annuler</button>
                <button class="btn" [ngClass]="confirming() === 'disable' ? 'btn-danger' : 'btn-primary'" type="button" [disabled]="!tfPassword || !tfCode" (click)="confirmChange()">Confirmer</button>
              </div>
            } @else {
              <div class="modal-actions">
                <button class="btn" type="button" (click)="confirming.set('codes')">Nouveaux codes de secours</button>
                @if (!tf()!.required) { <button class="btn btn-danger" type="button" (click)="confirming.set('disable')">Désactiver</button> }
              </div>
              @if (tf()!.required) { <p class="soft">Votre rôle exige la double authentification : elle ne peut pas être désactivée.</p> }
            }
          }
          @else {
            <p class="soft">Ajoute une seconde étape à la connexion : un code à 6 chiffres calculé par une application sur votre téléphone, même sans connexion Internet. {{ tf()!.required ? 'Elle est exigée pour votre rôle.' : 'Elle est facultative.' }}</p>
            @if (asking()) {
              <div class="field"><label>Votre mot de passe</label><input class="input" type="password" autocomplete="current-password" [(ngModel)]="tfPassword" /></div>
              <div class="modal-actions">
                <button class="btn" type="button" (click)="asking.set(false)">Annuler</button>
                <button class="btn btn-primary" type="button" [disabled]="!tfPassword" (click)="startSetup()">Continuer</button>
              </div>
            } @else {
              <div class="modal-actions"><button class="btn btn-primary" type="button" (click)="asking.set(true)">Activer la double authentification</button></div>
            }
          }
        </section>
      </div>
    </div>
  `,
    styles: [`
      .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
      .secret{font-size:18px;font-weight:700;letter-spacing:.08em;padding:12px;border-radius:10px;background:var(--wk-info-bg);color:var(--wk-royal);word-break:break-all;user-select:all}
      .codes{list-style:none;padding:0;margin:12px 0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;font-size:16px;font-weight:600}
      .codes li{padding:8px 10px;border:1px dashed var(--wk-border);border-radius:8px;text-align:center}
      .code{font-size:20px;letter-spacing:.2em;text-align:center}
    `]
})
export class ProfileComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  auth = inject(AuthService);

  forced = false; force2fa = false;
  tf = signal<TwoFactorState | null>(null);
  tfErr = signal('');
  asking = signal(false);
  setup = signal<{ secret: string; otpauth_uri: string } | null>(null);
  backupCodes = signal<string[]>([]);
  confirming = signal<'' | 'disable' | 'codes'>('');
  tfPassword = ''; tfCode = '';
  private sanitizer = inject(DomSanitizer);
  me: Me = { ...(this.auth.user() as Me) };
  pw = { old_password: '', new_password: '' }; confirm = '';
  pErr = signal(''); wErr = signal(''); werrs = signal<Record<string, string>>({});

  ngOnInit() {
    this.forced = this.route.snapshot.queryParamMap.has('force') || !!this.auth.user()?.must_change_password;
    this.force2fa = this.route.snapshot.queryParamMap.has('force2fa') || !!this.auth.user()?.must_set_up_two_factor;
    this.loadTwoFactor();
  }

  private loadTwoFactor() {
    this.api.get<TwoFactorState>('/auth/two-factor/').subscribe({ next: s => this.tf.set(s), error: e => this.tfErr.set(errorMessage(e)) });
  }

  /** otpauth:// opens the authentication application installed on the phone (the page sanitiser would block the scheme). */
  setupLink(): SafeUrl { return this.sanitizer.bypassSecurityTrustUrl(this.setup()?.otpauth_uri ?? ''); }

  startSetup() {
    this.tfErr.set('');
    this.api.post<{ secret: string; otpauth_uri: string }>('/auth/two-factor/setup/', { password: this.tfPassword }).subscribe({
      next: r => { this.setup.set(r); this.asking.set(false); this.tfPassword = ''; this.tfCode = ''; },
      error: e => { this.tfPassword = ''; this.tfErr.set(errorMessage(e)); },
    });
  }

  enableTwoFactor() {
    this.tfErr.set('');
    this.api.post<TwoFactorState & { backup_codes: string[] }>('/auth/two-factor/enable/', { code: this.tfCode }).subscribe({
      next: r => {
        this.setup.set(null); this.tfCode = ''; this.backupCodes.set(r.backup_codes); this.tf.set(r);
        this.auth.reloadUser().subscribe(u => { this.force2fa = !!u.must_set_up_two_factor; });
        this.toast.success('Double authentification activée.');
      },
      error: e => { this.tfCode = ''; this.tfErr.set(errorMessage(e)); },
    });
  }

  cancelConfirm() { this.confirming.set(''); this.tfPassword = this.tfCode = ''; }

  confirmChange() {
    this.tfErr.set('');
    const body = { password: this.tfPassword, code: this.tfCode };
    if (this.confirming() === 'disable') {
      this.api.post<TwoFactorState>('/auth/two-factor/disable/', body).subscribe({
        next: s => { this.tf.set(s); this.cancelConfirm(); this.auth.reloadUser().subscribe(); this.toast.success('Double authentification désactivée.'); },
        error: e => { this.tfCode = ''; this.tfErr.set(errorMessage(e)); },
      });
    } else {
      this.api.post<TwoFactorState & { backup_codes: string[] }>('/auth/two-factor/backup-codes/', body).subscribe({
        next: r => { this.tf.set(r); this.backupCodes.set(r.backup_codes); this.cancelConfirm(); },
        error: e => { this.tfCode = ''; this.tfErr.set(errorMessage(e)); },
      });
    }
  }

  async copyCodes() {
    try { await navigator.clipboard.writeText(this.backupCodes().join('\n')); this.toast.success('Codes copiés.'); }
    catch { this.toast.error('Copie impossible : recopiez les codes à la main.'); }
  }

  printCodes() { window.print(); }

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
    this.api.post<{ access?: string; refresh?: string }>('/auth/change-password/', this.pw).subscribe({
      next: r => {
        if (r?.access && r?.refresh) this.auth.adoptTokens(r.access, r.refresh);
        this.pw ={ old_password: '', new_password: '' }; this.confirm = '';
        this.auth.reloadUser().subscribe(u => { this.toast.success('Mot de passe modifié.'); if (this.forced) this.router.navigate([this.auth.can('stats.view') ? '/dashboard' : '/declarations']); this.forced = u.must_change_password; });
      },
      error: e => { this.werrs.set(fieldErrors(e)); this.wErr.set(errorMessage(e)); },
    });
  }
}
