import { CommonModule } from '@angular/common';
import { Component, OnInit, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, errorMessage, fieldErrors } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { Acte, DeclarationDetail, Hospital, Page } from '../core/models';
import { ToastService } from '../core/toast.service';
import { DateLettersPipe } from '../shared/date-letters.pipe';
import { IntegerInputDirective, NationalityInputDirective, NationalityListComponent, PhoneInputDirective, ageFromBirthDate, phoneError } from '../shared/field-formats';
import { PaperFormComponent } from '../shared/paper-form.component';
import { IconComponent, PageHeaderComponent } from '../shared/ui';

type PersonForm = { first_names: string; last_name: string; age: number | null; nationality: string; npi: string; marital_status: string; profession: string; address: string; phone: string; date_of_birth: string; birth_place: string };
const blankPerson = (): PersonForm => ({ first_names: '', last_name: '', age: null, nationality: '', npi: '', marital_status: '', profession: '', address: '', phone: '', date_of_birth: '', birth_place: '' });
const blankDeclarant = () => ({ first_names: '', last_name: '', relationship: '', nationality: '', npi: '', marital_status: '', profession: '', phone: '', address: '' });
const nullIfEmpty = (v: unknown) => (v === '' || v === undefined ? null : v);

/** Statuses in which the secretariat (or the validator) edits the registry header together with the dossier. */
const ACTE_STATUSES = ['TRANSMITTED', 'IN_COMPLETION', 'TO_CORRECT_SECRETARIAT', 'PENDING_VALIDATION'];
/** Officer pre-filled on every acte (same default as the API setting `acte.default_officer`). */
const DEFAULT_OFFICER = 'AMADOU KONIA CAMARA';
const DEFAULT_ACTE = {
  region: 'Conakry', prefecture: 'Conakry', commune_type: 'URBAINE', commune: 'Ratoma', centre_type: 'PRINCIPAL',
  centre: "Centre d'état civil de Ratoma", officer_name: DEFAULT_OFFICER,
};
/** The three boxes of « Situation matrimoniale » on the paper form. */
export const MARITAL = [{ v: 'CELIBATAIRE', l: 'Célibataire' }, { v: 'MARIE', l: 'Marié(e)' }, { v: 'VEUF', l: 'Veuf(ve)' }];

/**
 * What the secretariat must have filled in before sending a dossier to validation: every field except the NPI
 * (same list as the API setting `ACTE_REQUIRED_FOR_SUBMISSION`; the API stays the authority).
 */
const PERSON_KEYS = ['first_names', 'last_name', 'date_of_birth', 'birth_place', 'age', 'nationality', 'marital_status', 'profession', 'address', 'phone'];
const SUBMISSION_KEYS: string[] = [
  'hospital', 'birth_date', 'birth_time', 'birth_place',
  'child.first_names', 'child.last_name', 'child.gender', 'child.nationality', 'child.birth_rank',
  ...PERSON_KEYS.map(k => `father.${k}`), ...PERSON_KEYS.map(k => `mother.${k}`),
  'declarant.mode', 'declarant.first_names', 'declarant.last_name', 'declarant.relationship', 'declarant.nationality',
  'declarant.marital_status', 'declarant.profession', 'declarant.address', 'declarant.phone',
  'acte.annee', 'acte.registre', 'acte.feuillet', 'acte.region', 'acte.prefecture', 'acte.commune_type', 'acte.commune',
  'acte.centre_type', 'acte.centre', 'acte.declaration_date', 'acte.officer_name',
];

