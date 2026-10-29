import { Injectable, signal } from '@angular/core';

export interface Toast { id: number; kind: 'success' | 'error' | 'info'; text: string; }

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private seq = 0;

  show(kind: Toast['kind'], text: string, ms = 4500) {
    const id = ++this.seq;
    this.toasts.update(t => [...t, { id, kind, text }]);
    setTimeout(() => this.dismiss(id), ms);
  }
  success(text: string) { this.show('success', text); }
  error(text: string) { this.show('error', text, 7000); }
  info(text: string) { this.show('info', text); }
  dismiss(id: number) { this.toasts.update(t => t.filter(x => x.id !== id)); }
}
