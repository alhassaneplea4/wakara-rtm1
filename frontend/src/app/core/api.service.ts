import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '@env/environment';

export type Query = Record<string, string | number | boolean | null | undefined | string[]>;

/** Thin typed wrapper around HttpClient (base URL + query-string handling). */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  readonly base = environment.apiUrl;

  private params(query?: Query): HttpParams {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === null || v === undefined || v === '') continue;
      if (Array.isArray(v)) v.forEach(x => (p = p.append(k, x)));
      else p = p.set(k, String(v));
    }
    return p;
  }

  get<T>(path: string, query?: Query): Observable<T> { return this.http.get<T>(`${this.base}${path}`, { params: this.params(query) }); }
  post<T>(path: string, body: unknown = {}): Observable<T> { return this.http.post<T>(`${this.base}${path}`, body); }
  put<T>(path: string, body: unknown): Observable<T> { return this.http.put<T>(`${this.base}${path}`, body); }
  patch<T>(path: string, body: unknown): Observable<T> { return this.http.patch<T>(`${this.base}${path}`, body); }
  delete<T>(path: string, body?: unknown): Observable<T> { return this.http.delete<T>(`${this.base}${path}`, { body }); }
  blob(path: string, query?: Query): Observable<Blob> {
    return this.http.get(`${this.base}${path}`, { params: this.params(query), responseType: 'blob' });
  }
}

/** French labels for the API field names shown in error messages. */
const FIELD_LABELS: Record<string, string> = {
  numero_acte: "Numéro officiel de l'acte", annee: 'Année', registre: 'Registre', feuillet: 'Feuillet',
  birth_date: 'Date de naissance', declaration_date: 'Date de déclaration', reason: 'Motif', role: 'Rôle',
  username: 'Identifiant', password: 'Mot de passe', new_password: 'Nouveau mot de passe', email: 'E-mail',
  code: 'Code', name: 'Nom', hospital: 'Établissement', permissions: 'Permissions', file: 'Fichier',
  recipient_name: 'Bénéficiaire', codename: 'Code', is_active: 'État',
};

/** Extracts a readable message from a DRF error response. */
export function errorMessage(err: any, fallback = "Une erreur est survenue. Veuillez réessayer."): string {
  const e = err?.error;
  if (!e) return err?.status === 0 ? 'Serveur injoignable. Vérifiez votre connexion.' : fallback;
  if (typeof e === 'string') return fallback;
  if (e.detail) return String(e.detail);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (k === 'code' || k === 'missing_fields') continue;
    const msg = Array.isArray(v) ? v.join(' ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(k === 'non_field_errors' ? msg : `${FIELD_LABELS[k] ?? k} : ${msg}`);
  }
  return parts.join(' — ') || fallback;
}

/** Field-level errors of a DRF response: { field: message } (nested keys flattened with dots). */
export function fieldErrors(err: any): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (obj: any, prefix: string) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (Array.isArray(v) && typeof v[0] === 'string') out[key] = v.join(' ');
      else if (typeof v === 'string') out[key] = v;
      else walk(v, key);
    }
  };
  walk(err?.error, '');
  return out;
}