@Component({
  selector: 'wk-declaration-form', standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, IconComponent, PageHeaderComponent, PaperFormComponent, DateLettersPipe,
    PhoneInputDirective, IntegerInputDirective, NationalityInputDirective, NationalityListComponent],
  template: `
    <div class="page">
      <wk-page-header [title]="uuid ? 'Modifier la déclaration' : 'Nouvelle déclaration de naissance'"
        [subtitle]="uuid ? ref : 'Saisie à partir du formulaire remis par l\\'hôpital ou la maternité'">
        <a class="btn" [routerLink]="uuid ? ['/declarations', uuid] : ['/declarations']">Annuler</a>
      </wk-page-header>

      @if (error()) { <div class="alert alert-danger" role="alert" style="margin-bottom:16px">{{ error() }}</div> }

      @if (loaded()) {
        <form (ngSubmit)="save('draft')" class="stack uc-form" [class.sec]="sec" #f="ngForm" novalidate>
          @if (sec) {
            <section class="card">
              <div class="card-title"><h2>Références du registre</h2></div>
              <div class="form-grid">
                <div class="field need" [class.missing]="miss('acte.annee')"><label>Année</label><input class="input" wkInteger min="1900" max="2200" name="a_annee" [(ngModel)]="m.acte.annee" /></div>
                <div class="field need" [class.missing]="miss('acte.registre')"><label>Registre</label><input class="input" name="a_reg" [(ngModel)]="m.acte.registre" /></div>
                <div class="field need" [class.missing]="miss('acte.feuillet')"><label>Feuillet</label><input class="input" name="a_feu" [(ngModel)]="m.acte.feuillet" /></div>
                <div class="field"><label>N° officiel de l'acte</label><input class="input" name="a_num" autocomplete="off" [(ngModel)]="m.acte.numero_acte" [class.invalid]="err('numero_acte')" aria-describedby="num-help" />
                  <span class="field-error">{{ err('numero_acte') }}</span>
                  <small id="num-help" class="hint">Saisie libre ; l'administrateur le confirme ou le corrige à la validation.</small></div>
              </div>
            </section>
            <section class="card">
              <div class="card-title"><h2>Circonscription administrative</h2></div>
              <div class="geo">
                <div class="field need" [class.missing]="miss('acte.region')"><label>Région administrative de :</label><input class="input" name="a_reg_adm" [(ngModel)]="m.acte.region" /></div>
                <div class="field need" [class.missing]="miss('acte.prefecture')"><label>Préfecture :</label><input class="input" name="a_pref" [(ngModel)]="m.acte.prefecture" /></div>
                <div class="field need" [class.missing]="miss('acte.commune') || miss('acte.commune_type')"><label>Commune</label>
                  <div class="pick">
                    <label class="opt"><input type="radio" name="a_ct" value="URBAINE" [(ngModel)]="m.acte.commune_type" /> Urbaine</label>
                    <label class="opt"><input type="radio" name="a_ct" value="RURALE" [(ngModel)]="m.acte.commune_type" /> Rurale</label>
                    <span class="de">de :</span><input class="input" name="a_com" aria-label="Nom de la commune" [(ngModel)]="m.acte.commune" /></div></div>
                <div class="field need" [class.missing]="miss('acte.centre') || miss('acte.centre_type')"><label>Centre</label>
                  <div class="pick">
                    <label class="opt"><input type="radio" name="a_cet" value="PRINCIPAL" [(ngModel)]="m.acte.centre_type" /> Principal</label>
                    <label class="opt"><input type="radio" name="a_cet" value="SECONDAIRE" [(ngModel)]="m.acte.centre_type" /> Secondaire</label>
                    <span class="de">de :</span><input class="input" name="a_cen" aria-label="Nom du centre" [(ngModel)]="m.acte.centre" /></div></div>
              </div>
            </section>
            <section class="card">
              <div class="card-title"><h2>Déclaration et mentions</h2></div>
              <div class="form-grid">
                <div class="field need" [class.missing]="miss('acte.declaration_date')"><label>Date de déclaration</label><input class="input" type="date" name="a_dd" [(ngModel)]="m.acte.declaration_date" />
                  @if (m.acte.declaration_date) { <small class="letters">{{ m.acte.declaration_date | dateLetters }}</small> }</div>
                <div class="field need" [class.missing]="miss('acte.officer_name')"><label>Officier d'état civil</label><input class="input" name="a_off" [(ngModel)]="m.acte.officer_name" /></div>
                <div class="field wide"><label>Mentions</label><textarea class="input" name="a_men" [(ngModel)]="m.acte.mentions"></textarea></div>
              </div>
            </section>
          }

          <section class="card">
            <wk-paper-form [declaration]="uuid" [editable]="true" />
          </section>

          <section class="card">
            <div class="card-title"><h2>Établissement de santé</h2></div>
            <div class="form-grid">
              <div class="field need" [class.missing]="miss('hospital')"><label>Établissement</label>
                <select class="input" name="hospital" [(ngModel)]="m.hospital" [class.invalid]="err('hospital')">
                  <option [ngValue]="null">— Non identifié —</option>
                  @for (h of hospitals(); track h.uuid) { <option [ngValue]="h.uuid">{{ h.name }} ({{ h.code }})</option> }
                </select><span class="field-error">{{ err('hospital') }}</span></div>
              <div class="field"><label>Référence du document hospitalier</label><input class="input" name="ref" [(ngModel)]="m.hospital_document_ref" /></div>
              <div class="field"><label>Médecin</label><input class="input" name="doc" [(ngModel)]="m.doctor_name" /></div>
              <div class="field"><label>Sage-femme</label><input class="input" name="mw" [(ngModel)]="m.midwife_name" /></div>
            </div>
          </section>

          <section class="card">
            <div class="card-title"><h2>Enfant</h2></div>
            <div class="form-grid">
              <div class="field need" [class.missing]="miss('child.first_names')"><label>Prénoms</label><input class="input" name="c_fn" [(ngModel)]="m.child.first_names" /></div>
              <div class="field need" [class.missing]="miss('child.last_name')"><label>Nom</label><input class="input" name="c_ln" [(ngModel)]="m.child.last_name" /></div>
              <div class="field need" [class.missing]="miss('child.gender')"><label class="req">Sexe</label>
                <select class="input" name="c_g" [(ngModel)]="m.child.gender" required [class.invalid]="err('child.gender')"><option value="">—</option><option value="M">Masculin</option><option value="F">Féminin</option></select>
                <span class="field-error">{{ err('child.gender') }}</span></div>
              <div class="field need" [class.missing]="miss('child.nationality')"><label>Nationalité</label><input class="input" wkNationality name="c_na" [(ngModel)]="m.child.nationality" /></div>
              <div class="field"><label>NPI</label><input class="input" name="c_npi" autocomplete="off" spellcheck="false" [(ngModel)]="m.child.npi" /></div>
              <div class="field need" [class.missing]="miss('birth_date')"><label class="req">Date de naissance</label><input class="input" type="date" name="bd" [(ngModel)]="m.birth_date" min="1900-01-01" [max]="today" required [class.invalid]="err('birth_date')" />
                @if (m.birth_date) { <small class="letters">{{ m.birth_date | dateLetters }}</small> }
                <span class="field-error">{{ err('birth_date') }}</span></div>
              <div class="field need" [class.missing]="miss('birth_time')"><label class="req">Heure de naissance</label><input class="input" type="time" name="bt" [(ngModel)]="m.birth_time" required [class.invalid]="err('birth_time')" /><span class="field-error">{{ err('birth_time') }}</span></div>
              <div class="field need" [class.missing]="miss('birth_place')"><label class="req">Lieu de naissance</label><input class="input" name="bp" [(ngModel)]="m.birth_place" required [class.invalid]="err('birth_place')" /><span class="field-error">{{ err('birth_place') }}</span></div>
              <div class="field need" [class.missing]="miss('child.birth_rank')"><label>Rang de naissance chez la mère</label><input class="input" wkInteger min="1" max="30" name="c_rank" [(ngModel)]="m.child.birth_rank" placeholder="1 = premier enfant" [class.invalid]="err('child.birth_rank')" /><span class="field-error">{{ err('child.birth_rank') }}</span></div>
            </div>
            <wk-nationality-list />
          </section>

          <section class="card">
            <div class="card-title"><h2>Père</h2>
              <label class="check"><input type="checkbox" name="hasF" [(ngModel)]="hasFather" [disabled]="sec" /> {{ sec ? 'Père obligatoire' : 'Renseigner le père' }}</label></div>
            @if (hasFather) {
              <div class="form-grid">
                <div class="field need" [class.missing]="miss('father.first_names')"><label>Prénoms</label><input class="input" name="f_fn" [(ngModel)]="m.father.first_names" /></div>
                <div class="field need" [class.missing]="miss('father.last_name')"><label>Nom</label><input class="input" name="f_ln" [(ngModel)]="m.father.last_name" /></div>
                <div class="field need" [class.missing]="miss('father.date_of_birth')"><label>Date de naissance</label><input class="input" type="date" name="f_dob" [ngModel]="m.father.date_of_birth" (ngModelChange)="m.father.date_of_birth = $event; fillAge(m.father)" min="1900-01-01" [max]="today" [class.invalid]="err('father.date_of_birth')" />
                  @if (m.father.date_of_birth) { <small class="letters">{{ m.father.date_of_birth | dateLetters }}</small> }</div>
                <div class="field need" [class.missing]="miss('father.birth_place')"><label>Lieu de naissance</label><input class="input" name="f_bp" [(ngModel)]="m.father.birth_place" /></div>
                <div class="field need" [class.missing]="miss('father.age')"><label>Âge</label><input class="input" wkInteger min="0" max="120" name="f_age" title="Calculé à partir de la date de naissance ; vous pouvez le corriger" [(ngModel)]="m.father.age" [class.invalid]="err('father.age')" /><span class="field-error">{{ err('father.age') }}</span></div>
                <div class="field need" [class.missing]="miss('father.profession')"><label>Profession</label><input class="input" name="f_pr" [(ngModel)]="m.father.profession" /></div>
                <div class="field need" [class.missing]="miss('father.nationality')"><label>Nationalité</label><input class="input" wkNationality name="f_na" [(ngModel)]="m.father.nationality" /></div>
                <div class="field need" [class.missing]="miss('father.marital_status')"><label>Situation matrimoniale</label>
                  <select class="input" name="f_ms" [(ngModel)]="m.father.marital_status"><option value="">—</option>@for (o of marital; track o.v) { <option [value]="o.v">{{ o.l }}</option> }</select></div>
                <div class="field"><label>NPI</label><input class="input" name="f_npi" autocomplete="off" spellcheck="false" [(ngModel)]="m.father.npi" /></div>
                <div class="field need" [class.missing]="miss('father.phone')"><label>Téléphone</label><input class="input" wkPhone name="f_ph" #fph="ngModel" [(ngModel)]="m.father.phone" [class.invalid]="err('father.phone') || (fph.touched && phoneError(m.father.phone))" />
                  <span class="field-error">{{ err('father.phone') || (fph.touched ? phoneError(m.father.phone) : '') }}</span></div>
                <div class="field wide need" [class.missing]="miss('father.address')"><label>Domicile</label><input class="input" name="f_ad" [(ngModel)]="m.father.address" /></div>
              </div>
            } @else { <p class="muted">Père non renseigné (inconnu ou absent).</p> }
          </section>

          <section class="card">
            <div class="card-title"><h2>Mère</h2></div>
              <div class="form-grid">
                <div class="field need" [class.missing]="miss('mother.first_names')"><label>Prénoms</label><input class="input" name="m_fn" [(ngModel)]="m.mother.first_names" /></div>
                <div class="field need" [class.missing]="miss('mother.last_name')"><label>Nom</label><input class="input" name="m_ln" [(ngModel)]="m.mother.last_name" /></div>
                <div class="field need" [class.missing]="miss('mother.date_of_birth')"><label>Date de naissance</label><input class="input" type="date" name="m_dob" [ngModel]="m.mother.date_of_birth" (ngModelChange)="m.mother.date_of_birth = $event; fillAge(m.mother)" min="1900-01-01" [max]="today" [class.invalid]="err('mother.date_of_birth')" />
                  @if (m.mother.date_of_birth) { <small class="letters">{{ m.mother.date_of_birth | dateLetters }}</small> }</div>
                <div class="field need" [class.missing]="miss('mother.birth_place')"><label>Lieu de naissance</label><input class="input" name="m_bp" [(ngModel)]="m.mother.birth_place" /></div>
                <div class="field need" [class.missing]="miss('mother.age')"><label>Âge</label><input class="input" wkInteger min="0" max="120" name="m_age" title="Calculé à partir de la date de naissance ; vous pouvez le corriger" [(ngModel)]="m.mother.age" [class.invalid]="err('mother.age')" /><span class="field-error">{{ err('mother.age') }}</span></div>
                <div class="field need" [class.missing]="miss('mother.profession')"><label>Profession</label><input class="input" name="m_pr" [(ngModel)]="m.mother.profession" /></div>
                <div class="field need" [class.missing]="miss('mother.nationality')"><label>Nationalité</label><input class="input" wkNationality name="m_na" [(ngModel)]="m.mother.nationality" /></div>
                <div class="field need" [class.missing]="miss('mother.marital_status')"><label>Situation matrimoniale</label>
                  <select class="input" name="m_ms" [(ngModel)]="m.mother.marital_status"><option value="">—</option>@for (o of marital; track o.v) { <option [value]="o.v">{{ o.l }}</option> }</select></div>
                <div class="field"><label>NPI</label><input class="input" name="m_npi" autocomplete="off" spellcheck="false" [(ngModel)]="m.mother.npi" /></div>
                <div class="field need" [class.missing]="miss('mother.phone')"><label>Téléphone</label><input class="input" wkPhone name="m_ph" #mph="ngModel" [(ngModel)]="m.mother.phone" [class.invalid]="err('mother.phone') || (mph.touched && phoneError(m.mother.phone))" />
                  <span class="field-error">{{ err('mother.phone') || (mph.touched ? phoneError(m.mother.phone) : '') }}</span></div>
                <div class="field wide need" [class.missing]="miss('mother.address')"><label>Domicile</label><input class="input" name="m_ad" [(ngModel)]="m.mother.address" /></div>
              </div>
          </section>

          <section class="card">
            <div class="card-title"><h2>Déclarant</h2></div>
            <fieldset class="who" [class.missing]="miss('declarant.mode')">
              <legend>Le déclarant est :</legend>
              <label class="choice" [class.on]="declarantMode === 'father'"><input type="radio" name="dmode" value="father" [ngModel]="declarantMode" (ngModelChange)="setDeclarantMode($event)" /> Le père</label>
              <label class="choice" [class.on]="declarantMode === 'mother'"><input type="radio" name="dmode" value="mother" [ngModel]="declarantMode" (ngModelChange)="setDeclarantMode($event)" /> La mère</label>
              <label class="choice" [class.on]="declarantMode === 'other'"><input type="radio" name="dmode" value="other" [ngModel]="declarantMode" (ngModelChange)="setDeclarantMode($event)" /> Une autre personne</label>
            </fieldset>

            @if (declarantMode === 'father' || declarantMode === 'mother') {
              <div class="loaded">
                @if (declarantFromParent(); as p) {
                  <strong>Informations reprises automatiquement {{ declarantMode === 'father' ? 'du père' : 'de la mère' }} :</strong>
                  <span>{{ p.first_names }} {{ p.last_name }}@if (p.nationality) { · {{ p.nationality }}}@if (p.profession) { · {{ p.profession }}}@if (p.address) { · {{ p.address }}}@if (p.phone) { · {{ p.phone }}}</span>
                } @else {
                  <span class="warn">Renseignez d'abord le nom {{ declarantMode === 'father' ? 'du père' : 'de la mère' }} ci-dessus : ses informations seront reprises comme déclarant.</span>
                }
              </div>
            } @else if (declarantMode === 'other') {
              <div class="form-grid">
                <div class="field need" [class.missing]="miss('declarant.first_names')"><label>Prénoms</label><input class="input" name="d_fn" [(ngModel)]="m.declarant.first_names" /></div>
                <div class="field need" [class.missing]="miss('declarant.last_name')"><label>Nom</label><input class="input" name="d_ln" [(ngModel)]="m.declarant.last_name" /></div>
                <div class="field need" [class.missing]="miss('declarant.relationship')"><label>Lien avec l'enfant</label><input class="input" name="d_rel" [(ngModel)]="m.declarant.relationship" placeholder="Grand-père, tante, tuteur…" /></div>
                <div class="field need" [class.missing]="miss('declarant.profession')"><label>Profession</label><input class="input" name="d_pr" [(ngModel)]="m.declarant.profession" /></div>
                <div class="field need" [class.missing]="miss('declarant.nationality')"><label>Nationalité</label><input class="input" wkNationality name="d_na" [(ngModel)]="m.declarant.nationality" /></div>
                <div class="field need" [class.missing]="miss('declarant.marital_status')"><label>Situation matrimoniale</label>
                  <select class="input" name="d_ms" [(ngModel)]="m.declarant.marital_status"><option value="">—</option>@for (o of marital; track o.v) { <option [value]="o.v">{{ o.l }}</option> }</select></div>
                <div class="field"><label>NPI</label><input class="input" name="d_npi" autocomplete="off" spellcheck="false" [(ngModel)]="m.declarant.npi" /></div>
                <div class="field need" [class.missing]="miss('declarant.phone')"><label>Téléphone</label><input class="input" wkPhone name="d_ph" #dph="ngModel" [(ngModel)]="m.declarant.phone" [class.invalid]="err('declarant.phone') || (dph.touched && phoneError(m.declarant.phone))" />
                  <span class="field-error">{{ err('declarant.phone') || (dph.touched ? phoneError(m.declarant.phone) : '') }}</span></div>
                <div class="field wide need" [class.missing]="miss('declarant.address')"><label>Domicile</label><input class="input" name="d_ad" [(ngModel)]="m.declarant.address" /></div>
              </div>
            } @else { <p class="muted">{{ sec ? 'Indiquez qui fait la déclaration : le père, la mère ou une autre personne.' : 'Cochez qui fait la déclaration. Sans choix, le secrétariat le renseignera en présence des parents.' }}</p> }
          </section>

          <section class="card">
            <div class="field"><label>Observations</label><textarea class="input" name="notes" [(ngModel)]="m.notes"></textarea></div>
          </section>

          <div class="actions">
            <button class="btn" type="submit" [disabled]="busy()">
              @if (busy() && action === 'draft') { <span class="spinner dark"></span> }
              {{ uuid ? 'Enregistrer les modifications' : 'Enregistrer le brouillon' }}
            </button>
            @if (canTransmit) {
              <button class="btn btn-primary" type="button" [disabled]="busy()" (click)="save('transmit')">
                @if (busy() && action === 'transmit') { <span class="spinner"></span> }
                <wk-icon name="arrow" [size]="16" /> Enregistrer et transmettre au secrétariat
              </button>
            }
            @if (canSubmit) {
              <button class="btn btn-primary" type="button" [disabled]="busy()" (click)="save('validate')">
                @if (busy() && action === 'validate') { <span class="spinner"></span> }
                <wk-icon name="shield" [size]="16" /> Enregistrer et envoyer à la validation de l'administrateur
              </button>
            }
          </div>
        </form>
      } @else { <div class="card"><div class="skeleton" style="height:240px"></div></div> }
    </div>
  `,
  styles: ['.geo{display:grid;gap:14px}.pick{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px}.pick .input{flex:1 1 220px;min-width:0}.pick .opt{display:inline-flex;align-items:center;gap:6px;font-weight:500;color:var(--wk-text);cursor:pointer}.pick .de{font-weight:600;color:var(--wk-text-soft)}.sec .need>label:not(.req)::after{content:" *";color:var(--wk-danger)}.field.missing .input{border-color:var(--wk-danger);background:#fff7f7}.who.missing{outline:2px solid var(--wk-danger);outline-offset:6px;border-radius:12px}.hint{color:var(--wk-text-mute);font-size:12px}.letters{display:block;margin-top:4px;color:var(--wk-royal);font-weight:600;font-size:13px}.who{border:0;margin:0 0 14px;padding:0;display:flex;gap:10px;flex-wrap:wrap;align-items:center}.who legend{float:left;margin-right:12px;font-weight:600;padding:0}.choice{display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border:1px solid var(--wk-border);border-radius:999px;cursor:pointer;background:#fff}.choice.on{border-color:var(--wk-royal);background:var(--wk-info-bg);color:var(--wk-royal);font-weight:600}.loaded{display:flex;flex-direction:column;gap:4px;padding:12px 14px;border-radius:12px;background:var(--wk-info-bg);margin-bottom:14px;font-size:14px}.loaded .warn{color:var(--wk-warning)}.stack{display:flex;flex-direction:column;gap:16px}.actions{display:flex;gap:12px;flex-wrap:wrap;justify-content:flex-end;position:sticky;bottom:0;padding:12px 0;background:linear-gradient(transparent,var(--wk-bg) 30%)}'],
})
export class DeclarationFormComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);
  private auth = inject(AuthService);

  @ViewChild(PaperFormComponent) paper?: PaperFormComponent;

  uuid = '';
  ref = '';
  status = 'DRAFT';
  today = new Date().toISOString().slice(0, 10);
  loaded = signal(false);
  busy = signal(false);
  error = signal('');
  errors = signal<Record<string, string>>({});
  hospitals = signal<Hospital[]>([]);
  hasFather = false;
  /** Who makes the declaration: the father / the mother (their data are reused) or someone else. */
  declarantMode: '' | 'father' | 'mother' | 'other' = '';
  action: 'draft' | 'transmit' | 'validate' = 'draft';
  canTransmit = true;
  canSubmit = false;
  /** Secretariat (or validator) editing a transmitted dossier: the registry header comes first and the fields are required. */
  sec = false;
  /** Turned on by an attempt to send the dossier to validation: shows which required fields are still empty. */
  showMissing = false;
  marital = MARITAL;

  m: any = {
    hospital: null, hospital_document_ref: '', doctor_name: '', midwife_name: '', birth_date: '', birth_time: '', birth_place: '', notes: '',
    child: { first_names: '', last_name: '', gender: '', nationality: '', npi: '', birth_rank: null },
    mother: blankPerson(), father: blankPerson(),
    declarant: blankDeclarant(),
    acte: { annee: null, registre: '', feuillet: '', numero_acte: '', region: '', prefecture: '', commune_type: '', commune: '', centre_type: '', centre: '', declaration_date: '', officer_name: '', mentions: '' },
  };

  err(k: string) { return this.errors()[k] ?? ''; }

  /** The age follows the birth date as soon as it is typed; the field stays editable afterwards. */
  fillAge(p: PersonForm) { const a = ageFromBirthDate(p.date_of_birth); if (a !== null) p.age = a; }
  phoneError = phoneError;

  ngOnInit() {
    this.uuid = this.route.snapshot.paramMap.get('uuid') ?? '';
    this.api.get<Page<Hospital>>('/hospitals/', { is_active: true, page_size: 100 }).subscribe({ next: p => this.hospitals.set(p.results), error: () => undefined });
    if (!this.uuid) { this.hasFather = true; this.loaded.set(true); return; }  // the father is asked first
    this.api.get<DeclarationDetail>(`/declarations/${this.uuid}/`).subscribe({
      next: d => {
        this.ref = d.reference; this.status = d.status;
        if (!d.can_edit) { this.toast.error("Ce dossier ne peut pas être modifié dans son état actuel."); this.router.navigate(['/declarations', d.uuid]); return; }
        this.canTransmit = d.available_transitions.some(t => t.target === 'TRANSMITTED');
        this.canSubmit = d.available_transitions.some(t => t.target === 'PENDING_VALIDATION');
        Object.assign(this.m, {
          hospital: d.hospital, hospital_document_ref: d.hospital_document_ref, doctor_name: d.doctor_name, midwife_name: d.midwife_name,
          birth_date: d.birth_date, birth_time: d.birth_time?.slice(0, 5) ?? '', birth_place: d.birth_place, notes: d.notes,
        });
        if (d.child) Object.assign(this.m.child, this.clean(d.child, ['birth_rank']));
        if (d.mother) Object.assign(this.m.mother, this.clean(d.mother));
        if (d.father) { Object.assign(this.m.father, this.clean(d.father)); this.hasFather = true; }
        if (d.declarant) {
          Object.assign(this.m.declarant, this.clean(d.declarant));
          const rel = (d.declarant.relationship ?? '').trim().toLowerCase();
          this.declarantMode = /^p[èe]re$/.test(rel) ? 'father' : /^m[èe]re$/.test(rel) ? 'mother' : 'other';
        }
        this.sec = this.auth.can('acte.update') && ACTE_STATUSES.includes(d.status);
        if (!this.sec) { this.loaded.set(true); return; }
        this.hasFather = true;  // the father's data are mandatory at the secretariat
        this.loadActe(d);
      },
      error: e => { this.error.set(errorMessage(e)); this.loaded.set(true); },
    });
  }

  /** Registry header of the dossier, with the defaults the secretariat would otherwise retype. */
  private loadActe(d: DeclarationDetail) {
    const fill = (a: Partial<Acte> | null) => {
      const keys = Object.keys(this.m.acte);
      keys.forEach(k => (this.m.acte[k] = (a as any)?.[k] ?? ''));
      this.m.acte.annee = a?.annee ?? null;
      const def: Record<string, string> = DEFAULT_ACTE;
      Object.keys(def).forEach(k => { if (!this.m.acte[k]) this.m.acte[k] = def[k]; });
      if (!this.m.acte.annee && d.birth_date) this.m.acte.annee = Number(d.birth_date.slice(0, 4));
      if (!this.m.acte.declaration_date) this.m.acte.declaration_date = this.today;
      this.loaded.set(true);
    };
    if (!d.acte_uuid) { fill(null); return; }
    this.api.get<Acte>(`/actes/${d.acte_uuid}/`).subscribe({ next: a => fill(a), error: () => fill(null) });
  }

  /**
   * Changing who declares. « Une autre personne » always starts from empty fields to fill in: whatever was copied from
   * the father or the mother (or typed for another person before) is not carried over.
   */
  setDeclarantMode(mode: '' | 'father' | 'mother' | 'other') {
    if (mode === 'other' && this.declarantMode !== 'other') this.m.declarant = blankDeclarant();
    this.declarantMode = mode;
  }

  private empty(v: unknown) { return v === null || v === undefined || String(v).trim() === ''; }

  /** Current value of a required field, read the way it will be sent. */
  private valueOf(key: string): unknown {
    const m = this.m;
    const [scope, field] = key.includes('.') ? key.split('.') : ['', key];
    if (!scope) return m[field];
    if (scope === 'child') return m.child[field];
    if (scope === 'acte') return m.acte[field];
    if (scope === 'mother') return m.mother[field];
    if (scope === 'father') return this.hasFather ? m.father[field] : '';
    if (scope === 'declarant') {
      if (field === 'mode') return this.declarantMode;
      if (this.declarantMode === 'other') return m.declarant[field];
      if (field === 'relationship') return this.declarantMode;  // « Père » / « Mère » is set automatically
      return (this.declarantFromParent() as any)?.[field] ?? '';
    }
    return '';
  }

  /** True when this required field is empty and the user already tried to send the dossier to validation. */
  miss(key: string) { return this.showMissing && this.empty(this.valueOf(key)); }

  private missingKeys() { return SUBMISSION_KEYS.filter(k => this.empty(this.valueOf(k))); }

  private clean(o: any, keepNull: string[] = []) { return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v ?? (keepNull.includes(k) ? null : '')])); }

  /** A parent section left empty is not saved as a (blank) parent. */
  private isBlank(p: PersonForm) { return ![p.first_names, p.last_name, p.age, p.profession, p.nationality, p.npi, p.address, p.phone, p.date_of_birth, p.birth_place].some(v => v !== '' && v !== null && v !== undefined); }

  /** The parent whose data are reused as declarant (null when the section is still empty). */
  declarantFromParent(): PersonForm | null {
    const p: PersonForm | undefined = this.declarantMode === 'father' ? (this.hasFather ? this.m.father : undefined) : this.declarantMode === 'mother' ? this.m.mother : undefined;
    return p && (p.first_names || p.last_name) ? p : null;
  }

  private person(p: PersonForm) {
    return { ...p, age: nullIfEmpty(p.age), date_of_birth: nullIfEmpty(p.date_of_birth) };
  }

  private declarantPayload() {
    if (this.declarantMode === 'other') return { ...this.m.declarant };
    const p = this.declarantFromParent();
    if (!p) return this.uuid ? undefined : null;
    return {
      first_names: p.first_names, last_name: p.last_name, nationality: p.nationality, npi: p.npi, marital_status: p.marital_status, profession: p.profession, phone: p.phone, address: p.address,
      relationship: this.declarantMode === 'father' ? 'Père' : 'Mère',
    };
  }

  private actePayload() {
    const a = this.m.acte;
    return {
      annee: nullIfEmpty(a.annee), registre: a.registre, feuillet: a.feuillet, numero_acte: (a.numero_acte ?? '').trim(),
      region: a.region, prefecture: a.prefecture, commune_type: a.commune_type, commune: a.commune, centre_type: a.centre_type, centre: a.centre, declaration_date: nullIfEmpty(a.declaration_date), officer_name: a.officer_name, mentions: a.mentions,
    };
  }

  private payload() {
    const m = this.m;
    const body: any = {
      hospital: m.hospital, hospital_document_ref: m.hospital_document_ref, doctor_name: m.doctor_name, midwife_name: m.midwife_name,
      birth_date: m.birth_date, birth_time: nullIfEmpty(m.birth_time), birth_place: m.birth_place, notes: m.notes,
      child: { ...m.child, birth_rank: nullIfEmpty(m.child.birth_rank) },
      mother: this.person(m.mother),
      father: this.hasFather && !this.isBlank(m.father) ? this.person(m.father) : (this.uuid ? undefined : null),
      declarant: this.declarantMode ? this.declarantPayload() : (this.uuid ? undefined : null),
      acte: this.sec ? this.actePayload() : undefined,
    };
    Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
    return body;
  }

  /** Client-side checks that mirror the API rules (the API stays the authority). */
  private validate(): Record<string, string> {
    const e: Record<string, string> = {};
    const m = this.m;
    if (!m.birth_date) e['birth_date'] = 'La date de naissance est requise.';
    else if (m.birth_date > this.today) e['birth_date'] = 'La date de naissance ne peut pas être dans le futur.';
    if (!m.birth_time) e['birth_time'] = "L'heure de naissance est requise.";
    if (!(m.birth_place ?? '').trim()) e['birth_place'] = 'Le lieu de naissance est requis.';
    if (!m.child.gender) e['child.gender'] = "Le sexe de l'enfant est requis.";
    const people: [string, PersonForm, boolean][] = [['mother', m.mother, true], ['father', m.father, this.hasFather]];
    for (const [key, p, active] of people) {
      if (!active) continue;
      const ph = phoneError(p.phone); if (ph) e[`${key}.phone`] = ph;
      if (p.age !== null && p.age !== undefined && (p.age < 0 || p.age > 120)) e[`${key}.age`] = 'Âge compris entre 0 et 120 ans.';
      if (p.date_of_birth && p.date_of_birth > this.today) e[`${key}.date_of_birth`] = 'La date de naissance ne peut pas être dans le futur.';
    }
    if (this.declarantMode === 'other') { const ph = phoneError(m.declarant.phone); if (ph) e['declarant.phone'] = ph; }
    const rank = m.child.birth_rank;
    if (rank !== null && rank !== undefined && rank !== '' && (rank < 1 || rank > 30)) e['child.birth_rank'] = 'Rang compris entre 1 et 30.';
    return e;
  }

  save(action: 'draft' | 'transmit' | 'validate' = 'draft') {
    this.error.set(''); this.errors.set({});
    const problems = this.validate();
    if (Object.keys(problems).length) { this.errors.set(problems); this.error.set('Veuillez corriger les champs signalés.'); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (action === 'validate') {
      this.showMissing = true;
      const missing = this.missingKeys();
      if (missing.length) {
        this.error.set(`${missing.length} information(s) obligatoire(s) manquante(s), marquées en rouge : le dossier n'a pas été envoyé à la validation. « Enregistrer les modifications » conserve votre saisie.`);
        setTimeout(() => document.querySelector('.field.missing, .who.missing')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
        return;
      }
    }
    this.busy.set(true); this.action = action;
    const req = this.uuid ? this.api.patch<DeclarationDetail>(`/declarations/${this.uuid}/`, this.payload()) : this.api.post<DeclarationDetail>('/declarations/', this.payload());
    req.subscribe({
      next: async d => {
        // New dossier: the photos taken before saving are attached now that the dossier exists.
        const failed = this.uuid ? 0 : (await this.paper?.uploadPending(d.uuid)) ?? 0;
        if (failed) this.toast.error(`${failed} fichier(s) de la fiche n'ont pas pu être joints : rouvrez le dossier pour les ajouter à nouveau.`);
        if (action === 'draft') { this.busy.set(false); this.toast.success(this.uuid ? 'Modifications enregistrées.' : `Brouillon ${d.reference} enregistré.`); this.router.navigate(['/declarations', d.uuid]); return; }
        const target = action === 'transmit' ? 'TRANSMITTED' : 'PENDING_VALIDATION';
        this.api.post<DeclarationDetail>(`/declarations/${d.uuid}/transition/`, { status: target }).subscribe({
          next: () => {
            this.busy.set(false);
            this.toast.success(action === 'transmit' ? `Déclaration ${d.reference} transmise au secrétariat.` : `Dossier ${d.reference} envoyé à la validation de l'administrateur.`);
            this.router.navigate(['/declarations', d.uuid]);
          },
          error: e => {
            this.busy.set(false);
            this.error.set((action === 'transmit' ? 'Enregistrée, mais non transmise : ' : 'Enregistré, mais non envoyé à la validation : ') + errorMessage(e));
            window.scrollTo({ top: 0, behavior: 'smooth' });
            if (!this.uuid) this.router.navigate(['/declarations', d.uuid, 'edit']);
          },
        });
      },
      error: e => {
        this.busy.set(false); const fe = fieldErrors(e); this.errors.set(fe);
        this.error.set(Object.keys(fe).length ? 'Veuillez corriger les champs signalés.' : errorMessage(e));
        window.scrollTo({ top: 0, behavior: 'smooth' });
      },
    });
  }
}
