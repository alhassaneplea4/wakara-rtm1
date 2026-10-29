import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { APP_INITIALIZER, ApplicationConfig, inject } from '@angular/core';
import { NavigationError, provideRouter, withComponentInputBinding, withInMemoryScrolling, withNavigationErrorHandler } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './core/auth.service';
import { authInterceptor } from './core/http.interceptor';
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
    provideHttpClient(withInterceptors([authInterceptor])),
    // Restore the session (profile + permissions) before the first navigation.
    { provide: APP_INITIALIZER, multi: true, useFactory: () => { const a = inject(AuthService); return () => firstValueFrom(a.restore()); } },
  ],
};
