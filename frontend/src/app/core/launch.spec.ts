import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthService } from './auth.service';
import { ConsentService, PUBLIC_PAGES } from './consent.service';
import { IDLE_LIMIT_MS, IdleService } from './idle.service';
import { OfflineGate } from './offline/offline-gate.service';

const setup = () => {
  localStorage.clear(); sessionStorage.clear();
  TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
  return { http: TestBed.inject(HttpTestingController) };
};

describe('Cookie banner and audience measurement', () => {
  it('asks until the visitor answers, then remembers the answer', () => {
    setup();
    const c = TestBed.inject(ConsentService);
    expect(c.bannerVisible()).toBeTrue();
    expect(c.audience()).toBeFalse();
    c.refuse();
    expect(c.bannerVisible()).toBeFalse();
    expect(JSON.parse(localStorage.getItem('wk_consent')!).v).toBe('refused');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    expect(TestBed.inject(ConsentService).choice()).toBe('refused');       // survives a reload
  });

  it('asks again after 12 months', () => {
    setup();
    localStorage.setItem('wk_consent', JSON.stringify({ v: 'accepted', at: Date.now() - 13 * 30 * 86_400_000 }));
    expect(TestBed.inject(ConsentService).choice()).toBe('unset');
  });

  it('ignores a damaged or forged answer', () => {
    setup();
    localStorage.setItem('wk_consent', '{"v":"yes please","at":1}');
    expect(TestBed.inject(ConsentService).choice()).toBe('unset');
    TestBed.resetTestingModule();
    setup();
    localStorage.setItem('wk_consent', 'not json');
    expect(TestBed.inject(ConsentService).choice()).toBe('unset');
  });

  it('sends nothing before the visitor accepts', async () => {
    const { http } = setup();
    const c = TestBed.inject(ConsentService);
    (c as any).hit('/login');
    http.expectNone(r => r.url.endsWith('/public/hit/'));
    c.refuse();
    (c as any).hit('/login');
    http.expectNone(r => r.url.endsWith('/public/hit/'));
  });

  it('counts only the public pages, never the pages of the application', () => {
    const { http } = setup();
    const c = TestBed.inject(ConsentService);
    c.accept();
    http.match(() => true).forEach(r => r.flush(null, { status: 204, statusText: 'No Content' }));
    for (const private_ of ['/declarations/6f1c0f0e-5b7b-4a53-9d39-3a8f1c2d4e5f', '/users', '/dashboard', '/profile']) (c as any).hit(private_);
    http.expectNone(r => r.url.endsWith('/public/hit/'));
    (c as any).hit('/confidentialite?x=1#top');
    const req = http.expectOne(r => r.url.endsWith('/public/hit/'));
    expect(req.request.body).toEqual({ path: '/confidentialite' });          // the query string never leaves
    req.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('respects Do Not Track', () => {
    const { http } = setup();
    const c = TestBed.inject(ConsentService);
    c.accept();
    http.match(() => true);
    spyOnProperty(navigator, 'doNotTrack', 'get').and.returnValue('1');
    (c as any).hit('/login');
    http.expectNone(r => r.url.endsWith('/public/hit/'));
  });

  it('lists exactly the public pages the server counts', () => {
    expect(PUBLIC_PAGES).toEqual(['/login', '/confidentialite', '/conditions', '/mentions-legales', '/cookies']);
  });
});

describe('Inactivity timeout', () => {
  it('ends an online session left alone for more than 30 minutes, not before', () => {
    setup();
    const auth = TestBed.inject(AuthService);
    sessionStorage.setItem('wk_access_token', 'a');
    auth.user.set({ uuid: 'u', username: 'x' } as any);
    spyOn(auth, 'expire');
    const idle = TestBed.inject(IdleService);
    const t0 = Date.now();
    idle.check(t0);                                                  // activity is registered now
    idle.check(t0 + IDLE_LIMIT_MS - 1000);
    expect(auth.expire).not.toHaveBeenCalled();
    idle.check(t0 + IDLE_LIMIT_MS + 1000);
    expect(auth.expire).toHaveBeenCalledTimes(1);
  });

  it('leaves an unlocked offline device alone (it locks itself and keeps its work)', () => {
    setup();
    const auth = TestBed.inject(AuthService);
    sessionStorage.setItem('wk_access_token', 'a');
    auth.user.set({ uuid: 'u', username: 'x' } as any);
    spyOn(auth, 'expire');
    spyOn(TestBed.inject(OfflineGate), 'active').and.returnValue(true);
    TestBed.inject(IdleService).check(Date.now() + 5 * IDLE_LIMIT_MS);
    expect(auth.expire).not.toHaveBeenCalled();
  });

  it('does nothing when nobody is signed in', () => {
    setup();
    const auth = TestBed.inject(AuthService);
    spyOn(auth, 'expire');
    TestBed.inject(IdleService).check(Date.now() + 5 * IDLE_LIMIT_MS);
    expect(auth.expire).not.toHaveBeenCalled();
  });
});
