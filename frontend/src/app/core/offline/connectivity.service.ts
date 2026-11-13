import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { environment } from '@env/environment';

const PING_TIMEOUT_MS = 6000;
const PERIOD_ONLINE_MS = 60_000;
const PERIOD_OFFLINE_MS = 20_000;

/**
 * Is the SERVER reachable? `navigator.onLine` only says a network interface exists (a phone with a signal
 * but no data still reports true), so the answer comes from a real request to a tiny public endpoint.
 * The same answer carries the remote switch of the offline mode.
 */
@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
  /** `offline.enabled` setting of the server: false turns the offline mode off on every device. */
  readonly offlineEnabled = signal(true);
  /** Emits when the server becomes reachable or unreachable. */
  readonly changes = new Subject<boolean>();

  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<boolean> | null = null;

  /** Starts watching (idempotent). Nothing is pinged for users who do not use the offline mode. */
  start() {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    window.addEventListener('online', () => void this.check());
    window.addEventListener('offline', () => this.set(false));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void this.check(); });
    void this.check();
  }

  private schedule() {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (document.hidden) this.schedule(); else void this.check(); }, this.online() ? PERIOD_ONLINE_MS : PERIOD_OFFLINE_MS);
  }

  private set(value: boolean) {
    if (this.online() === value) return;
    this.online.set(value);
    this.changes.next(value);
  }

  /** A request just failed without any answer: believe it, then confirm shortly. */
  reportFailure() {
    this.set(false);
    if (this.started) { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => void this.check(), 4000); }
  }

  check(): Promise<boolean> {
    this.inFlight ??= this.ping().finally(() => { this.inFlight = null; this.schedule(); });
    return this.inFlight;
  }

  private async ping(): Promise<boolean> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { this.set(false); return false; }
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), PING_TIMEOUT_MS);
    try {
      const response = await fetch(`${environment.apiUrl}/sync/ping/`, { cache: 'no-store', signal: abort.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json();
      if (typeof body?.offline_enabled === 'boolean') this.offlineEnabled.set(body.offline_enabled);
      this.set(true);
      return true;
    } catch {
      this.set(false);
      return false;
    } finally { clearTimeout(timeout); }
  }
}
