import { HttpClient, HttpEvent, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { Injectable, Injector, computed, effect, inject, signal } from '@angular/core';
import { NavigationStart, Router, UrlTree } from '@angular/router';
import { Observable, firstValueFrom } from 'rxjs';
import { environment } from '@env/environment';
import { AuthService } from '../auth.service';
import { ConnectivityService } from './connectivity.service';
import type { OfflineEngine } from './engine';
import { SKIP_KEY, VaultHeader, deviceId, offlineSupported, readVaultHeader } from './vault-header';

/** Inactivity after which the device locks itself (the PIN is asked again; nothing is lost). */
export const AUTO_LOCK_MS = 15 * 60_000;
/** After locking, the device keeps sending what waits (up to this long) before it forgets the key. */
export const DRAIN_MS = 10 * 60_000;
/** An unsent operation older than this is reported to the user (they may be leaving the covered area). */
export const STALE_QUEUE_MS = 24 * 3_600_000;

export type ConnectionStatus = 'offline' | 'expired' | 'syncing' | 'attention' | 'pending' | 'online';

/**
 * Front door of the offline mode, always loaded (small): who may work offline, is the device unlocked, how
 * many operations wait, is the server reachable. The heavy part (encrypted storage, queue, synchronisation)
 * is the engine, loaded on demand once the agent sets up or unlocks the device.
 */
@Injectable({ providedIn: 'root' })
export class OfflineGate {
  private auth = inject(AuthService);
  private conn = inject(ConnectivityService);
  private injector = inject(Injector);
  private router = inject(Router);

  private engine: OfflineEngine | null = null;
  private modulePromise: Promise<typeof import('./engine')> | null = null;
  private lastActivity = Date.now();
  private watching = false;

  readonly header = signal<VaultHeader | null>(readVaultHeader());
  readonly unlocked = signal(false);
  /** Operations waiting to be sent / refused by the server and waiting for the agent. */
  readonly waiting = signal(0);
  readonly problems = signal(0);
  readonly syncing = signal(false);
  readonly lastSync = signal<string | null>(null);
  readonly message = signal('');
  readonly revoked = signal(false);
  /** The account already has its maximum number of offline devices: this one is refused by the server. */
  readonly limited = signal(false);
  /** The rights were withdrawn: the copies of the dossiers were erased from this device (unsent work kept). */
  readonly accessLost = signal(false);
  /** When the oldest operation not confirmed by the server was made. */
  readonly oldestUnsynced = signal<string | null>(null);
  /** Did the browser agree to keep the data of this device? null = unknown. */
  readonly persisted = signal<boolean | null>(null);
  private draining = false;
  /** Date of the copy kept on this device that the page on screen was built from (null: the page comes from the server). */
  readonly cachedAt = signal<string | null>(null);
  private now = signal(Date.now());
  /** Incremented whenever what the screens show may have changed on the device. */
  readonly revision = signal(0);
  readonly skipped = signal(readFlag(SKIP_KEY));
  readonly updateReady = signal(false);

  readonly online = this.conn.online;
  readonly enabled = this.conn.offlineEnabled;
  readonly supported = offlineSupported();
  readonly unsynced = computed(() => this.waiting() + this.problems());
  /** Work that has been waiting on this device for more than 24 hours. */
  readonly staleQueue = computed(() => {
    const oldest = this.oldestUnsynced();
    return this.unsynced() > 0 && !!oldest && this.now() - Date.parse(oldest) > STALE_QUEUE_MS;
  });
  /** The browser may erase this device's data without warning: refused persistence, or an iPhone outside the installed app. */
  readonly storageAtRisk = computed(() => this.persisted() === false || (isIos() && !isInstalled()));
  /**
   * Every account that works on the dossiers can protect a device and work offline: the collection agent, the
   * secretariat, the validators, the administrator. (Managing users, roles and settings still needs the server.)
   */
  readonly eligible = computed(() => this.auth.can('declaration.view'));
  /** A collection agent: creates and transmits declarations, does not work on the actes. His device comes first. */
  readonly collectionProfile = computed(() =>
    this.auth.can('declaration.create') && this.auth.can('declaration.transmit') && !this.auth.can('acte.update'));
  /** The device belongs to the signed-in user and is unlocked: calls are answered offline-first. */
  readonly active = computed(() => this.unlocked() && !!this.header() && this.header()!.user.uuid === this.auth.user()?.uuid);
  /** The connection pill of the top bar is shown to whoever uses the offline mode on this device. */
  readonly visible = computed(() => this.active());
  readonly status = computed<ConnectionStatus>(() => {
    if (!this.online()) return 'offline';
    if (this.auth.sessionExpired()) return 'expired';
    if (this.syncing()) return 'syncing';
    if (this.problems()) return 'attention';
    return this.waiting() ? 'pending' : 'online';
  });

  constructor() {
    // Session rules of the offline mode, enforced by AuthService itself (whoever calls it).
    // Signing out never loses anything: the vault, the local data and the waiting operations stay on the device
    // (encrypted) until the same agent signs in again, unlocks with the code chosen once, and synchronises.
    this.router.events.subscribe(e => { if (e instanceof NavigationStart) this.cachedAt.set(null); });   // the date belongs to the page on screen
    this.auth.holdOnExpire = () => this.active();
    this.auth.onLoggedOut = uuid => { if (uuid && this.header()?.user.uuid === uuid) void this.keepForNextSignIn(); };
    this.auth.tokens$.subscribe(() => void this.engine?.saveSession());
    this.conn.changes.subscribe(up => { if (up) this.engine?.sync.kick(800); });
    effect(() => { if (!this.auth.sessionExpired() && this.unlocked()) this.engine?.sync.kick(500); });
    effect(() => { if (!this.enabled()) void removeServiceWorker(); });
    if (this.header()) { this.conn.start(); void this.refreshCounts(); }
  }

  private ownsDevice() { const h = this.header(); return !!h && h.user.uuid === this.auth.user()?.uuid; }
  private module() { return (this.modulePromise ??= import('./engine')); }

  /* ── engine host ── */
  private host = {
    counts: (waiting: number, problems: number, oldest: string | null) => {
      this.waiting.set(waiting); this.problems.set(problems); this.oldestUnsynced.set(oldest); this.now.set(Date.now());
    },
    accessLost: (message: string) => { this.accessLost.set(true); this.message.set(message); },
    persisted: (value: boolean | null) => this.persisted.set(value),
    cachedPage: (at: string | null) => this.cachedAt.set(at),
    syncing: (v: boolean) => this.syncing.set(v),
    synced: (at: string | null) => { this.lastSync.set(at); if (at) { this.message.set(''); this.revoked.set(false); this.limited.set(false); this.accessLost.set(false); } },
    failed: (m: string) => this.message.set(m),
    deviceRevoked: () => this.revoked.set(true),
    deviceLimit: () => this.limited.set(true),
    collectionProfile: () => this.collectionProfile(),
    bump: () => this.revision.update(n => n + 1),
  };

  /** Number of unconfirmed operations of the vault owner, readable while the device is locked. */
  async refreshCounts(): Promise<number> {
    const h = this.header();
    if (!h) { this.waiting.set(0); this.problems.set(0); this.oldestUnsynced.set(null); return 0; }
    if (this.engine) { await this.engine.refresh(); return this.unsynced(); }
    try {
      const { waiting, problems, oldest } = await (await this.module()).storage.countUnsynced(h.user.uuid);
      this.waiting.set(waiting); this.problems.set(problems); this.oldestUnsynced.set(oldest); this.now.set(Date.now());
    } catch { /* database not created yet */ }
    return this.unsynced();
  }

  /* ── set-up, unlock, lock ── */

  async pinProblem(pin: string): Promise<string> { return (await this.module()).vault.pinProblem(pin); }

  /** New code for the same data (the old one is checked first and counts as an attempt). */
  async changePin(oldPin: string, newPin: string) { await (await this.module()).vault.changePin(oldPin, newPin); this.header.set(readVaultHeader()); }

  /** First use on this device: the signed-in agent chooses the PIN that will protect the offline data. */
  async setup(pin: string) {
    const me = this.auth.user();
    if (!me) throw new Error('Connexion requise.');
    const m = await this.module();
    const key = await m.vault.create(pin, { uuid: me.uuid, username: me.username, name: this.auth.fullName() });
    this.header.set(readVaultHeader());
    await this.openEngine(key);
    await this.engine!.saveSession();
    this.engine!.sync.kick(0);
  }

  /** Opens the device with the PIN. Throws PinError (message ready to display) when the code is wrong. */
  async unlock(pin: string) {
    const m = await this.module();
    let key: CryptoKey;
    try { key = await m.vault.open(pin); } finally { this.header.set(readVaultHeader()); }
    const header = this.header()!;
    await this.openEngine(key);
    const live = this.auth.user();
    if (live && this.auth.isAuthenticated && live.uuid === header.user.uuid) {
      await this.engine!.saveSession();            // just signed in online: the vault takes the fresh session
    } else {
      const session = await this.engine!.loadSession();
      if (!session) {
        // signed out: the data stay on the device but need a new sign-in with the password first
        this.engine?.close(); this.engine = null; this.unlocked.set(false);
        throw new Error('Session terminée : connectez-vous avec votre mot de passe, puis saisissez votre code. Vos déclarations non synchronisées sont conservées sur cet appareil.');
      }
      this.auth.adoptOfflineSession(session.me, session.access, session.refresh);
      // confirm with the server when it is reachable; without network the device keeps working on its own
      this.auth.reloadUser().subscribe({ next: () => void this.engine?.saveSession(), error: () => undefined });
    }
    this.engine!.sync.kick(0);
  }

  private async openEngine(key: CryptoKey) {
    const m = await this.module();
    const header = this.header()!;
    this.draining = false;   // a device unlocked again takes over from the one finishing its last sends
    this.engine?.close();
    const engine = new m.OfflineEngine({
      http: this.injector.get(HttpClient), conn: this.conn, auth: this.auth, host: this.host,
      apiUrl: environment.apiUrl, deviceId: deviceId(), deviceLabel: deviceLabel(),
    }, key, header.user.uuid);
    await engine.start();
    this.engine = engine;
    this.unlocked.set(true);
    this.conn.start();
    this.watchActivity();
  }

  /** Forgets the key (and the tokens) in memory; the data and the queue stay on the device, encrypted. */
  lock(redirect = true) {
    const engine = this.engine;
    this.unlocked.set(false);            // the screens are protected at once
    if (redirect) void this.router.navigate(['/verrouillage']);
    if (engine && this.waiting() > 0 && this.online() && !this.auth.sessionExpired()) {
      // what is ready to leave is sent first: the key and the session are forgotten when the queue is empty,
      // or after DRAIN_MS at the latest. Nothing can be opened meanwhile (the guard sends back to the PIN screen).
      this.draining = true;
      const finish = () => {
        clearTimeout(limit); clearInterval(watch);
        if (!this.draining || this.engine !== engine) return;   // unlocked again meanwhile
        this.draining = false;
        engine.close(); this.engine = null; this.auth.clearForLock();
      };
      const limit = setTimeout(finish, DRAIN_MS);
      const watch = setInterval(() => { if (this.waiting() === 0 && !this.syncing()) finish(); }, 2000);
      engine.sync.kick(0);
      return;
    }
    engine?.close();
    this.engine = null;
    this.auth.clearForLock();
  }

  /**
   * Sign-out of the owner of the device: the encrypted data, the queue and the code (vault) are KEPT; only the
   * saved session is removed, so the local data cannot be opened again without signing in with the password
   * and typing the code. The next sign-in of the same agent unlocks the device (no new code) and resumes the queue.
   */
  private async keepForNextSignIn() {
    this.engine?.close();
    this.engine = null;
    this.unlocked.set(false);
    try { (await this.module()).vault.clearSession(); } catch { /* nothing saved */ }
    void this.refreshCounts();
  }

  /** Removes everything the offline mode stored for the owner of this device. */
  async destroy() {
    const h = this.header();
    this.engine?.close();
    this.engine = null;
    this.unlocked.set(false);
    try {
      const m = await this.module();
      if (h) await m.storage.deleteDb(h.user.uuid);
      m.vault.destroy();
    } catch { /* ignore */ }
    this.header.set(readVaultHeader());
    this.waiting.set(0); this.problems.set(0); this.oldestUnsynced.set(null); this.lastSync.set(null); this.message.set(''); this.revoked.set(false); this.limited.set(false); this.accessLost.set(false);
  }

  skip() { writeFlag(SKIP_KEY); this.skipped.set(true); }

  /**
   * Called before any screen of the application opens. Sends the user to the PIN screen when the device must
   * be set up or unlocked, and refuses another account on a device that still holds unsent operations.
   */
  async checkAccess(url: string): Promise<true | UrlTree> {
    const user = this.auth.user();
    if (!user || user.must_change_password) return true;
    let h = this.header();
    if (h && h.user.uuid !== user.uuid) {
      if ((await this.refreshCounts()) > 0) {
        this.auth.logout(false);  // the waiting operations belong to someone else: refused, nothing is touched
        return this.router.createUrlTree(['/login'], { queryParams: { blocked: 1 } });
      }
      await this.destroy();
      h = null;
    }
    if (h) return this.unlocked() ? true : this.router.createUrlTree(['/verrouillage'], { queryParams: { next: url } });
    if (this.eligible() && this.enabled() && this.supported && !this.skipped()) {
      return this.router.createUrlTree(['/verrouillage'], { queryParams: { mode: 'setup', next: url } });
    }
    return true;
  }

  /* ── what the screens use ── */

  handle(req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> { return this.engine!.handle(req, next); }
  current(): OfflineEngine | null { return this.engine; }

  async syncNow() { this.message.set(''); await this.engine?.sync.run(true); }

  /** Draft of a form being filled (encrypted on the device); nothing is kept when the device is not unlocked. */
  async draftSave(key: string, data: unknown): Promise<void> { if (this.active()) await this.engine?.saveDraft(key, data); }
  async draftLoad<T>(key: string): Promise<{ at: string; data: T } | null> { return this.active() && this.engine ? this.engine.loadDraft<T>(key) : null; }
  async draftClear(key: string): Promise<void> { if (this.engine) await this.engine.clearDraft(key); }

  /** The unsent work as a file to keep elsewhere (the device must be unlocked). */
  async exportBackup(): Promise<{ blob: Blob; name: string }> {
    if (!this.engine) throw new Error("Déverrouillez l'appareil pour créer une sauvegarde.");
    const m = await this.module();
    return { blob: await this.engine.exportBackup(), name: m.backupFileName() };
  }

  /** Puts a backup file back on a device whose data were erased; the owner then signs in and unlocks with the original code. */
  async restoreBackup(text: string) {
    await (await this.module()).backup.restore(text);
    this.header.set(readVaultHeader());
    await this.refreshCounts();
  }

  /** New sign-in of the SAME agent after the session expired; the queue then resumes. */
  async reauthenticate(password: string) {
    const h = this.header();
    if (!h) throw new Error('Aucune session protégée sur cet appareil.');
    const me = await firstValueFrom(this.auth.login(h.user.username, password, false));
    if (me.uuid !== h.user.uuid) { this.auth.clearForLock(); throw new Error("Ce compte n'est pas celui de cet appareil."); }
    await this.engine?.saveSession();
    this.engine?.sync.kick(0);
  }

  private watchActivity() {
    this.lastActivity = Date.now();
    if (this.watching || typeof window === 'undefined') return;
    this.watching = true;
    const touch = () => { this.lastActivity = Date.now(); };
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, touch, { passive: true });
    setInterval(() => {
      this.now.set(Date.now());
      if (this.unlocked() && Date.now() - this.lastActivity > AUTO_LOCK_MS) this.lock();
    }, 30_000);
  }
}

function isIos(): boolean { return typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent); }
/** The application runs from the home screen (installed), not in a browser tab. */
function isInstalled(): boolean {
  try { return (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches) || (navigator as any).standalone === true; }
  catch { return false; }
}

function readFlag(key: string): boolean { try { return sessionStorage.getItem(key) === '1'; } catch { return false; } }
function writeFlag(key: string) { try { sessionStorage.setItem(key, '1'); } catch { /* ignore */ } }

/** « Chrome · Android » — enough for an administrator to recognise the device in the list. */
export function deviceLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
  const system = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Appareil';
  return `${browser} · ${system}`;
}

/** Remote switch: the service worker is unregistered and its caches removed; the application goes back to plain online use. */
async function removeServiceWorker() {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
    if (typeof caches !== 'undefined') for (const name of await caches.keys()) if (name.startsWith('ngsw:')) await caches.delete(name);
  } catch { /* nothing to remove */ }
}
