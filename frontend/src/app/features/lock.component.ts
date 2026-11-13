import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { OfflineGate } from '../core/offline/offline-gate.service';
import { IconComponent, LogoComponent } from '../shared/ui';

type Mode = 'setup' | 'unlock' | 'reset';

/**
 * PIN screen of the offline mode.
 *   setup   first use on this device: the signed-in agent chooses the code that encrypts the local data
 *   unlock  every time the application is reopened (works without network)
 *   reset   code forgotten: sign in again online, the local data are erased, a new code is chosen
 */
@Component({
  selector: 'wk-lock', standalone: true, imports: [CommonModule, FormsModule, IconComponent, LogoComponent],
  template: `
    <main class="lock">
      <section class="box" aria-labelledby="lock-title">
        <wk-logo subtitle="État civil · Ratoma" />

        @if (mode() === 'setup') {
          <h1 id="lock-title">Protégez cet appareil</h1>
          <p class="soft">Choisissez un code de verrouillage. Il chiffre les déclarations enregistrées sur cet appareil et vous sera demandé à chaque ouverture de Wakara, même sans connexion.</p>
          <form (ngSubmit)="setup()" novalidate>
            <div class="field"><label for="pin">Code de verrouillage (6 caractères au minimum)</label>
              <input id="pin" class="input code" type="password" name="pin" autocomplete="new-password" inputmode="numeric" [(ngModel)]="pin" autofocus /></div>
            <div class="field"><label for="pin2">Confirmez le code</label>
              <input id="pin2" class="input code" type="password" name="pin2" autocomplete="new-password" inputmode="numeric" [(ngModel)]="confirm" /></div>
            @if (error()) { <div class="alert alert-danger" role="alert">{{ error() }}</div> }
            <p class="warn"><wk-icon name="alert" [size]="16" /> Ce code ne peut pas être récupéré. Si vous l'oubliez, les déclarations de cet appareil qui n'ont pas encore été synchronisées seront perdues.</p>
            <button class="btn btn-primary big" type="submit" [disabled]="busy()">
              @if (busy()) { <span class="spinner"></span> } Activer le mode hors connexion</button>
          </form>
          <button type="button" class="link" (click)="skip()">Continuer sans le mode hors connexion sur cet appareil</button>
        }

        @if (mode() === 'unlock') {
          <h1 id="lock-title">Appareil verrouillé</h1>
          <p class="soft">Session de <strong>{{ owner()?.name || owner()?.username }}</strong>. Saisissez votre code de verrouillage pour continuer.</p>
          @if (gate.unsynced()) {
            <p class="count"><wk-icon name="phone" [size]="16" /> {{ gate.unsynced() }} opération(s) enregistrée(s) sur cet appareil, pas encore synchronisée(s).</p>
          }
          <form (ngSubmit)="unlock()" novalidate>
            <div class="field"><label for="code">Code de verrouillage</label>
              <input id="code" class="input code" type="password" name="code" autocomplete="off" inputmode="numeric" [(ngModel)]="pin" autofocus /></div>
            @if (error()) { <div class="alert alert-danger" role="alert">{{ error() }}</div> }
            <button class="btn btn-primary big" type="submit" [disabled]="busy() || !pin">
              @if (busy()) { <span class="spinner"></span> } Déverrouiller</button>
          </form>
          <div class="links">
            <button type="button" class="link" (click)="go('reset')">Code oublié ?</button>
            <button type="button" class="link" (click)="otherAccount()">Utiliser un autre compte</button>
          </div>
        }

        @if (mode() === 'reset') {
          <h1 id="lock-title">Code oublié</h1>
          <p class="soft">Le code ne peut pas être retrouvé. Pour en choisir un nouveau, reconnectez-vous avec le mot de passe de <strong>{{ owner()?.username }}</strong> : les données enregistrées sur cet appareil seront effacées.</p>
          @if (gate.unsynced()) {
            <p class="warn strong"><wk-icon name="alert" [size]="16" /> {{ gate.unsynced() }} opération(s) non synchronisée(s) seront définitivement perdues. Si vous retrouvez votre code, déverrouillez l'appareil et synchronisez d'abord.</p>
          }
          <form (ngSubmit)="reset()" novalidate>
            <div class="field"><label for="pw">Mot de passe du compte</label>
              <input id="pw" class="input" type="password" name="pw" autocomplete="current-password" [(ngModel)]="password" /></div>
            @if (gate.unsynced()) {
              <label class="check"><input type="checkbox" name="ack" [(ngModel)]="ack" /> J'ai compris que ces opérations seront perdues.</label>
            }
            @if (error()) { <div class="alert alert-danger" role="alert">{{ error() }}</div> }
            <button class="btn btn-danger big" type="submit" [disabled]="busy() || !password || (gate.unsynced() > 0 && !ack)">
              @if (busy()) { <span class="spinner"></span> } Effacer les données locales et choisir un nouveau code</button>
          </form>
          <button type="button" class="link" (click)="go('unlock')">Retour</button>
        }
      </section>
    </main>`,
  styles: [`
    .lock{min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:20px;background:linear-gradient(160deg,var(--wk-sky-50),var(--wk-bg))}
    .box{width:min(460px,100%);background:#fff;border:1px solid var(--wk-border);border-radius:20px;box-shadow:var(--shadow-lg);padding:28px;display:flex;flex-direction:column;gap:14px}
    h1{font-size:24px;margin-top:6px}
    form{display:flex;flex-direction:column;gap:12px}
    .code{font-size:20px;letter-spacing:.25em;text-align:center;height:52px}
    .big{height:50px;justify-content:center;font-size:15px}
    .warn{display:flex;gap:8px;align-items:flex-start;margin:0;padding:10px 12px;border-radius:10px;background:var(--wk-warning-bg);color:#7a4700;font-size:13px}
    .warn.strong{background:var(--wk-danger-bg);color:#8f1f2b}
    .count{display:flex;gap:8px;align-items:center;margin:0;padding:10px 12px;border-radius:10px;background:var(--wk-info-bg);color:var(--wk-royal);font-size:13px;font-weight:600}
    .links{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
    .link{background:none;border:0;padding:6px 0;color:var(--wk-royal);font:inherit;font-size:13px;cursor:pointer;text-align:left}
    .link:hover{text-decoration:underline}
  `],
})
export class LockComponent implements OnInit {
  gate = inject(OfflineGate);
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  mode = signal<Mode>('unlock');
  busy = signal(false);
  error = signal('');
  pin = ''; confirm = ''; password = ''; ack = false;

