import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { OfflineGate } from './offline/offline-gate.service';

/** A session left without any activity for this long ends (the device of the offline mode locks itself after 15 minutes). */
export const IDLE_LIMIT_MS = 30 * 60_000;

/**
 * Inactivity timeout for people who work online: a screen left open on a shared or stolen computer does not stay
 * signed in. Not applied on an unlocked offline device: it locks itself (OfflineGate) and keeps its work.
 */
@Injectable({ providedIn: 'root' })
export class IdleService {
  private auth = inject(AuthService);
  private gate = inject(OfflineGate);
  private last = Date.now();
  private started = false;

  start() {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    const touch = () => { this.last = Date.now(); };
    for (const ev of ['pointerdown', 'keydown', 'touchstart', 'scroll']) window.addEventListener(ev, touch, { passive: true });
    setInterval(() => this.check(), 30_000);
  }

  /** Visible for tests. */
  check(now = Date.now()) {
    if (!this.auth.isAuthenticated || !this.auth.user() || this.gate.active()) { this.last = now; return; }
    if (now - this.last > IDLE_LIMIT_MS) { this.last = now; this.auth.expire(); }
  }
}
