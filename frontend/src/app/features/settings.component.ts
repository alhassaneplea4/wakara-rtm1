
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, errorMessage } from '../core/api.service';
import { ToastService } from '../core/toast.service';
import { PageHeaderComponent } from '../shared/ui';
import { AuthService } from '../core/auth.service';

interface Audience { since: string; total: number; pages: { path: string; visits: number }[]; days: { day: string; visits: number }[]; }
interface Setting { key: string; value: string; description: string; is_public: boolean; }

@Component({
    selector: 'wk-settings',
    imports: [FormsModule, PageHeaderComponent],
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
      @if (audience(); as a) {
        <section class="card" style="margin-top:16px">
          <div class="card-title"><h2>Audience des pages publiques</h2></div>
          <p class="soft">Visites des 30 derniers jours (page de connexion et pages légales), pour les visiteurs qui ont accepté la mesure. Compteur anonyme : aucune adresse, aucun identifiant ; les pages de l'application ne sont jamais comptées.</p>
          <p><strong>{{ a.total }}</strong> visite(s) depuis le {{ a.since }}.</p>
          <table class="table"><thead><tr><th>Page</th><th>Visites</th></tr></thead>
            <tbody>@for (p of a.pages; track p.path) { <tr><td class="mono">{{ p.path }}</td><td>{{ p.visits }}</td></tr> } @empty { <tr><td colspan="2" class="muted">Aucune visite comptée.</td></tr> }</tbody></table>
        </section>
      }
    </div>
  `
})
export class SettingsComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private auth = inject(AuthService);
  items = signal<Setting[]>([]); error = signal(''); busy = signal(false); audience = signal<Audience | null>(null);
  ngOnInit() {
    this.api.get<Setting[]>('/settings/').subscribe({ next: s => this.items.set(s), error: e => this.error.set(errorMessage(e)) });
    if (this.auth.can('stats.view')) this.api.get<Audience>('/stats/audience/').subscribe({ next: a => this.audience.set(a), error: () => undefined });
  }
  save() {
    this.busy.set(true);
    this.api.patch<Setting[]>('/settings/', Object.fromEntries(this.items().map(s => [s.key, s.value]))).subscribe({
      next: s => { this.busy.set(false); this.items.set(s); this.toast.success('Paramètres enregistrés.'); },
      error: e => { this.busy.set(false); this.error.set(errorMessage(e)); } });
  }
}
