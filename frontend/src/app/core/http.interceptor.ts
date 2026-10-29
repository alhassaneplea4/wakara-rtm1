import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError } from 'rxjs';
import { environment } from '@env/environment';
import { AuthService, SKIP_AUTH } from './auth.service';

const PUBLIC = ['/auth/login/', '/auth/refresh/', '/public/'];

/** Adds the bearer token; on 401 refreshes once and replays the request, otherwise ends the session. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  if (req.context.get(SKIP_AUTH) || !req.url.startsWith(environment.apiUrl) || PUBLIC.some(p => req.url.includes(p))) return next(req);

  const withToken = (r: HttpRequest<unknown>, token: string | null) =>
    token ? r.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : r;

  return next(withToken(req, auth.accessToken)).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status !== 401 || !auth.refreshToken) {
        if (err.status === 401) auth.expire();
        return throwError(() => err);
      }
      return auth.refresh().pipe(
        switchMap(token => next(withToken(req, token))),
        catchError(e => { auth.expire(); return throwError(() => e); }),
      );
    }),
  );
};
