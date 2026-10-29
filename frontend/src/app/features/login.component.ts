import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { environment } from '@env/environment';
import { errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { IconComponent, LogoComponent } from '../shared/ui';

interface PublicSettings { [key: string]: string; }

const FALLBACK: PublicSettings = {
  'login.tag': 'ÉTAT CIVIL',
  'login.headline': 'Des naissances\nmieux *enregistrées*\npour un *avenir plus sûr.*',
  'login.description': "Wakara est la plateforme de gestion des déclarations de naissance et des actes de naissance de la mairie de Ratoma. Un outil moderne, sécurisé et au service des citoyens.",
  'login.footer': 'Une solution moderne pour un état civil fiable et accessible',
};

@Component({
  selector: 'wk-login', standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, LogoComponent],
  template: `
    <div class="login">
      <section class="left">
        <div class="box">
          <wk-logo [big]="true" subtitle="État civil de la mairie de Ratoma" />
          <div class="rule"></div>
          <h1>Bienvenue sur Wakara</h1>
          <p class="intro">Connectez-vous à votre espace de travail pour accéder à la gestion des déclarations et actes de naissance.</p>

          @if (expired()) { <div class="alert alert-warning" role="alert">Votre session a expiré. Veuillez vous reconnecter.</div> }
          @if (error()) { <div class="alert alert-danger" role="alert">{{ error() }}</div> }

          <form (ngSubmit)="submit()" #f="ngForm" novalidate>
            <div class="control" [class.invalid]="submitted && !username">
              <wk-icon name="user" [size]="20" />
              <input name="username" [(ngModel)]="username" autocomplete="username" placeholder="Identifiant ou email" aria-label="Identifiant ou email" required autofocus />
            </div>
            <div class="control" [class.invalid]="submitted && !password">
              <wk-icon name="lock" [size]="20" />
              <input name="password" [(ngModel)]="password" [type]="show() ? 'text' : 'password'" autocomplete="current-password" placeholder="Mot de passe" aria-label="Mot de passe" required />
              <button type="button" class="eye" (click)="show.set(!show())" [attr.aria-label]="show() ? 'Masquer le mot de passe' : 'Afficher le mot de passe'">
                <wk-icon [name]="show() ? 'eyeoff' : 'eye'" [size]="20" />
              </button>
            </div>
            <div class="opts">
              <label class="check"><input type="checkbox" name="remember" [(ngModel)]="remember" /> Se souvenir de moi</label>
              <button type="button" class="link" (click)="forgot.set(true)">Mot de passe oublié ?</button>
            </div>
            <button class="btn btn-primary submit" type="submit" [disabled]="loading()">
              @if (loading()) { <span class="spinner"></span> Connexion… } @else { <span class="go"><wk-icon name="arrow" [size]="16" /></span> Se connecter }
            </button>
          </form>
          <p class="foot"><span></span>{{ cfg()['login.footer'] }}<span></span></p>
        </div>
      </section>

      <section class="right">
        <svg class="art" viewBox="0 0 800 640" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0d3380"/><stop offset="1" stop-color="#071b44"/></linearGradient>
            <linearGradient id="glow" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#4f9bff" stop-opacity=".0"/><stop offset="1" stop-color="#4f9bff" stop-opacity=".55"/></linearGradient>
          </defs>
          <rect width="800" height="640" fill="url(#bg)"/>
          <path d="M-40 560C140 430 330 470 520 360S780 150 860 60V700H-40z" fill="url(#glow)" opacity=".55"/>
          <path d="M-40 620C180 500 380 560 560 430S800 260 860 200V700H-40z" fill="#4f9bff" opacity=".12"/>
          <g opacity=".22" fill="none" stroke="#9cc4ff" stroke-width="2">
            <path d="M420 60h360v260H420z M450 90h50v60h-50z M530 90h50v60h-50z M610 90h50v60h-50z M690 90h50v60h-50z M450 190h50v60h-50z M530 190h50v60h-50z M610 190h50v60h-50z M690 190h50v60h-50z"/>
            <path d="M400 320h400M470 60l-40-30h330l-40 30"/>
          </g>
          <text x="440" y="48" fill="#9cc4ff" opacity=".5" font-size="22" font-weight="700" letter-spacing="3" transform="rotate(-3 440 48)">MAIRIE DE RATOMA</text>
          <g transform="translate(440 300) scale(5.2)" opacity=".16" fill="#fff">
            <circle cx="36" cy="24" r="7"/><path d="M24 46c1-8 6-12 12-12s11 4 12 12c-4 5-8 7-12 7s-9-2-12-7z"/>
            <path d="M44 10C30 4 12 14 12 33c0 15 10 24 22 24 9 0 17-5 19-14" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
          </g>
        </svg>

        <div class="content">
          <span class="tag"><i></i>{{ cfg()['login.tag'] }}</span>
          <h2>
            @for (line of headline(); track $index) {
              @for (seg of line; track $index) { <span [class.accent]="seg.accent">{{ seg.text }}</span> } <br />
            }
          </h2>
          <p class="desc">{{ cfg()['login.description'] }}</p>
          <ul class="features">
            <li><span class="ico"><wk-icon name="file" [size]="26" /></span><strong>Suivi des dossiers</strong><small>de la déclaration à la délivrance</small></li>
            <li><span class="ico"><wk-icon name="shield" [size]="26" /></span><strong>Validation sécurisée</strong><small>et traçabilité complète</small></li>
            <li><span class="ico"><wk-icon name="chart" [size]="26" /></span><strong>Statistiques fiables</strong><small>par période et par hôpital</small></li>
            <li><span class="ico"><wk-icon name="users" [size]="26" /></span><strong>Accès adapté</strong><small>à chaque profil</small></li>
          </ul>
        </div>
      </section>
    </div>

    @if (forgot()) {
      <div class="modal-backdrop" (click)="forgot.set(false)">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Mot de passe oublié" (click)="$event.stopPropagation()">
          <h2>Mot de passe oublié</h2>
          <p class="soft">La réinitialisation en libre-service n'est pas activée. Contactez l'administrateur technique de Wakara : il vous remettra un mot de passe temporaire que vous devrez changer à la première connexion.</p>
          <div class="modal-actions"><button class="btn btn-primary" (click)="forgot.set(false)">Compris</button></div>
        </div>
      </div>
    }
  `,
  styles: [`
    .login{display:grid;grid-template-columns:minmax(0,.95fr) minmax(0,1.05fr);height:100vh;min-height:620px;background:#fff;overflow:hidden}
    .left{display:grid;place-items:center;padding:24px;background:radial-gradient(900px 500px at 0% 0%,#eaf2ff 0,#fff 60%);overflow-y:auto}
    .box{width:min(480px,100%);display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px}
    .box>wk-logo{align-self:center}
    .rule{width:44px;height:3px;background:var(--wk-royal);border-radius:3px;margin-top:-4px}
    h1{font-size:28px;font-weight:800;margin-top:10px}
    .intro{color:var(--wk-text-soft);max-width:400px}
    form{width:100%;display:flex;flex-direction:column;gap:14px;margin-top:8px;text-align:left}
    .box>.alert{width:100%;text-align:left}
    .control{display:flex;align-items:center;gap:12px;height:54px;padding:0 16px;background:#fff;border:1px solid var(--wk-border);border-radius:12px;color:var(--wk-text-mute);box-shadow:var(--shadow-sm);transition:border-color .15s,box-shadow .15s}
    .control:focus-within{border-color:var(--wk-royal);box-shadow:0 0 0 3px rgba(31,94,216,.15);color:var(--wk-royal)}
    .control.invalid{border-color:var(--wk-danger)}
    .control input{flex:1;border:0;outline:0;background:none;font:inherit;font-size:15px;color:var(--wk-text);min-width:0;height:100%}
    .eye{border:0;background:none;color:var(--wk-text-mute);cursor:pointer;display:grid;place-items:center;padding:6px}
    .link{background:none;border:0;padding:0;font:inherit;color:var(--wk-royal);cursor:pointer}
    .link:hover{text-decoration:underline}
    .opts{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;font-size:13px}
    .submit{height:56px;font-size:16px;border-radius:12px;background:linear-gradient(180deg,#2a67e0,#14449f)}
    .go{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.22)}
    .foot{display:flex;align-items:center;gap:14px;width:100%;color:var(--wk-text-soft);font-size:13px;margin-top:14px}
    .foot span{flex:1;height:1px;background:var(--wk-border)}

    .right{position:relative;color:#fff;overflow:hidden;display:flex;align-items:center}
    .art{position:absolute;inset:0;width:100%;height:100%}
    .content{position:relative;padding:clamp(28px,5vw,72px);width:100%;display:flex;flex-direction:column;gap:20px}
    .tag{display:inline-flex;align-items:center;gap:10px;align-self:flex-start;border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.1);padding:7px 16px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:.18em;backdrop-filter:blur(4px)}
    .tag i{width:8px;height:8px;border-radius:50%;background:var(--wk-sky)}
    h2{color:#fff;font-size:clamp(28px,3.4vw,46px);line-height:1.12;font-weight:800;letter-spacing:-.02em}
    h2 .accent{color:#6aa9ff}
    .desc{max-width:560px;color:rgba(255,255,255,.86);font-size:15px;line-height:1.6}
    .features{list-style:none;margin:24px 0 0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}
    .features li{display:flex;flex-direction:column;gap:6px}
    .features strong{font-size:14px}
    .features small{color:rgba(255,255,255,.7);font-size:12px}
    .ico{width:54px;height:54px;border-radius:14px;display:grid;place-items:center;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);margin-bottom:6px}

    @media (max-width:1100px){.features{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media (max-width:900px){
      .login{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto;height:auto;min-height:100vh;overflow:visible}
      .left{padding:32px 20px}
      .right{min-height:0}
      .content{padding:32px 20px;gap:14px}
      h2{font-size:28px}
      .features{display:none}
      .desc{font-size:14px}
    }
    @media (max-width:420px){h1{font-size:24px}.control{height:52px}}
  `],
})
export class LoginComponent implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private http = inject(HttpClient);

  username = '';
  password = '';
  remember = false;
  submitted = false;
  show = signal(false);
  loading = signal(false);
  error = signal('');
  forgot = signal(false);
  expired = signal(false);
  cfg = signal<PublicSettings>(FALLBACK);

  headline = () => {
    const raw = this.cfg()['login.headline'] ?? FALLBACK['login.headline']!;
    return raw.split('\n').map(line => line.split('*').map((text, i) => ({ text, accent: i % 2 === 1 })).filter(s => s.text));
  };

  ngOnInit() {
    this.expired.set(this.route.snapshot.queryParamMap.has('expired'));
    // Editable texts (Paramètres). Falls back to the built-in copy if the API is unreachable.
    this.http.get<PublicSettings>(`${environment.apiUrl}/public/settings/`).subscribe({
      next: s => this.cfg.set({ ...FALLBACK, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v)) }),
      error: () => undefined,
    });
  }

  submit() {
    this.submitted = true;
    this.error.set('');
    if (!this.username.trim() || !this.password) { this.error.set('Veuillez saisir votre identifiant et votre mot de passe.'); return; }
    this.loading.set(true);
    this.auth.login(this.username.trim(), this.password, this.remember).subscribe({
      next: user => {
        this.loading.set(false);
        if (user.must_change_password) { this.router.navigate(['/profile'], { queryParams: { force: 1 } }); return; }
        const next = this.route.snapshot.queryParamMap.get('next');
        this.router.navigateByUrl(next && next.startsWith('/') ? next : this.auth.can('stats.view') ? '/dashboard' : '/declarations');
      },
      error: err => { this.loading.set(false); this.error.set(errorMessage(err, 'Connexion impossible.')); },
    });
  }
}
