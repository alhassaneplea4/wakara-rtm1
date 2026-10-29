import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, errorMessage, fieldErrors } from '../core/api.service';
import { Acte, DeclarationDetail } from '../core/models';
import { ToastService } from '../core/toast.service';
import { PageHeaderComponent } from '../shared/ui';

@Component({
  selector: 'wk-acte-form', standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, PageHeaderComponent],
  template: `
    <div class="page">
      <wk-page-header title="Complément de l'acte" [subtitle]="ref + ' · ' + childName">
        <a class="btn" [routerLink]="['/declarations', uuid]">Retour au dossier</a>
      </wk-page-header>
      @if (error()) { <div class="alert alert-danger" role="alert" style="margin-bottom:16px">{{ error() }}</div> }
      <div class="alert alert-info" style="margin-bottom:16px">
        Les références du registre et le <strong>numéro officiel</strong> sont confirmés par l'administrateur technique lors de la validation.
        L'identité de l'enfant, des parents et du déclarant se modifie depuis <a [routerLink]="['/declarations', uuid, 'edit']">la fiche du dossier</a>.
      </div>
      @if (a(); as a) {
        <form class="stack" (ngSubmit)="save()">
          <section class="card">
            <div class="card-title"><h2>Références du registre</h2></div>
            <div class="form-grid">
              <div class="field"><label>Année</label><input class="input" type="number" name="annee" [(ngModel)]="m.annee" [disabled]="!a.can_edit" /></div>
              <div class="field"><label>Registre</label><input class="input" name="registre" [(ngModel)]="m.registre" [disabled]="!a.can_edit" /></div>
              <div class="field"><label>Feuillet</label><input class="input" name="feuillet" [(ngModel)]="m.feuillet" [disabled]="!a.can_edit" /></div>
              <div class="field"><label>N° officiel de l'acte</label><input class="input" [value]="a.numero_acte || 'Non attribué'" disabled /></div>
            </div>
          </section>
          <section class="card">
            <div class="card-title"><h2>Circonscription administrative</h2></div>
            <div class="form-grid">
              <div class="field"><label>Région</label><input class="input" name="region" [(ngModel)]="m.region" [disabled]="!a.can_edit" /></div>
              <div class="field"><label>Préfecture</label><input class="input" name="prefecture" [(ngModel)]="m.prefecture" [disabled]="!a.can_edit" /></div>
              <div class="field"><label>Commune</label><input class="input" name="commune" [(ngModel)]="m.commune" [disabled]="!a.can_edit" /></div>
              <div class="field"><label>Centre</label><input class="input" name="centre" [(ngModel)]="m.centre" [disabled]="!a.can_edit" /></div>
            </div>
          </section>
          <section class="card">
            <div class="card-title"><h2>Déclaration et mentions</h2></div>
            <div class="form-grid">
              <div class="field"><label class="req">Date de déclaration</label><input class="input" type="date" name="dd" [(ngModel)]="m.declaration_date" [disabled]="!a.can_edit" [class.invalid]="errs()['declaration_date']" />
                <span class="field-error">{{ errs()['declaration_date'] }}</span></div>
              <div class="field"><label>Officier d'état civil (mention)</label><input class="input" name="officer" [(ngModel)]="m.officer_name" [disabled]="!a.can_edit" /></div>
              <div class="field wide"><label>Mentions</label><textarea class="input" name="mentions" [(ngModel)]="m.mentions" [disabled]="!a.can_edit"></textarea></div>
            </div>
          </section>
          @if (a.can_edit) {
            <div class="actions">
              <button class="btn" type="submit" [disabled]="busy()">Enregistrer</button>
              @if (canSubmit()) { <button class="btn btn-primary" type="button" [disabled]="busy()" (click)="saveAndSubmit()">Enregistrer et soumettre à validation</button> }
            </div>
          } @else { <div class="alert alert-warning">Ce dossier n'est pas modifiable dans son état actuel.</div> }
        </form>
      } @else { <div class="card"><div class="skeleton" style="height:240px"></div></div> }
    </div>
  `,
  styles: ['.stack{display:flex;flex-direction:column;gap:16px}.actions{display:flex;gap:12px;justify-content:flex-end;flex-wrap:wrap}'],
})
export class ActeFormComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);

  uuid = '';
  ref = ''; childName = '';
  a = signal<Acte | null>(null);
  d = signal<DeclarationDetail | null>(null);
  busy = signal(false);
  error = signal('');
  errs = signal<Record<string, string>>({});
  m: any = { annee: null, registre: '', feuillet: '', region: '', prefecture: '', commune: '', centre: '', declaration_date: '', officer_name: '', mentions: '' };

  canSubmit = () => !!this.d()?.available_transitions.some(t => t.target === 'PENDING_VALIDATION');

  ngOnInit() {
    this.uuid = this.route.snapshot.paramMap.get('uuid')!;
    this.api.get<DeclarationDetail>(`/declarations/${this.uuid}/`).subscribe({
      next: d => {
        this.d.set(d); this.ref = d.reference; this.childName = d.child_name;
        if (!d.acte_uuid) { this.error.set("Le dossier n'a pas encore été pris en charge par le secrétariat : aucun acte à compléter."); return; }
        this.api.get<Acte>(`/actes/${d.acte_uuid}/`).subscribe({
          next: a => { this.a.set(a); Object.keys(this.m).forEach(k => (this.m[k] = (a as any)[k] ?? '')); this.m.annee = a.annee; },
          error: e => this.error.set(errorMessage(e)),
        });
      },
      error: e => this.error.set(errorMessage(e)),
    });
  }

  private body() {
    return { ...this.m, annee: this.m.annee || null, declaration_date: this.m.declaration_date || null };
  }

  private persist(then?: () => void) {
    this.busy.set(true); this.error.set(''); this.errs.set({});
    this.api.patch<Acte>(`/actes/${this.a()!.uuid}/`, this.body()).subscribe({
      next: a => { this.busy.set(false); this.a.set(a); if (then) then(); else this.toast.success('Acte enregistré.'); },
      error: e => { this.busy.set(false); this.errs.set(fieldErrors(e)); this.error.set(errorMessage(e)); },
    });
  }

  save() { this.persist(); }

  saveAndSubmit() {
    this.persist(() => {
      this.busy.set(true);
      this.api.post(`/declarations/${this.uuid}/transition/`, { status: 'PENDING_VALIDATION' }).subscribe({
        next: () => { this.busy.set(false); this.toast.success('Dossier soumis à validation.'); this.router.navigate(['/declarations', this.uuid]); },
        error: e => { this.busy.set(false); this.error.set(errorMessage(e)); },
      });
    });
  }
}
