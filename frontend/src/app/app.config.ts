import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { APP_INITIALIZER, ApplicationConfig, inject, isDevMode } from '@angular/core';
import { NavigationError, provideRouter, withComponentInputBinding, withInMemoryScrolling, withNavigationErrorHandler } from '@angular/router';
import { SwUpdate, provideServiceWorker } from '@angular/service-worker';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './core/auth.service';
import { authInterceptor } from './core/http.interceptor';
import { OfflineGate } from './core/offline/offline-gate.service';
import { offlineInterceptor } from './core/offline/offline.interceptor';
import { ToastService } from './core/toast.service';
import { routes } from './app.routes';

const CHUNK_ERROR = /dynamically imported module|Loading chunk|ChunkLoadError|Importing a module script failed/i;

/**
 * A page of the app is a lazy-loaded chunk. After a new deployment (or a dev rebuild) the chunk names
 * of an already open tab no longer exist and the navigation fails silently: menu links "do nothing".
 * Recover by reloading the target URL once; if it keeps failing, tell the user instead of freezing.
 */
function onNavigationError(error: NavigationError) {
  const toast = inject(ToastService);
  if (CHUNK_ERROR.test(String(error.error?.message ?? error.error))) {
    const key = 'wk_chunk_reload';
    let last = 0;
    try { last = Number(sessionStorage.getItem(key) ?? 0); sessionStorage.setItem(key, String(Date.now())); } catch { /* ignore */ }
    if (Date.now() - last > 15000) { window.location.assign(error.url); return; }
    toast.error("L'application a été mise à jour. Rechargez la page (Ctrl+F5) pour continuer.");
    return;
  }
  toast.error("Impossible d'ouvrir cette page.");
  console.error(error.error);
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ scrollPositionRestoration: 'top' }), withNavigationErrorHandler(onNavigationError)),
    // offline first (it may answer from the device), then the bearer token / refresh logic
    provideHttpClient(withInterceptors([offlineInterceptor, authInterceptor])),
    // Application shell available without network (production builds only). The API is never cached by the
    // service worker: offline data live encrypted in IndexedDB (core/offline).
    provideServiceWorker('ngsw-worker.js', { enabled: !isDevMode(), registrationStrategy: 'registerWhenStable:5000' }),
    // Restore the session (profile + permissions) before the first navigation.
    {
      provide: APP_INITIALIZER, multi: true, useFactory: () => {
        const a = inject(AuthService);
        const gate = inject(OfflineGate);  // sets the offline session rules before anything else runs
        const sw = inject(SwUpdate);
        return () => {
          // A new version is never applied under the user's hands (a form may be open): the shell offers to reload.
          if (sw.isEnabled) {
            sw.versionUpdates.subscribe(e => { if (e.type === 'VERSION_READY') gate.updateReady.set(true); });
            sw.unrecoverable.subscribe(() => gate.updateReady.set(true));
          }
          return firstValueFrom(a.restore());
        };
      },
    },
  ],
};
