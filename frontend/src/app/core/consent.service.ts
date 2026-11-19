import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { environment } from '@env/environment';
import { filter } from 'rxjs';
import { SKIP_AUTH } from './auth.service';

const KEY = 'wk_consent';
const MONTH_MS = 30 * 86_400_000;
/** Pages whose visits may be counted (must match core.views.PUBLIC_PAGES): the pages of the application never are. */
export const PUBLIC_PAGES = ['/login', '/confidentialite', '/conditions', '/mentions-legales', '/cookies'];

export type Choice = 'unset' | 'accepted' | 'refused';

/**
 * Cookie / local-storage banner and the optional audience measurement.
 *
 * Wakara sets no advertising or tracking cookie. What it keeps on the device (session, offline mode, device identifier)
 * is strictly necessary and needs no consent; the banner informs about it. The only optional thing is a first-party,
 * cookieless counter of visits to the PUBLIC pages: it runs only after the visitor accepts, never on the pages of the
 * application, and never when the browser says « Do Not Track » / « Global Privacy Control ».
 * The answer is remembered for 12 months.
 */
@Injectable({ providedIn: 'root' })
export class ConsentService {
  private http = inject(HttpClient);
  private router = inject(Router);

  readonly choice = signal<Choice>(this.read());
  readonly audience = computed(() => this.choice() === 'accepted');
  /** The banner is shown until the visitor answers. */
  readonly bannerVisible = computed(() => this.choice() === 'unset');

  constructor() {
    this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd)).subscribe(e => this.hit(e.urlAfterRedirects));
  }

  accept() { this.save('accepted'); this.hit(this.router.url); }
  refuse() { this.save('refused'); }

  private read(): Choice {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { v: Choice; at: number } | null;
      if (raw && (raw.v === 'accepted' || raw.v === 'refused') && Date.now() - raw.at < 12 * MONTH_MS) return raw.v;
    } catch { /* storage unavailable or damaged: ask again */ }
    return 'unset';
  }

  private save(v: Choice) {
    this.choice.set(v);
    try { localStorage.setItem(KEY, JSON.stringify({ v, at: Date.now() })); } catch { /* the choice lasts for this visit only */ }
  }

  private hit(url: string) {
    const path = url.split(/[?#]/)[0];
    if (!this.audience() || !PUBLIC_PAGES.includes(path)) return;
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (nav.doNotTrack === '1' || nav.globalPrivacyControl) return;
    this.http.post(`${environment.apiUrl}/public/hit/`, { path }, { context: new HttpContext().set(SKIP_AUTH, true) }).subscribe({ error: () => undefined });
  }
}
