import { HttpClient, HttpContext, HttpContextToken } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, Subject, catchError, finalize, map, of, shareReplay, tap, throwError } from 'rxjs';
import { environment } from '@env/environment';
import { Me } from './models';
import { readVaultHeader } from './offline/vault-header';

/** Requests flagged with this context skip the bearer/refresh/redirect logic of the interceptor. */
export const SKIP_AUTH = new HttpContextToken<boolean>(() => false);

/**
 * Session handling. Tokens live in sessionStorage by default (cleared with the tab);
 * "Se souvenir de moi" keeps them in localStorage — the server still limits the refresh
 * token lifetime and blacklists it at logout.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private readonly api = environment.apiUrl;

  readonly user = signal<Me | null>(null);
  readonly permissions = computed(() => new Set(this.user()?.permissions ?? []));
  readonly fullName = computed(() => {
    const u = this.user();
    return u ? (`${u.first_name} ${u.last_name}`.trim() || u.username) : '';
  });
  readonly roleLabel = computed(() => this.user()?.roles.map(r => r.name).join(', ') || 'Sans rôle');
  private refreshing$: Observable<string> | null = null;

  // ── Offline mode (collection agents). The rules are set by OfflineGate; without it nothing changes. ──
  /** The server no longer accepts the session, but the device is unlocked: work goes on locally until the agent signs in again. */
  readonly sessionExpired = signal(false);
  /** The profile comes from the device vault and has not been confirmed by the server since the page was opened. */
  readonly offlineSession = signal(false);
  /** True while operations of this user are still waiting on the device: signing out is refused. */
  logoutBlocked: () => boolean = () => false;
  /** True when an expired session must not close the screens (device unlocked, local work possible). */
  holdOnExpire: () => boolean = () => false;
  /** Called after a real sign-out, with the identifier of the user who left. */
  onLoggedOut: (uuid: string | null) => void = () => undefined;
  /** Emits whenever the stored tokens change (the vault keeps its encrypted copy up to date). */
  readonly tokens$ = new Subject<void>();

  // ── token storage ──
  private store(): Storage { return this.read(localStorage, environment.refreshTokenKey) ? localStorage : sessionStorage; }
  private read(s: Storage, key: string): string | null { try { return s.getItem(key); } catch { return null; } }
  get accessToken(): string | null { return this.read(sessionStorage, environment.tokenKey) ?? this.read(localStorage, environment.tokenKey); }
  get refreshToken(): string | null { return this.read(sessionStorage, environment.refreshTokenKey) ?? this.read(localStorage, environment.refreshTokenKey); }
  private save(access: string, refresh: string | null, remember: boolean) {
    this.clearTokens();
    const s = remember ? localStorage : sessionStorage;
    try {
      s.setItem(environment.tokenKey, access);
      if (refresh) s.setItem(environment.refreshTokenKey, refresh);
    } catch { /* storage unavailable: session lives in memory only */ }
    this.tokens$.next();
  }
  private clearTokens() {
    for (const s of [sessionStorage, localStorage]) {
      try { s.removeItem(environment.tokenKey); s.removeItem(environment.refreshTokenKey); } catch { /* ignore */ }
    }
  }

  get isAuthenticated(): boolean { return !!this.accessToken; }
  /** A user is at work: with a live session, or on an unlocked device whose session waits for the network / a new sign-in. */
  get hasSession(): boolean { return !!this.user() && (this.isAuthenticated || this.offlineSession()); }
  can(code: string): boolean { return this.permissions().has(code); }
  canAny(...codes: string[]): boolean { return codes.some(c => this.can(c)); }

  login(username: string, password: string, remember: boolean): Observable<Me> {
    return this.http.post<{ access: string; refresh: string; user: Me }>(`${this.api}/auth/login/`, { username, password }).pipe(
      tap(r => {
        this.signedOut = false; this.sessionExpired.set(false); this.offlineSession.set(false);
        this.user.set(r.user); this.save(r.access, r.refresh, remember);
      }),
      map(r => r.user),
    );
  }

  /** Loads the profile of an existing session (page reload). */
  restore(): Observable<Me | null> {
    // A device protected by a PIN: the session comes back through the unlock screen, never silently.
    if (readVaultHeader()) return of(null);
    if (!this.isAuthenticated) return of(null);
    return this.http.get<Me>(`${this.api}/auth/me/`).pipe(
      tap(u => this.user.set(u)),
      catchError(() => { this.clearTokens(); this.user.set(null); return of(null); }),
    );
  }

  /** Replaces the stored token pair (the server revokes the old one after a password change), keeping the "remember me" choice. */
  adoptTokens(access: string, refresh: string) {
    this.save(access, refresh, !!this.read(localStorage, environment.refreshTokenKey));
  }

  reloadUser(): Observable<Me> {
    return this.http.get<Me>(`${this.api}/auth/me/`).pipe(tap(u => { this.user.set(u); this.offlineSession.set(false); }));
  }

  /** Session read from the device vault after the PIN (possibly without network: the server confirms it later). */
  adoptOfflineSession(me: Me, access: string | null, refresh: string | null) {
    this.signedOut = false;
    this.user.set(me);
    this.offlineSession.set(true);
    this.sessionExpired.set(!access);
    if (access) this.save(access, refresh, false); else this.clearTokens();
  }

  /** The device is being locked: nothing stays in memory or in the tab; the vault keeps the encrypted session. */
  clearForLock() {
    this.clearTokens();
    this.user.set(null);
    this.offlineSession.set(false);
    this.sessionExpired.set(false);
  }

  /** Single in-flight refresh shared by concurrent 401s. */
  refresh(): Observable<string> {
    const token = this.refreshToken;
    if (!token) return throwError(() => new Error('no refresh token'));
    if (!this.refreshing$) {
      const remember = !!this.read(localStorage, environment.refreshTokenKey);
      this.refreshing$ = this.http.post<{ access: string; refresh?: string }>(`${this.api}/auth/refresh/`, { refresh: token }).pipe(
        tap(r => this.save(r.access, r.refresh ?? token, remember)),
        map(r => r.access),
        finalize(() => (this.refreshing$ = null)),
        shareReplay(1),
      );
    }
    return this.refreshing$;
  }

  /** True between a manual logout and the next login: late 401s must not show "session expired". */
  private signedOut = false;

  /**
   * Ends the session. The local state is cleared FIRST and the redirect never depends on the
   * network or on a lazy-loaded chunk: if the router cannot navigate, the page is reloaded.
   */
  logout(redirect = true): boolean {
    if (this.logoutBlocked()) return false;
    const uuid = this.user()?.uuid ?? null;
    const refresh = this.refreshToken;
    const access = this.accessToken;
    this.signedOut = true;
    this.clearTokens();
    this.user.set(null);
    this.offlineSession.set(false); this.sessionExpired.set(false);
    if (refresh && access) {
      // Best effort: blacklist the refresh token server-side (token sent explicitly, no redirect on failure).
      this.http.post(`${this.api}/auth/logout/`, { refresh }, {
        headers: { Authorization: `Bearer ${access}` }, context: new HttpContext().set(SKIP_AUTH, true),
      }).pipe(catchError(() => of(null))).subscribe();
    }
    this.onLoggedOut(uuid);
    if (redirect) this.goToLogin();
    return true;
  }

  /** Session is gone server-side (expired / deactivated): no network call. */
  expire() {
    if (this.signedOut) return;
    if (this.holdOnExpire()) {
      // Unlocked device: never throw the agent out of a form. The queue waits, the screens keep working locally.
      this.clearTokens();
      this.offlineSession.set(true);
      this.sessionExpired.set(true);
      return;
    }
    this.clearTokens();
    this.user.set(null);
    this.goToLogin({ expired: 1 });
  }

  private goToLogin(queryParams?: Record<string, unknown>) {
    const hardRedirect = () => window.location.assign('/login' + (queryParams ? '?expired=1' : ''));
    this.router.navigate(['/login'], { queryParams, replaceUrl: true }).then(ok => { if (!ok) hardRedirect(); }, hardRedirect);
  }
}
