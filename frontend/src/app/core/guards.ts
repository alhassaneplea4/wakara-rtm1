import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';
import { OfflineGate } from './offline/offline-gate.service';
import { readVaultHeader } from './offline/vault-header';

/** Requires a session; forces the password change when the server flagged it. */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.hasSession) {
    // a device protected by a PIN reopens on the unlock screen (it works without network), not on the sign-in page
    return router.createUrlTree([readVaultHeader() ? '/verrouillage' : '/login'], { queryParams: { next: state.url } });
  }
  if (auth.user()!.must_change_password && !state.url.startsWith('/profile')) {
    return router.createUrlTree(['/profile'], { queryParams: { force: 1 } });
  }
  return true;
};

/** route.data.perms = ['code', ...] → at least one is required (UI convenience; the API enforces for real). */
export const permissionGuard: CanActivateFn = route => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const perms: string[] = route.data['perms'] ?? [];
  return !perms.length || auth.canAny(...perms) ? true : router.createUrlTree(['/forbidden']);
};

export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.isAuthenticated && auth.user() ? inject(Router).createUrlTree(['/dashboard']) : true;
};

/**
 * Offline mode: set-up or unlock of the device before any screen, and no other account on a device that still
 * holds unsent operations (see OfflineGate.checkAccess). Transparent for users who do not work offline.
 */
export const offlineGuard: CanActivateFn = (_route, state) => inject(OfflineGate).checkAccess(state.url);

/** The PIN screen needs either a signed-in user (set-up) or a device already protected (unlock). */
export const lockGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.hasSession || readVaultHeader() ? true : inject(Router).createUrlTree(['/login']);
};
