import { CommonModule } from '@angular/common';
import { Component, OnInit, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, errorMessage, fieldErrors } from '../core/api.service';
import { DeclarationDetail, Hospital, Page } from '../core/models';
import { ToastService } from '../core/toast.service';
import { PaperFormComponent } from '../shared/paper-form.component';
import { IconComponent, PageHeaderComponent } from '../shared/ui';

type PersonForm = { first_names: string; last_name: string; age: number | null; nationality: string; profession: string; address: string; phone: string; date_of_birth: string; birth_place: string; id_type: string; id_number: string };
const blankPerson = (): PersonForm => ({ first_names: '', last_name: '', age: null, nationality: '', profession: '', address: '', phone: '', date_of_birth: '', birth_place: '', id_type: '', id_number: '' });
const nullIfEmpty = (v: unknown) => (v === '' || v === undefined ? null : v);

@Component({
  selector: 'wk-declaration-form', standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, IconComponent, PageHeaderComponent, PaperFormComponent],
  template: `
    <div class="page">
      <wk-page-header [title]="uuid ? 'Modifier la déclaration' : 'Nouvelle déclaration de naissance'"
        [subtitle]="uuid ? ref : 'Saisie à partir du formulaire remis par l\\'hôpital ou la maternité'">
        <a class="btn" [routerLink]="uuid ? ['/declarations', uuid] : ['/declarations']">Annuler</a>
      </wk-page-header>

      @if (error()) { <div class="alert alert-danger" role="alert" style="margin-bottom:16px">{{ error() }}</div> }

      @if (loaded()) {
        <form (ngSubmit)="save(false)" class="stack" #f="ngForm">
          <section class="card">
            <wk-paper-form [declaration]="uuid" [editable]="true" />
          </section>

          <section class="card">
            <div class="card-title"><h2>Établissement de santé</h2></div>
            <div class="form-grid">
              <div class="field"><label>Établissement</label>
                <select class="input" name="hospital" [(ngModel)]="m.hospital" [class.invalid]="err('hospital')">
                  <option [ngValue]="null">— Non identifié —</option>
                  @for (h of hospitals(); track h.uuid) { <option [ngValue]="h.uuid">{{ h.name }}</option> }
                </select><span class="field-error">{{ err('hospital') }}</span></div>
              <div class="field"><label>Référence du document hospitalier</label><input class="input" name="ref" [(ngModel)]="m.hospital_document_ref" /></div>
              <div class="field"><label>Médecin</label><input class="input" name="doc" [(ngModel)]="m.doctor_name" /></div>
              <div class="field"><label>Sage-femme</label><input class="input" name="mw" [(ngModel)]="m.midwife_name" /></div>
            </div>
          </section>

          <section class="card">
            <div class="card-title"><h2>Enfant</h2></div>
            <div class="form-grid">
              <div class="field"><label>Prénoms</label><input class="input" name="c_fn" [(ngModel)]="m.child.first_names" /></div>
              <div class="field"><label>Nom</label><input class="input" name="c_ln" [(ngModel)]="m.child.last_name" /></div>
              <div class="field"><label>Sexe</label>
                <select class="input" name="c_g" [(ngModel)]="m.child.gender"><option value="">—</option><option value="M">Masculin</option><option value="F">Féminin</option></select></div>
              <div class="field"><label class="req">Date de naissance</label><input class="input" type="date" name="bd" [(ngModel)]="m.birth_date" required [class.invalid]="err('birth_date')" />
                <span class="field-error">{{ err('birth_date') }}</span></div>
              <div class="field"><label>Heure de naissance</label><input class="input" type="time" name="bt" [(ngModel)]="m.birth_time" /></div>
              <div class="field"><label>Lieu de naissance</label><input class="input" name="bp" [(ngModel)]="m.birth_place" /></div>
              <div class="field"><label>Poids (kg)</label><input class="input" type="number" step="0.01" min="0" name="w" [(ngModel)]="m.child.birth_weight" /></div>
              <div class="field"><label>Taille (cm)</label><input class="input" type="number" step="0.1" min="0" name="l" [(ngModel)]="m.child.birth_length" /></div>
            </div>
          </section>

          <section class="card">
            <div class="card-title"><h2>Mère</h2></div>
            <div class="form-grid">
              <div class="field"><label>Prénoms</label><input class="input" name="m_fn" [(ngModel)]="m.mother.first_names" /></div>
              <div class="field"><label>Nom</label><input class="input" name="m_ln" [(ngModel)]="m.mother.last_name" /></div>
              <div class="field"><label>Âge</label><input class="input" type="number" min="0" max="120" name="m_age" [(ngModel)]="m.mother.age" /></div>
              <div class="field"><label>Profession</label><input class="input" name="m_pr" [(ngModel)]="m.mother.profession" /></div>
              <div class="field"><label>Nationalité</label><input class="input" name="m_na" [(ngModel)]="m.mother.nationality" /></div>
              <div class="field"><label>Téléphone</label><input class="input" name="m_ph" [(ngModel)]="m.mother.phone" /></div>
              <div class="field wide"><label>Domicile</label><input class="input" name="m_ad" [(ngModel)]="m.mother.address" /></div>
            </div>
          </section>

          <section class="card">
            <div class="card-title"><h2>Père</h2>
              <label class="check"><input type="checkbox" name="hasF" [(ngModel)]="hasFather" /> Renseigner le père</label></div>
            @if (hasFather) {
              <div class="form-grid">
                <div class="field"><label>Prénoms</label><input class="input" name="f_fn" [(ngModel)]="m.father.first_names" /></div>
                <div class="field"><label>Nom</label><input class="input" name="f_ln" [(ngModel)]="m.father.last_name" /></div>
                <div class="field"><label>Âge</label><input class="input" type="number" min="0" max="120" name="f_age" [(ngModel)]="m.father.age" /></div>
                <div class="field"><label>Profession</label><input class="input" name="f_pr" [(ngModel)]="m.father.profession" /></div>
                <div class="field"><label>Nationalité</label><input class="input" name="f_na" [(ngModel)]="m.father.nationality" /></div>
                <div class="field"><label>Téléphone</label><input class="input" name="f_ph" [(ngModel)]="m.father.phone" /></div>
                <div class="field wide"><label>Domicile</label><input class="input" name="f_ad" [(ngModel)]="m.father.address" /></div>
              </div>
            } @else { <p class="muted">Père non renseigné (inconnu ou absent).</p> }
          </section>

          <section class="card">
            <div class="card-title"><h2>Déclarant</h2>
              <label class="check"><input type="checkbox" name="hasD" [(ngModel)]="hasDeclarant" /> Renseigner le déclarant</label></div>
            @if (hasDeclarant) {
              <div class="form-grid">
                <div class="field"><label>Prénoms</label><input class="input" name="d_fn" [(ngModel)]="m.declarant.first_names" /></div>
                <div class="field"><label>Nom</label><input class="input" name="d_ln" [(ngModel)]="m.declarant.last_name" /></div>
                <div class="field"><label>Lien avec l'enfant</label><input class="input" name="d_rel" [(ngModel)]="m.declarant.relationship" /></div>
                <div class="field"><label>Profession</label><input class="input" name="d_pr" [(ngModel)]="m.declarant.profession" /></div>
                <div class="field"><label>Téléphone</label><input class="input" name="d_ph" [(ngModel)]="m.declarant.phone" /></div>
                <div class="field"><label>Pièce d'identité</label><input class="input" name="d_idt" [(ngModel)]="m.declarant.id_type" placeholder="Type" /></div>
                <div class="field"><label>N° de la pièce</label><input class="input" name="d_idn" [(ngModel)]="m.declarant.id_number" /></div>
                <div class="field wide"><label>Domicile</label><input class="input" name="d_ad" [(ngModel)]="m.declarant.address" /></div>
              </div>
            } @else { <p class="muted">Le déclarant pourra être renseigné par le secrétariat en présence des parents.</p> }
          </section>

          <section class="card">
            <div class="field"><label>Observations</label><textarea class="input" name="notes" [(ngModel)]="m.notes"></textarea></div>
          </section>

          <div class="actions">
            <button class="btn" type="submit" [disabled]="busy()">
              @if (busy() && !transmitting) { <span class="spinner dark"></span> }
              {{ uuid ? 'Enregistrer les modifications' : 'Enregistrer le brouillon' }}
            </button>
            @if (canTransmit) {
              <button class="btn btn-primary" type="button" [disabled]="busy()" (click)="save(true)">
                @if (busy() && transmitting) { <span class="spinner"></span> }
                <wk-icon name="arrow" [size]="16" /> Enregistrer et transmettre au secrétariat
              </button>
            }
          </div>
        </form>
      } @else { <div class="card"><div class="skeleton" style="height:240px"></div></div> }
    </div>
  `,
  styles: ['.stack{display:flex;flex-direction:column;gap:16px}.actions{display:flex;gap:12px;flex-wrap:wrap;justify-content:flex-end;position:sticky;bottom:0;padding:12px 0;background:linear-gradient(transparent,var(--wk-bg) 30%)}'],
})
export class DeclarationFormComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);

  @ViewChild(PaperFormComponent) paper?: PaperFormComponent;

  uuid = '';
  ref = '';
  status = 'DRAFT';
  loaded = signal(false);
  busy = signal(false);
  error = signal('');
  errors = signal<Record<string, string>>({});
  hospitals = signal<Hospital[]>([]);
  hasFather = false;
  hasDeclarant = false;
  transmitting = false;
  canTransmit = true;

  m: any = {
    hospital: null, hospital_document_ref: '', doctor_name: '', midwife_name: '', birth_date: '', birth_time: '', birth_place: '', notes: '',
    child: { first_names: '', last_name: '', gender: '', birth_weight: null, birth_length: null },
    mother: blankPerson(), father: blankPerson(),
    declarant: { first_names: '', last_name: '', relationship: '', profession: '', phone: '', address: '', id_type: '', id_number: '' },
  };

  err(k: string) { return this.errors()[k] ?? ''; }

  ngOnInit() {
    this.uuid = this.route.snapshot.paramMap.get('uuid') ?? '';
    this.api.get<Page<Hospital>>('/hospitals/', { is_active: true, page_size: 100 }).subscribe({ next: p => this.hospitals.set(p.results), error: () => undefined });
    if (!this.uuid) { this.loaded.set(true); return; }
    this.api.get<DeclarationDetail>(`/declarations/${this.uuid}/`).subscribe({
      next: d => {
        this.ref = d.reference; this.status = d.status;
        if (!d.can_edit) { this.toast.error("Ce dossier ne peut pas être modifié dans son état actuel."); this.router.navigate(['/declarations', d.uuid]); return; }
        this.canTransmit = d.available_transitions.some(t => t.target === 'TRANSMITTED');
        Object.assign(this.m, {
          hospital: d.hospital, hospital_document_ref: d.hospital_document_ref, doctor_name: d.doctor_name, midwife_name: d.midwife_name,
          birth_date: d.birth_date, birth_time: d.birth_time?.slice(0, 5) ?? '', birth_place: d.birth_place, notes: d.notes,
        });
        if (d.child) Object.assign(this.m.child, d.child);
        if (d.mother) Object.assign(this.m.mother, this.clean(d.mother));
        if (d.father) { Object.assign(this.m.father, this.clean(d.father)); this.hasFather = true; }
        if (d.declarant) { Object.assign(this.m.declarant, this.clean(d.declarant)); this.hasDeclarant = true; }
        this.loaded.set(true);
      },
      error: e => { this.error.set(errorMessage(e)); this.loaded.set(true); },
    });
  }

  private clean(o: any) { return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v ?? ''])); }

  private person(p: PersonForm) {
    return { ...p, age: nullIfEmpty(p.age), date_of_birth: nullIfEmpty(p.date_of_birth) };
  }

  private payload() {
    const m = this.m;
    const body: any = {
      hospital: m.hospital, hospital_document_ref: m.hospital_document_ref, doctor_name: m.doctor_name, midwife_name: m.midwife_name,
      birth_date: m.birth_date, birth_time: nullIfEmpty(m.birth_time), birth_place: m.birth_place, notes: m.notes,
      child: { ...m.child, birth_weight: nullIfEmpty(m.child.birth_weight), birth_length: nullIfEmpty(m.child.birth_length) },
      mother: this.person(m.mother),
      father: this.hasFather ? this.person(m.father) : (this.uuid ? undefined : null),
      declarant: this.hasDeclarant ? m.declarant : (this.uuid ? undefined : null),
    };
    Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
    return body;
  }

  save(transmit: boolean) {
    this.error.set(''); this.errors.set({});
    if (!this.m.birth_date) { this.errors.set({ birth_date: 'La date de naissance est requise.' }); this.error.set('Veuillez corriger les champs signalés.'); return; }
    this.busy.set(true); this.transmitting = transmit;
    const req = this.uuid ? this.api.patch<DeclarationDetail>(`/declarations/${this.uuid}/`, this.payload()) : this.api.post<DeclarationDetail>('/declarations/', this.payload());
    req.subscribe({
      next: async d => {
        // New dossier: the photos taken before saving are attached now that the dossier exists.
        const failed = this.uuid ? 0 : (await this.paper?.uploadPending(d.uuid)) ?? 0;
        if (failed) this.toast.error(`${failed} fichier(s) de la fiche n'ont pas pu être joints : rouvrez le dossier pour les ajouter à nouveau.`);
        if (!transmit) { this.busy.set(false); this.toast.success(this.uuid ? 'Modifications enregistrées.' : `Brouillon ${d.reference} enregistré.`); this.router.navigate(['/declarations', d.uuid]); return; }
        this.api.post<DeclarationDetail>(`/declarations/${d.uuid}/transition/`, { status: 'TRANSMITTED' }).subscribe({
          next: () => { this.busy.set(false); this.toast.success(`Déclaration ${d.reference} transmise au secrétariat.`); this.router.navigate(['/declarations', d.uuid]); },
          error: e => { this.busy.set(false); this.toast.error('Enregistrée, mais non transmise : ' + errorMessage(e)); this.router.navigate(['/declarations', d.uuid, 'edit']); },
        });
      },
      error: e => { this.busy.set(false); this.errors.set(fieldErrors(e)); this.error.set(errorMessage(e)); },
    });
  }
}
