import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/** Requires a session; forces the password change when the server flagged it. */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.isAuthenticated || !auth.user()) return router.createUrlTree(['/login'], { queryParams: { next: state.url } });
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