  owner = () => this.gate.header()?.user ?? null;

  ngOnInit() {
    if (this.gate.header()) {
      if (this.gate.unlocked() && this.auth.hasSession) { this.leave(); return; }
      this.mode.set('unlock');
      void this.gate.refreshCounts();
    } else if (this.auth.hasSession) this.mode.set('setup');
    else void this.router.navigate(['/login']);
  }

  go(mode: Mode) { this.error.set(''); this.pin = this.confirm = this.password = ''; this.ack = false; this.mode.set(mode); }

  private leave() {
    const next = this.route.snapshot.queryParamMap.get('next');
    void this.router.navigateByUrl(next && next.startsWith('/') && !next.startsWith('/verrouillage') ? next : '/declarations', { replaceUrl: true });
  }

  async setup() {
    this.error.set('');
    const problem = await this.gate.pinProblem(this.pin);
    if (problem) { this.error.set(problem); return; }
    if (this.pin !== this.confirm) { this.error.set('Les deux codes ne sont pas identiques.'); return; }
    this.busy.set(true);
    try { await this.gate.setup(this.pin); this.leave(); }
    catch (e: any) { this.error.set(e?.message ?? "Impossible d'activer le mode hors connexion sur cet appareil."); }
    finally { this.busy.set(false); }
  }

  async unlock() {
    if (!this.pin) return;
    this.error.set(''); this.busy.set(true);
    try { await this.gate.unlock(this.pin); this.leave(); }
    catch (e: any) { this.pin = ''; this.error.set(e?.message ?? 'Code incorrect.'); }
    finally { this.busy.set(false); }
  }

  skip() { this.gate.skip(); this.leave(); }

  async otherAccount() {
    if ((await this.gate.refreshCounts()) > 0) {
      this.error.set(`Impossible de changer de compte : ${this.gate.unsynced()} opération(s) de cet appareil ne sont pas encore synchronisées. Déverrouillez l'appareil et synchronisez d'abord.`);
      return;
    }
    await this.gate.destroy();
    this.auth.clearForLock();
    void this.router.navigate(['/login']);
  }

  /** Forgotten code: the account password proves who is asking (online only); then everything local is erased. */
  async reset() {
    const owner = this.owner();
    if (!owner || !this.password) return;
    this.error.set(''); this.busy.set(true);
    try {
      const me = await firstValueFrom(this.auth.login(owner.username, this.password, false));
      if (me.uuid !== owner.uuid) { this.auth.clearForLock(); throw new Error("Ce compte n'est pas celui de cet appareil."); }
      await this.gate.destroy();
      this.go('setup');
    } catch (e: any) {
      this.error.set(e?.status === 0 ? 'Une connexion Internet est nécessaire pour réinitialiser le code.'
        : e?.error?.detail ?? e?.message ?? 'Mot de passe incorrect.');
    } finally { this.busy.set(false); }
  }
}
