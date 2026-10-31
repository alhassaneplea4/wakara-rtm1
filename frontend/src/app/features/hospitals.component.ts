import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, errorMessage, fieldErrors } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { Hospital, Page } from '../core/models';
import { ToastService } from '../core/toast.service';
import { ConfirmComponent, IconComponent, PageHeaderComponent, PaginationComponent } from '../shared/ui';

const TYPES = [['HOSPITAL', 'Hôpital'], ['MATERNITY', 'Maternité'], ['CLINIC', 'Clinique'], ['HEALTH_CENTER', 'Centre de santé'], ['OTHER', 'Autre']];

@Component({
  selector: 'wk-hospitals', standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, PageHeaderComponent, PaginationComponent, ConfirmComponent],
  template: `
    <div class="page">
      <wk-page-header title="Hôpitaux et maternités" subtitle="Établissements de santé à l'origine des déclarations">
        @if (auth.can('hospital.create')) { <button class="btn btn-primary" (click)="edit(null)"><wk-icon name="plus" [size]="16" /> Nouvel établissement</button> }
      </wk-page-header>
      <section class="card flush">
        <div class="filters">
          <input class="input" [(ngModel)]="search" (keyup.enter)="reload()" placeholder="Nom ou code…" aria-label="Recherche" />
          <select class="input" [(ngModel)]="active" (ngModelChange)="reload()" aria-label="État"><option value="">Tous</option><option value="true">Actifs</option><option value="false">Désactivés</option></select>
          @if (auth.can('hospital.archive')) { <label class="check"><input type="checkbox" [(ngModel)]="archived" (ngModelChange)="reload()" /> Archivés</label> }
          <button class="btn" (click)="reload()">Rechercher</button>
        </div>
        @if (error()) { <div class="alert alert-danger" style="margin:16px">{{ error() }}</div> }
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Code</th><th>Nom</th><th>Type</th><th>Commune</th><th>Contact</th><th>Déclarations</th><th>État</th><th></th></tr></thead>
          <tbody>
            @for (h of rows(); track h.uuid) {
              <tr><td class="mono">{{ h.code }}</td><td><strong>{{ h.name }}</strong></td><td>{{ h.facility_type_label }}</td><td>{{ h.commune || '—' }}</td>
                <td>{{ h.phone || h.email || '—' }}</td><td class="mono">{{ h.declaration_count }}</td>
                <td><span class="badge" [ngClass]="h.is_archived ? 'badge-neutral' : h.is_active ? 'badge-success' : 'badge-warning'">{{ h.is_archived ? 'Archivé' : h.is_active ? 'Actif' : 'Désactivé' }}</span></td>
                <td class="row" style="justify-content:flex-end">
                  @if (!h.is_archived) {
                    @if (auth.can('hospital.update')) { <button class="btn btn-sm" (click)="edit(h)">Modifier</button>
                      <button class="btn btn-sm" (click)="toggle(h)">{{ h.is_active ? 'Désactiver' : 'Activer' }}</button> }
                    @if (auth.can('hospital.archive')) { <button class="btn btn-sm btn-ghost" (click)="toArchive.set(h)">Archiver</button> }
                  } @else if (auth.can('hospital.archive')) { <button class="btn btn-sm" (click)="restore(h)">Restaurer</button> }
                </td></tr>
            } @empty { <tr><td colspan="8"><div class="empty"><strong>Aucun établissement</strong>Ajoutez les hôpitaux et maternités partenaires.</div></td></tr> }
          </tbody></table></div>
        <wk-pagination [page]="page" [total]="total()" (pageChange)="page = $event; load()" />
      </section>
    </div>

    @if (form(); as f) {
      <div class="modal-backdrop" (click)="form.set(null)">
        <div class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <h2>{{ editing ? 'Modifier l\\'établissement' : 'Nouvel établissement' }}</h2>
          @if (!editing) { <p class="soft" style="margin-bottom:12px">Le code (format <span class="mono">WH-0001-26</span>) est attribué automatiquement à l'enregistrement.</p> }
          @if (formError()) { <div class="alert alert-danger" style="margin-bottom:12px">{{ formError() }}</div> }
          <div class="form-grid">
            @if (editing) { <div class="field"><label>Code</label><input class="input mono" [value]="editing.code" readonly aria-readonly="true" /></div> }
            <div class="field"><label>Type</label><select class="input" [(ngModel)]="f.facility_type">@for (t of types; track t[0]) { <option [value]="t[0]">{{ t[1] }}</option> }</select></div>
            <div class="field wide"><label class="req">Nom officiel</label><input class="input" [(ngModel)]="f.name" [class.invalid]="errs()['name']" /><span class="field-error">{{ errs()['name'] }}</span></div>
            <div class="field"><label>Région</label><input class="input" [(ngModel)]="f.region" /></div>
            <div class="field"><label>Commune</label><input class="input" [(ngModel)]="f.commune" /></div>
            <div class="field wide"><label>Adresse</label><input class="input" [(ngModel)]="f.address" /></div>
            <div class="field"><label>Contact administratif</label><input class="input" [(ngModel)]="f.contact_name" /></div>
            <div class="field"><label>Téléphone</label><input class="input" [(ngModel)]="f.phone" /></div>
            <div class="field wide"><label>E-mail</label><input class="input" type="email" [(ngModel)]="f.email" [class.invalid]="errs()['email']" /><span class="field-error">{{ errs()['email'] }}</span></div>
          </div>
          <div class="modal-actions"><button class="btn" (click)="form.set(null)">Annuler</button><button class="btn btn-primary" [disabled]="busy()" (click)="save()">Enregistrer</button></div>
        </div>
      </div>
    }
    @if (toArchive(); as h) {
      <wk-confirm title="Archiver l'établissement" confirmLabel="Archiver" [danger]="true" (cancel)="toArchive.set(null)" (confirm)="archive(h)">
        « {{ h.name }} » sera masqué des listes. Ses déclarations et statistiques historiques sont conservées.
      </wk-confirm>
    }
  `,
  styles: ['.filters{display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:16px;border-bottom:1px solid var(--wk-border)}.filters .input{width:auto;min-width:200px;min-height:40px}'],
})
export class HospitalsComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  auth = inject(AuthService);
  types = TYPES;
  search = ''; active = ''; archived = false; page = 1;
  rows = signal<Hospital[]>([]); total = signal(0); error = signal('');
  form = signal<any>(null); editing: Hospital | null = null; formError = signal(''); errs = signal<Record<string, string>>({}); busy = signal(false);
  toArchive = signal<Hospital | null>(null);

  ngOnInit() { this.load(); }
  reload() { this.page = 1; this.load(); }
  load() {
    this.api.get<Page<Hospital>>('/hospitals/', { search: this.search, is_active: this.active, archived: this.archived ? 'true' : '', page: this.page }).subscribe({
      next: p => { this.rows.set(p.results); this.total.set(p.count); this.error.set(''); }, error: e => this.error.set(errorMessage(e)),
    });
  }
  edit(h: Hospital | null) {
    this.editing = h; this.formError.set(''); this.errs.set({});
    this.form.set(h ? { ...h } : { name: '', facility_type: 'HOSPITAL', region: 'Conakry', commune: 'Ratoma', address: '', contact_name: '', phone: '', email: '' });
  }
  save() {
    const f = this.form(); this.busy.set(true); this.formError.set(''); this.errs.set({});
    const body = { name: f.name, facility_type: f.facility_type, region: f.region, commune: f.commune, address: f.address, contact_name: f.contact_name, phone: f.phone, email: f.email };
    const req = this.editing ? this.api.patch<Hospital>(`/hospitals/${this.editing.uuid}/`, body) : this.api.post<Hospital>('/hospitals/', body);
    req.subscribe({
      next: () => { this.busy.set(false); this.form.set(null); this.toast.success('Établissement enregistré.'); this.load(); },
      error: e => { this.busy.set(false); this.errs.set(fieldErrors(e)); this.formError.set(errorMessage(e)); },
    });
  }
  toggle(h: Hospital) {
    this.api.post(`/hospitals/${h.uuid}/${h.is_active ? 'deactivate' : 'activate'}/`).subscribe({
      next: () => { this.toast.success(h.is_active ? 'Établissement désactivé.' : 'Établissement activé.'); this.load(); }, error: e => this.toast.error(errorMessage(e)) });
  }
  archive(h: Hospital) {
    this.api.delete(`/hospitals/${h.uuid}/`).subscribe({ next: () => { this.toArchive.set(null); this.toast.success('Établissement archivé.'); this.load(); }, error: e => { this.toArchive.set(null); this.toast.error(errorMessage(e)); } });
  }
  restore(h: Hospital) { this.api.post(`/hospitals/${h.uuid}/restore/`).subscribe({ next: () => { this.toast.success('Établissement restauré.'); this.load(); }, error: e => this.toast.error(errorMessage(e)) }); }
}
