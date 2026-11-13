import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { environment } from '@env/environment';
import { OfflineGate } from './offline-gate.service';

/**
 * Offline-first for the collection agent whose device is unlocked: the API calls the screens already make
 * are answered from the device when needed (see local-api.ts). For everybody else — and for the
 * synchronisation and authentication endpoints — the request goes to the network untouched.
 */
export const offlineInterceptor: HttpInterceptorFn = (req, next) => {
  const gate = inject(OfflineGate);
  if (!gate.active() || !gate.current() || !req.url.startsWith(environment.apiUrl)) return next(req);
  if (req.url.includes('/sync/') || req.url.includes('/auth/') || req.url.includes('/public/')) return next(req);
  return gate.handle(req, next);
};
