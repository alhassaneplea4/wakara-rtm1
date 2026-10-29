import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { errorMessage, fieldErrors } from './api.service';
import { AuthService } from './auth.service';
import { authGuard, permissionGuard } from './guards';
import { Me, STATUS_LABELS, STATUS_TONE } from './models';

const me = (over: Partial<Me> = {}): Me => ({
  uuid: 'u', username: 'agent', email: '', first_name: 'A', last_name: 'B', phone: '', address: '', hospital: null,
  roles: [], permissions: ['declaration.view'], must_change_password: false, date_joined: '', last_login: null, ...over,
});

describe('API error helpers', () => {
  it('prefers the server detail', () => {
    expect(errorMessage({ error: { detail: 'Refusé' } })).toBe('Refusé');
  });
  it('reports an unreachable server', () => {
    expect(errorMessage({ status: 0 })).toContain('injoignable');
  });
  it('flattens nested field errors', () => {
    expect(fieldErrors({ error: { birth_date: ['Requis.'], child: { gender: ['Invalide.'] } } }))
      .toEqual({ birth_date: 'Requis.', 'child.gender': 'Invalide.' });
  });
});

describe('Status presentation', () => {
  it('has a label and a tone for every status', () => {
    for (const s of Object.keys(STATUS_LABELS)) expect((STATUS_TONE as Record<string, string>)[s]).toBeTruthy();
  });
});

describe('Guards', () => {
  let auth: AuthService;
  const state = (url: string) => ({ url }) as RouterStateSnapshot;
  const route = (perms: string[]) => ({ data: { perms } }) as unknown as ActivatedRouteSnapshot;

  beforeEach(() => {
    sessionStorage.clear(); localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    auth = TestBed.inject(AuthService);
  });

  it('redirects anonymous users to the login page', () => {
    const r = TestBed.runInInjectionContext(() => authGuard({} as ActivatedRouteSnapshot, state('/dashboard')));
    expect(r instanceof UrlTree).toBeTrue();
    expect(TestBed.inject(Router).serializeUrl(r as UrlTree)).toContain('/login');
  });

  it('forces the password change when flagged', () => {
    sessionStorage.setItem('wk_access_token', 'x');
    auth.user.set(me({ must_change_password: true }));
    const r = TestBed.runInInjectionContext(() => authGuard({} as ActivatedRouteSnapshot, state('/declarations')));
    expect(TestBed.inject(Router).serializeUrl(r as UrlTree)).toContain('/profile');
  });

  it('allows a user holding one of the required permissions, refuses otherwise', () => {
    auth.user.set(me());
    expect(TestBed.runInInjectionContext(() => permissionGuard(route(['declaration.view']), state('/x')))).toBeTrue();
    const denied = TestBed.runInInjectionContext(() => permissionGuard(route(['user.view']), state('/users')));
    expect(TestBed.inject(Router).serializeUrl(denied as UrlTree)).toBe('/forbidden');
  });
});

describe('AuthService logout / expiry', () => {
  let auth: AuthService;
  let router: Router;

  beforeEach(() => {
    sessionStorage.clear(); localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    auth = TestBed.inject(AuthService);
    router = TestBed.inject(Router);
    sessionStorage.setItem('wk_access_token', 'a');
    sessionStorage.setItem('wk_refresh_token', 'r');
    auth.user.set(me());
  });

  it('clears the session and goes to the login page', () => {
    const nav = spyOn(router, 'navigate').and.returnValue(Promise.resolve(true));
    auth.logout();
    expect(auth.user()).toBeNull();
    expect(sessionStorage.getItem('wk_access_token')).toBeNull();
    expect(nav).toHaveBeenCalledWith(['/login'], jasmine.objectContaining({ replaceUrl: true }));
  });

  it('does not report "session expired" for late 401s after a manual logout', () => {
    const nav = spyOn(router, 'navigate').and.returnValue(Promise.resolve(true));
    auth.logout();
    nav.calls.reset();
    auth.expire();
    expect(nav).not.toHaveBeenCalled();
  });

  it('expire() redirects with the expired flag', () => {
    const nav = spyOn(router, 'navigate').and.returnValue(Promise.resolve(true));
    auth.expire();
    expect(nav).toHaveBeenCalledWith(['/login'], jasmine.objectContaining({ queryParams: { expired: 1 } }));
  });
});
