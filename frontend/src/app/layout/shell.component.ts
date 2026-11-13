import { CommonModule } from '@angular/common';
import { Component, DestroyRef, HostListener, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { ApiService } from '../core/api.service';
import { AutoRefreshService } from '../core/auto-refresh.service';
import { AuthService } from '../core/auth.service';
import { Inbox } from '../core/models';
import { OfflineGate } from '../core/offline/offline-gate.service';
import { ConnectionIndicatorComponent, ReauthComponent } from '../shared/sync-ui';
import { ToastService } from '../core/toast.service';
import { ConfirmComponent, IconComponent, LogoComponent } from '../shared/ui';

interface NavItem { label: string; icon: string; link: string; perms: string[]; }

const NAV: NavItem[] = [
  { label: 'Tableau de bord', icon: 'dashboard', link: '/dashboard', perms: ['stats.view'] },
  { label: 'Déclarations', icon: 'file', link: '/declarations', perms: ['declaration.view'] },
  { label: 'File de validation', icon: 'shield', link: '/validation', perms: ['dossier.validate'] },
  { label: 'Actes de naissance', icon: 'certificate', link: '/actes', perms: ['acte.view'] },
  { label: 'Délivrances', icon: 'download', link: '/deliveries', perms: ['acte.view'] },
  { label: 'Hôpitaux et maternités', icon: 'hospital', link: '/hospitals', perms: ['hospital.view'] },
  { label: 'Utilisateurs', icon: 'users', link: '/users', perms: ['user.view'] },
  { label: 'Rôles et permissions', icon: 'lock', link: '/roles', perms: ['role.view'] },
  { label: 'Historiques des actes', icon: 'search', link: '/history', perms: ['audit.view'] },
  { label: "Journaux d'activité", icon: 'history', link: '/audit', perms: ['audit.view'] },
  { label: 'Appareils hors connexion', icon: 'phone', link: '/appareils', perms: ['audit.view'] },
  { label: 'Paramètres', icon: 'settings', link: '/settings', perms: ['settings.manage'] },
];

@Component({
  selector: 'wk-shell', standalone: true,
  imports: [CommonModule, FormsModule, RouterOutlet, RouterLink, RouterLinkActive, IconComponent, LogoComponent, ConfirmComponent,
    ConnectionIndicatorComponent, ReauthComponent],
  template: `
    <div class="shell" [class.nav-open]="navOpen()">
      <aside class="sidebar" aria-label="Navigation principale" [attr.aria-hidden]="null">
        <div class="brand"><wk-logo [light]="true" subtitle="État civil · Ratoma" />
          <button type="button" class="close" (click)="navOpen.set(false)" aria-label="Fermer le menu">×</button></div>
        <nav>
          @for (item of items(); track item.link) {
            <a [routerLink]="item.link" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: false }" ariaCurrentWhenActive="page" (click)="navOpen.set(false)">
              <wk-icon [name]="item.icon" /><span>{{ item.label }}</span>
              @if (badge(item.link); as n) { <span class="count" aria-hidden="true">{{ n > 99 ? '99+' : n }}</span><span class="sr-only">{{ n }} à traiter</span> }
            </a>
          }
          @if (gate.visible()) {
            <a routerLink="/synchronisation" routerLinkActive="active" ariaCurrentWhenActive="page" (click)="navOpen.set(false)">
              <wk-icon name="refresh" /><span>Synchronisation</span>
              @if (gate.unsynced(); as n) { <span class="count" aria-hidden="true">{{ n > 99 ? '99+' : n }}</span><span class="sr-only">{{ n }} opération(s) en attente</span> }
            </a>
          }
        </nav>
        <div class="bottom">
          <a routerLink="/profile" routerLinkActive="active" (click)="navOpen.set(false)"><wk-icon name="user" /><span>Mon profil</span></a>
          <button type="button" class="logout" (click)="logout()"><wk-icon name="logout" /><span>Déconnexion</span></button>
        </div>
      </aside>
      <div class="backdrop" (click)="navOpen.set(false)"></div>

      <div class="main">
        <header class="topbar">
          <button class="btn btn-icon btn-ghost menu" (click)="navOpen.set(!navOpen())" aria-label="Menu"><wk-icon name="menu" /></button>
          @if (auth.can('declaration.view')) {
            <form class="search" (submit)="search($event)" role="search">
              <wk-icon name="search" [size]="16" />
              <input name="q" [(ngModel)]="q" placeholder="Rechercher un dossier, un nom, une référence…" aria-label="Recherche globale" />
            </form>
          }
          <div class="spacer"></div>

          @if (gate.visible()) { <wk-connection /> }

          <div class="menu-wrap">
            <button class="btn btn-icon btn-ghost bell" (click)="toggle('inbox'); $event.stopPropagation()" aria-label="Notifications">
              <wk-icon name="bell" />
              @if (inbox()?.total) { <span class="dot">{{ inbox()!.total > 99 ? '99+' : inbox()!.total }}</span> }
            </button>
            @if (open() === 'inbox') {
              <div class="dropdown" (click)="$event.stopPropagation()">
                <h3>À traiter</h3>
                @for (i of inbox()?.items ?? []; track i.code) {
                  <a [routerLink]="inboxLink(i.status)" (click)="open.set('')"><span>{{ i.label }}</span><strong>{{ i.count }}</strong></a>
                } @empty { <p class="muted pad">Aucune tâche en attente.</p> }
              </div>
            }
          </div>

          <div class="menu-wrap">
            <button class="account" (click)="toggle('account'); $event.stopPropagation()" aria-haspopup="menu">
              <span class="avatar">{{ initials() }}</span>
              <span class="who"><strong>{{ auth.fullName() }}</strong><small>{{ auth.roleLabel() }}</small></span>
            </button>
            @if (open() === 'account') {
              <div class="dropdown" role="menu" (click)="$event.stopPropagation()">
                <a routerLink="/profile" role="menuitem" (click)="open.set('')">Mon profil</a>
                @if (gate.visible()) { <button type="button" class="item" role="menuitem" (click)="gate.lock()">Verrouiller l'appareil</button> }
                <button type="button" class="item" role="menuitem" (click)="logout()">Déconnexion</button>
              </div>
            }
          </div>
        </header>
        @if (gate.visible() && auth.sessionExpired() && gate.online()) {
          <div class="strip danger" role="alert"><span>Session expirée : vos saisies restent enregistrées sur cet appareil, mais rien n'est envoyé au serveur.</span>
            <button type="button" class="btn btn-sm" (click)="reauth.set(true)">Se reconnecter</button></div>
        }
        @if (gate.visible() && gate.revoked()) {
          <div class="strip danger" role="alert"><span>Cet appareil a été révoqué par l'administrateur : la synchronisation est refusée. Vos saisies restent enregistrées ici.</span></div>
        }
        @if (gate.visible() && !gate.online()) {
          <div class="strip" role="status"><span>Vous travaillez hors connexion : les déclarations sont enregistrées sur cet appareil et seront envoyées au retour de la connexion.</span></div>
        }
        @if (gate.updateReady()) {
          <div class="strip info" role="status"><span>Une nouvelle version de Wakara est prête.</span>
            <button type="button" class="btn btn-sm" (click)="reload()">Recharger</button></div>
        }
        <main class="content"><router-outlet /></main>
      </div>
    </div>
    @if (blocked()) {
      <wk-confirm title="Déconnexion impossible pour le moment" [confirmLabel]="blockedLabel()"
        (cancel)="blocked.set(false)" (confirm)="resolveBlocked()">
        {{ gate.unsynced() }} opération(s) enregistrée(s) sur cet appareil ne sont pas encore sur le serveur
        @if (gate.problems()) { (dont {{ gate.problems() }} à corriger) }. Se déconnecter les effacerait : synchronisez d'abord.
        Pour laisser l'appareil sans rien perdre, utilisez « Verrouiller l'appareil ».
      </wk-confirm>
    }
    @if (reauth()) { <wk-reauth (done)="reauth.set(false)" /> }`,
  styles: [`
    .shell{display:grid;grid-template-columns:var(--sidebar-w) minmax(0,1fr);min-height:100vh}
    /* header and footer stay visible; only the menu itself scrolls on short screens */
    .sidebar{background:linear-gradient(180deg,var(--wk-navy-800),var(--wk-navy-900));color:#fff;padding:20px 14px 14px;display:flex;flex-direction:column;gap:20px;position:sticky;top:0;height:100vh;height:100dvh;overflow:hidden}
    .brand{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none}
    .close{display:none;border:0;background:rgba(255,255,255,.1);color:#fff;width:36px;height:36px;border-radius:10px;font-size:24px;line-height:1;cursor:pointer}
    nav{display:flex;flex-direction:column;gap:4px;flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
    .sidebar a,.sidebar .logout{display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:12px;color:rgba(255,255,255,.82);font:inherit;font-weight:500;text-decoration:none;transition:background .15s;background:none;border:0;width:100%;text-align:left;cursor:pointer}
    .sidebar a:hover,.sidebar .logout:hover{background:rgba(255,255,255,.08);text-decoration:none}
    .sidebar a.active{background:var(--wk-royal);color:#fff;box-shadow:0 6px 16px rgba(31,94,216,.4)}
    .sidebar a:focus-visible,.sidebar .logout:focus-visible{outline:2px solid #fff;outline-offset:-2px}
    .count{margin-left:auto;background:var(--wk-danger);color:#fff;border-radius:999px;font-size:11px;font-weight:700;min-width:22px;height:22px;line-height:22px;text-align:center;padding:0 6px;box-shadow:0 0 0 2px rgba(255,255,255,.18)}
    .sidebar a.active .count{background:#fff;color:var(--wk-royal);box-shadow:none}
    .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
    .bottom{display:flex;flex-direction:column;gap:4px;border-top:1px solid rgba(255,255,255,.12);padding-top:12px;flex:none}
    .main{min-width:0;display:flex;flex-direction:column}
    .topbar{height:var(--topbar-h);background:var(--wk-surface);border-bottom:1px solid var(--wk-border);display:flex;align-items:center;gap:14px;padding:0 24px;position:sticky;top:0;z-index:100;min-width:0}
    .topbar>*{min-width:0}
    .topbar .menu,.topbar .menu-wrap{flex:none}
    .spacer{flex:1 1 0}
    .search{display:flex;align-items:center;gap:8px;background:var(--wk-bg);border:1px solid var(--wk-border);border-radius:12px;padding:0 14px;height:42px;flex:0 1 460px;min-width:0;color:var(--wk-text-mute)}
    .search input{border:0;background:none;outline:none;flex:1;font:inherit;color:var(--wk-text);min-width:0;width:100%;text-overflow:ellipsis}
    .search wk-icon{flex:none}
    .content{flex:1;min-width:0}
    .menu{display:none}
    .menu-wrap{position:relative}
    .bell{position:relative}
    .dot{position:absolute;top:2px;right:0;background:var(--wk-danger);color:#fff;border-radius:999px;font-size:10px;min-width:18px;height:18px;line-height:18px;font-weight:700;padding:0 4px}
    .account{display:flex;align-items:center;gap:10px;background:none;border:0;cursor:pointer;padding:4px 6px;border-radius:12px}
    .account:hover{background:var(--wk-bg)}
    .avatar{width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,var(--wk-sky),var(--wk-royal));color:#fff;display:grid;place-items:center;font-weight:700}
    .who{display:flex;flex-direction:column;text-align:left;line-height:1.2}
    .who strong{font-size:13px}.who small{color:var(--wk-text-mute);font-size:12px}
    .dropdown{position:absolute;right:0;top:calc(100% + 8px);min-width:250px;background:#fff;border:1px solid var(--wk-border);border-radius:14px;box-shadow:var(--shadow-lg);padding:8px;z-index:300}
    .dropdown h3{padding:8px 10px;color:var(--wk-text-soft)}
    .dropdown a,.dropdown .item{display:flex;justify-content:space-between;gap:12px;padding:9px 10px;border-radius:8px;color:var(--wk-text);text-decoration:none;background:none;border:0;width:100%;text-align:left;font:inherit;cursor:pointer}
    .dropdown a:hover,.dropdown .item:hover{background:var(--wk-sky-50)}
    .pad{padding:8px 10px}
    .backdrop{display:none}
    .strip{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:9px 24px;background:var(--wk-warning-bg);color:#7a4700;font-size:13px;border-bottom:1px solid #f3d39b}
    .strip.danger{background:var(--wk-danger-bg);color:#8f1f2b;border-bottom-color:#f3b6bd}
    .strip.info{background:var(--wk-info-bg);color:var(--wk-royal);border-bottom-color:#c6d8fb}
    @media (max-width:960px){
      .shell{grid-template-columns:minmax(0,1fr)}
      .sidebar{position:fixed;left:0;top:0;bottom:0;width:min(var(--sidebar-w),86vw);transform:translateX(-100%);visibility:hidden;transition:transform .2s,visibility 0s .2s;z-index:400}
      .nav-open .sidebar{transform:none;visibility:visible;transition:transform .2s}
      .close{display:grid;place-items:center}
      .nav-open .backdrop{display:block;position:fixed;inset:0;background:rgba(8,34,79,.45);z-index:350}
      .menu{display:inline-flex}
      .who{display:none}
      .topbar{padding:0 12px;gap:8px}
    }
    @media (max-width:420px){
      .topbar{padding:0 8px;gap:6px}
      .search{padding:0 10px;gap:6px;height:40px}
      .account{padding:2px}
      .avatar{width:34px;height:34px;font-size:13px}
    }
  `],
})
export class ShellComponent implements OnInit {
  auth = inject(AuthService);
  private api = inject(ApiService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  private refresh = inject(AutoRefreshService);
  private toast = inject(ToastService);
  gate = inject(OfflineGate);

  /** Sign-out refused: operations of this device are not on the server yet. */
  blocked = signal(false);
  reauth = signal(false);
  navOpen = signal(false);
  open = signal<'' | 'inbox' | 'account'>('');
  inbox = signal<Inbox | null>(null);
  q = '';

  items = () => NAV.filter(i => this.auth.canAny(...i.perms));
  initials = () => {
    const u = this.auth.user();
    return ((u?.first_name?.[0] ?? u?.username?.[0] ?? '?') + (u?.last_name?.[0] ?? '')).toUpperCase();
  };

  /** Number of dossiers waiting for the user behind a menu entry (0 hides the badge). */
  badge(link: string): number { return this.inbox()?.badges?.[link] ?? 0; }

  ngOnInit() {
    this.loadInbox();
    // every 30 s: menu badges (the open screen refreshes itself)
    this.refresh.on(this.destroyRef, () => this.loadInbox(true));
    this.router.events.pipe(filter(e => e instanceof NavigationEnd), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => { this.open.set(''); this.navOpen.set(false); this.loadInbox(); });
  }
  private loadInbox(announce = false) {
    if (!this.auth.can('declaration.view')) return;
    this.api.get<Inbox>('/inbox/').subscribe({
      next: i => {
        const before = this.inbox();
        if (announce && before && i.total > before.total) this.toast.info('Nouveau dossier à traiter.');
        this.inbox.set(i);
      },
      error: () => this.inbox.set(null),
    });
  }
  toggle(menu: 'inbox' | 'account') { this.open.set(this.open() === menu ? '' : menu); }
  @HostListener('document:click') closeMenus() { this.open.set(''); }
  @HostListener('document:keydown.escape') onEscape() { this.open.set(''); this.navOpen.set(false); }
  @HostListener('window:resize') onResize() { if (window.innerWidth > 960) this.navOpen.set(false); }

  logout() {
    this.open.set(''); this.navOpen.set(false);
    // refused by AuthService itself while this device holds operations the server has not confirmed
    if (!this.auth.logout()) { void this.gate.refreshCounts(); this.blocked.set(true); }
  }
  async resolveBlocked() {
    this.blocked.set(false);
    if (!this.gate.online()) { this.gate.lock(); return; }
    await this.gate.syncNow();
    if (this.gate.unsynced()) { this.toast.error(this.gate.message() || 'Des opérations restent à corriger avant de pouvoir vous déconnecter.'); void this.router.navigate(['/synchronisation']); }
    else this.toast.success('Tout est synchronisé : vous pouvez vous déconnecter.');
  }
  reload() { window.location.reload(); }
  blockedLabel() { return this.gate.online() ? 'Synchroniser maintenant' : "Verrouiller l'appareil"; }

  inboxLink(status: string): string {
    return status === 'PENDING_VALIDATION' ? '/validation' : '/declarations';
  }
  search(e: Event) {
    e.preventDefault();
    this.router.navigate(['/declarations'], { queryParams: { search: this.q.trim() || null } });
  }
}
