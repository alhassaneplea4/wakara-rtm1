import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, errorMessage } from '../core/api.service';
import { ToastService } from '../core/toast.service';
import { PageHeaderComponent } from '../shared/ui';

interface Setting { key: string; value: string; description: string; is_public: boolean; }

@Component({
  selector: 'wk-settings', standalone: true,
  imports: [CommonModule, FormsModule, PageHeaderComponent],
  template: `
    <div class="page">
      <wk-page-header title="Paramètres" subtitle="Textes de la page de connexion et valeurs par défaut des actes" />
      @if (error()) { <div class="alert alert-danger" style="margin-bottom:16px">{{ error() }}</div> }
      <section class="card">
        <div class="alert alert-info" style="margin-bottom:16px">Dans le titre de la page de connexion, entourez de <code>*astérisques*</code> les mots à mettre en couleur et utilisez un retour à la ligne pour séparer les lignes.</div>
        <div class="form-grid">
          @for (s of items(); track s.key) {
            <div class="field wide"><label>{{ s.description }} @if (s.is_public) { <span class="badge badge-info">Page publique</span> }</label>
              @if (s.value.length > 80 || s.key.endsWith('description') || s.key.endsWith('headline')) { <textarea class="input" [(ngModel)]="s.value"></textarea> }
              @else { <input class="input" [(ngModel)]="s.value" /> }</div>
          }
        </div>
        <div class="modal-actions"><button class="btn btn-primary" [disabled]="busy()" (click)="save()">Enregistrer</button></div>
      </section>
    </div>
  `,
})
export class SettingsComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  items = signal<Setting[]>([]); error = signal(''); busy = signal(false);
  ngOnInit() { this.api.get<Setting[]>('/settings/').subscribe({ next: s => this.items.set(s), error: e => this.error.set(errorMessage(e)) }); }
  save() {
    this.busy.set(true);
    this.api.patch<Setting[]>('/settings/', Object.fromEntries(this.items().map(s => [s.key, s.value]))).subscribe({
      next: s => { this.busy.set(false); this.items.set(s); this.toast.success('Paramètres enregistrés.'); },
      error: e => { this.busy.set(false); this.error.set(errorMessage(e)); } });
  }
}
