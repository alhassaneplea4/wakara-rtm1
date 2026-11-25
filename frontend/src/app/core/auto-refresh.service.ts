import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, fromEvent, interval } from 'rxjs';
import { AuthService } from './auth.service';

/** Delay between two automatic refreshes of the screens (and of the menu badges). */
export const REFRESH_PERIOD_MS = 15_000;

/**
 * Emits a tick every 15 seconds while a session is open and the tab is visible, and once more as soon
 * as the user comes back to a tab that stayed hidden. Screens subscribe with {@link on} and reload
 * their data silently; nothing ticks on the login page or after sign-out.
 */
@Injectable({ providedIn: 'root' })
export class AutoRefreshService {
  private auth = inject(AuthService);
  readonly tick$ = new Subject<void>();
  /**
   * Same rhythm, but also while the tab is hidden (browsers may slow a background tab down): used to warn the user
   * of new work even when another tab or window is in front.
   */
  readonly alert$ = new Subject<void>();

  constructor() {
    interval(REFRESH_PERIOD_MS).subscribe(() => { this.emit(); if (this.auth.isAuthenticated) this.alert$.next(); });
    fromEvent(document, 'visibilitychange').subscribe(() => { this.emit(); if (this.auth.isAuthenticated && !document.hidden) this.alert$.next(); });
  }

  private emit() {
    if (this.auth.isAuthenticated && !document.hidden) this.tick$.next();
  }

  /** Runs ``fn`` on every alert tick (visible or not) until the calling component is destroyed. */
  onAlert(destroyRef: DestroyRef, fn: () => void) {
    this.alert$.pipe(takeUntilDestroyed(destroyRef)).subscribe(fn);
  }

  /** Runs ``fn`` on every tick until the calling component is destroyed. */
  on(destroyRef: DestroyRef, fn: () => void) {
    this.tick$.pipe(takeUntilDestroyed(destroyRef)).subscribe(fn);
  }
}
