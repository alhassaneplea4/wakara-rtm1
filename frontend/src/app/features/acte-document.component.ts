import { CommonModule, DatePipe } from '@angular/common';
import { dateEnLettres, heureEnLettres } from '../core/date-letters';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { Acte, ActeDocument, Person } from '../core/models';
import { ToastService } from '../core/toast.service';
import { IconComponent, PageHeaderComponent } from '../shared/ui';

/**
 * Display-only copy of the acte, laid out like the paper form of the civil registry (« Acte de naissance »,
 * volet n° 1 — déclarant): header with the registry references, then the sections ENFANT, PARENTS (père, mère)
 * and DÉCLARANT. Nothing here can be edited. Until the dossier is validated the page carries a
 * "projet — sans valeur juridique" watermark and printing is not recorded.
 *
 * Boxes the data does not tell (commune urbaine/rurale, centre principal/secondaire, situation matrimoniale)
 * stay empty, as on a blank form: they can be ticked by hand once printed.
 */
@Component({
  selector: 'wk-acte-document', standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, DatePipe, IconComponent, PageHeaderComponent],
  template: `
    <div class="page">
      <div class="noprint"><wk-page-header title="Acte de naissance" [subtitle]="doc()?.reference ?? ''">
        @if (acte()) { <a class="btn" [routerLink]="['/declarations', acte()!.declaration_uuid]">Retour au dossier</a> }
        @if (doc()?.is_official && auth.can('acte.print')) { <button class="btn btn-primary" (click)="print()"><wk-icon name="print" [size]="16" /> Imprimer</button> }
        @if (doc()?.is_official && auth.can('acte.deliver')) { <button class="btn" (click)="deliveryOpen.set(true)"><wk-icon name="download" [size]="16" /> Enregistrer la délivrance</button> }
      </wk-page-header>
      @if (error()) { <div class="alert alert-danger" style="margin-bottom:16px">{{ error() }}</div> }
      @if (doc() && !doc()!.is_official) { <div class="alert alert-warning" style="margin-bottom:16px">Aperçu de travail : l'acte n'est pas encore validé définitivement. L'impression et la délivrance sont désactivées.</div> }
      </div>

      @if (prints().length) {
        <section class="card noprint" style="max-width:640px;margin:0 auto 16px">
          <div class="card-title"><h2>Historique des impressions</h2></div>
          @for (p of prints(); track p.printed_at) { <div class="prow"><span class="mono">{{ p.printed_at | date: 'dd/MM/yyyy HH:mm' }}</span><span>Exemplaire n° {{ p.copy_number }}</span><span class="soft">{{ p.printed_by_name }}</span></div> }
        </section>
      }

      @if (doc(); as d) {
        <article class="form" [class.draft]="!d.is_official" aria-label="Acte de naissance">
          @if (!d.is_official) { <div class="watermark" aria-hidden="true">PROJET — SANS VALEUR JURIDIQUE</div> }

          <header class="top">
            <div class="rep"><b>RÉPUBLIQUE DE GUINÉE</b><small>Travail · Justice · Solidarité</small></div>
            <dl class="refs">
              <div><dt>Année</dt><dd class="box">{{ d.annee ?? '' }}</dd></div>
              <div><dt>Registre</dt><dd class="box">{{ d.registre }}</dd></div>
              <div><dt>Feuillet</dt><dd class="box">{{ d.feuillet }}</dd></div>
              <div><dt>N° de l'acte</dt><dd class="box">{{ d.official_number ?? '' }}</dd></div>
            </dl>
            <h1>ACTE DE NAISSANCE</h1>
            <p class="volet"><b>Volet N°1</b> — Déclarant <small>(à remettre au déclarant)</small></p>
          </header>

          <div class="body">
            <p class="line"><span class="k">Région Administrative de :</span><span class="v uc">{{ d.region }}</span></p>
            <p class="line"><span class="k">Préfecture :</span><span class="v uc">{{ d.prefecture }}</span></p>
            <p class="line"><span class="k">Commune :</span><span class="opt"><i class="cb"></i>Urbaine</span><span class="opt"><i class="cb"></i>Rurale de :</span><span class="v uc">{{ d.commune }}</span></p>
            <p class="line"><span class="k">Centre :</span><span class="opt"><i class="cb"></i>Principal</span><span class="opt"><i class="cb"></i>Secondaire de :</span><span class="v uc">{{ d.centre }}</span></p>

            <h2 class="tag">ENFANT <span class="npi">NPI :</span><span class="v uc">{{ d.child.npi }}</span></h2>
            <p class="line"><span class="k">Prénoms :</span><span class="v uc">{{ d.child.first_names }}</span></p>
            <p class="line"><span class="k">Nom :</span><span class="v uc">{{ d.child.last_name }}</span></p>
            <p class="line"><span class="k">Sexe :</span><span class="v uc">{{ sexe(d.child.gender) }}</span></p>
            <p class="line"><span class="k">Date et heure de naissance <small>(en lettres)</small> :</span><span class="v">{{ naissance(d) }}</span></p>
            <p class="line"><span class="k">Lieu de naissance :</span><span class="v uc">{{ d.child.birth_place || d.hospital }}</span></p>
            <p class="line"><span class="k">Rang de naissance chez la mère :</span><span class="v">{{ rang(d.child.birth_rank) }}</span></p>
            <p class="line"><span class="k">Nationalité :</span><span class="v uc">{{ d.child.nationality }}</span></p>

            <h2 class="tag wide">PARENTS</h2>
            @for (r of parents(d); track r.title) {
              <h3 class="tag sub">{{ r.title }} <span class="npi">NPI :</span><span class="v uc">{{ r.p.npi }}</span></h3>
              <p class="line"><span class="k">Prénoms :</span><span class="v uc">{{ r.p.first_names }}</span></p>
              <p class="line"><span class="k">Nom :</span><span class="v uc">{{ r.p.last_name }}</span></p>
              <p class="line"><span class="k">Date de naissance <small>(en lettres)</small> :</span><span class="v">{{ lettres(r.p.date_of_birth) }}</span></p>
              <p class="line"><span class="k">Lieu de naissance :</span><span class="v uc">{{ r.p.birth_place }}</span></p>
              <p class="line"><span class="k">Nationalité :</span><span class="v uc">{{ r.p.nationality }}</span></p>
              <p class="line"><span class="k">Profession :</span><span class="v uc">{{ r.p.profession }}</span></p>
              <p class="line"><span class="k">Domicile :</span><span class="v uc">{{ r.p.address }}</span></p>
              <p class="line"><span class="k">Situation matrimoniale :</span><span class="opt"><i class="cb"></i>Célibataire</span><span class="opt"><i class="cb"></i>{{ r.married }}</span><span class="opt"><i class="cb"></i>{{ r.widowed }}</span></p>
              <p class="line"><span class="k">Téléphone :</span><span class="v">{{ r.p.phone }}</span></p>
            }

            <h2 class="tag wide">DÉCLARANT
              <span class="who"><span class="opt">Père<i class="cb" [class.on]="who(d) === 'father'"></i></span><span class="opt">Mère<i class="cb" [class.on]="who(d) === 'mother'"></i></span><span class="opt">Autre<i class="cb" [class.on]="who(d) === 'other'"></i></span></span></h2>
            <p class="line"><span class="k">NPI :</span><span class="v uc">{{ dec(d).npi }}</span></p>
            <p class="line"><span class="k">Prénoms :</span><span class="v uc">{{ dec(d).first_names }}</span></p>
            <p class="line"><span class="k">Nom :</span><span class="v uc">{{ dec(d).last_name }}</span></p>
            <p class="line"><span class="k">Date de naissance <small>(en lettres)</small> :</span><span class="v">{{ lettres(dec(d).date_of_birth) }}</span></p>
            <p class="line"><span class="k">Lieu de naissance :</span><span class="v uc">{{ dec(d).birth_place }}</span></p>
            <p class="line"><span class="k">Nationalité :</span><span class="v uc">{{ dec(d).nationality }}</span></p>
            <p class="line"><span class="k">Profession :</span><span class="v uc">{{ dec(d).profession }}</span></p>
            <p class="line"><span class="k">Domicile :</span><span class="v uc">{{ dec(d).address }}</span></p>
            <p class="line"><span class="k">Situation matrimoniale :</span><span class="opt"><i class="cb"></i>Célibataire</span><span class="opt"><i class="cb"></i>Marié(e)</span><span class="opt"><i class="cb"></i>Veuf(ve)</span></p>
            <p class="line"><span class="k">Téléphone :</span><span class="v">{{ dec(d).phone }}</span></p>
            <p class="line"><span class="k">Lien de parenté :</span><span class="v uc">{{ d.declarant?.relationship }}</span></p>
            <p class="line"><span class="k">Date de déclaration <small>(en lettres)</small> :</span><span class="v">{{ lettres(d.declaration_date) }}</span></p>

            @if (d.mentions) { <p class="line mentions"><span class="k">Mentions :</span><span class="v">{{ d.mentions }}</span></p> }
          </div>

          <footer>
            <p class="line at"><span class="k">À</span><span class="v uc">{{ d.commune }}</span><span class="k">le</span><span class="v date">{{ d.declaration_date ? (d.declaration_date | date: 'dd/MM/yyyy') : '' }}</span></p>
            <div class="sign"><span>Déclarant</span><span>L'Officier Délégué(e) de l'État Civil<br /><small>{{ d.officer_name }}</small></span></div>
          </footer>
        </article>
      }
    </div>

    @if (deliveryOpen()) {
      <div class="modal-backdrop noprint" (click)="deliveryOpen.set(false)">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Délivrance" (click)="$event.stopPropagation()">
          <h2>Enregistrer la délivrance</h2>
          <div class="form-grid">
            <div class="field wide"><label class="req">Remis à</label><input class="input" [(ngModel)]="dv.recipient_name" /></div>
            <div class="field"><label>Qualité</label><input class="input" [(ngModel)]="dv.recipient_relationship" /></div>
            <div class="field"><label>Pièce d'identité</label><input class="input" [(ngModel)]="dv.recipient_id_type" placeholder="Type" /></div>
            <div class="field"><label>N° de la pièce</label><input class="input" [(ngModel)]="dv.recipient_id_number" /></div>
            <div class="field wide"><label>Observations</label><textarea class="input" [(ngModel)]="dv.notes"></textarea></div>
          </div>
          <div class="modal-actions"><button class="btn" (click)="deliveryOpen.set(false)">Annuler</button>
            <button class="btn btn-primary" [disabled]="!dv.recipient_name.trim() || busy()" (click)="deliver()">Enregistrer</button></div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host{--ink:#142a5c;--rule:#2b4a7a;--paper:#e8f6f8;--tag:#b6dcf3}
    .form{position:relative;overflow:hidden;max-width:640px;margin:0 auto;padding:22px 26px 26px;color:#101828;border:1px solid #9cc7d6;box-shadow:var(--shadow-md);
      background:
        repeating-linear-gradient(115deg,rgba(120,190,205,.14) 0 2px,transparent 2px 9px),
        linear-gradient(180deg,#f2fbfc,var(--paper));
      -webkit-print-color-adjust:exact;print-color-adjust:exact;font-size:13.5px}
    .top{text-align:center}
    .rep{display:flex;flex-direction:column;align-items:center;line-height:1.25;font-size:12px}.rep small{font-size:11px;font-style:italic}
    .refs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:10px 0 6px;text-align:left}
    .refs div{display:flex;flex-direction:column;gap:2px}.refs dt{font-size:11px;font-weight:700}
    .refs dd{margin:0}.box{min-height:26px;background:#fff;border:1.5px solid var(--rule);padding:2px 6px;font-weight:700;color:var(--ink)}
    h1{margin:8px 0 2px;font-size:22px;letter-spacing:.06em;font-family:inherit;color:#0d1b3d}
    .volet{margin:0 0 10px;font-size:13px}.volet small{color:#44546a}
    .body{display:flex;flex-direction:column}
    .line{display:flex;align-items:baseline;gap:6px;margin:0;min-height:27px;border-bottom:1.5px solid var(--rule);padding:3px 0 1px}
    .k{white-space:nowrap;font-size:12.5px}.k small{font-size:10px}
    .v{flex:1;min-width:0;font-weight:700;color:var(--ink);letter-spacing:.01em;overflow-wrap:anywhere}
    .v.date{flex:0 0 120px;text-align:center}
    .opt{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;font-size:12.5px;margin:0 6px}
    .cb{display:inline-block;width:14px;height:14px;border:1.5px solid var(--rule);background:#fff;position:relative;flex:none}
    .cb.on::after{content:'';position:absolute;left:3px;top:-1px;width:5px;height:10px;border:solid var(--ink);border-width:0 2.5px 2.5px 0;transform:rotate(40deg)}
    .tag{display:flex;align-items:baseline;gap:10px;margin:14px 0 2px;padding:3px 10px;background:var(--tag);font-size:15px;font-weight:800;letter-spacing:.03em;font-family:inherit;color:#0d2a5c}
    .tag.wide{margin-top:16px}
    .tag.sub{background:transparent;padding:6px 0 0 24px;margin:6px 0 0;font-size:14px}
    .tag .npi{font-size:12.5px;font-weight:600}
    .tag .v{background:#fff0;border-bottom:1.5px solid var(--rule);min-height:20px;font-size:13.5px}
    .tag.sub .v{border-bottom:1.5px solid var(--rule)}
    .who{margin-left:auto;display:inline-flex;gap:8px;font-size:13px;font-weight:700}.who .opt{margin:0}
    footer{margin-top:14px}
    .at{border-bottom:0}.at .v{border-bottom:1.5px solid var(--rule)}.at .v.date{flex:0 0 120px}
    .sign{display:flex;justify-content:space-between;gap:16px;margin-top:34px;font-size:12.5px;font-weight:700;text-align:center}
    .sign small{font-weight:500}
    .watermark{position:absolute;inset:0;display:grid;place-items:center;font:700 40px/1.2 var(--wk-font);color:rgba(220,53,69,.17);transform:rotate(-24deg);pointer-events:none;text-align:center;padding:40px;z-index:2}
    .prow{display:flex;gap:16px;padding:6px 0;border-top:1px solid var(--wk-border)}
    .form.draft{border-style:dashed}
    @media (max-width:520px){.form{padding:16px 12px}.refs{grid-template-columns:repeat(2,minmax(0,1fr))}.k{white-space:normal}.line{flex-wrap:wrap}.v{flex:1 1 55%;min-width:130px}.v.date{flex:0 0 110px;min-width:0}.tag .v{flex:1 1 40%;min-width:100px}}
    @media print{.noprint{display:none!important}.page{padding:0}.form{border:0;box-shadow:none;max-width:none;margin:0}}
  `],
})
export class ActeDocumentComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private toast = inject(ToastService);
  auth = inject(AuthService);

  doc = signal<ActeDocument | null>(null);
  acte = signal<Acte | null>(null);
  prints = signal<{ printed_at: string; copy_number: number; printed_by_name: string }[]>([]);
  error = signal('');
  busy = signal(false);
  deliveryOpen = signal(false);
  dv = { recipient_name: '', recipient_relationship: '', recipient_id_type: '', recipient_id_number: '', notes: '' };
  private uuid = '';

  private static readonly NONE: Partial<Person> = {};

  lettres(iso: string | null | undefined) { return dateEnLettres(iso); }
  sexe(g: string) { return g === 'M' ? 'Masculin' : g === 'F' ? 'Féminin' : ''; }
  rang(n: number | null | undefined) { return n ? `${n}${n === 1 ? 'er' : 'e'} enfant` : ''; }

  /** « le quinze septembre deux mille vingt-six à huit heures trente » */
  naissance(d: ActeDocument) {
    const date = dateEnLettres(d.child.birth_date);
    const hour = heureEnLettres(d.child.birth_time);
    return date ? (hour ? `${date} à ${hour}` : date) : '';
  }

  /** The father and the mother, as the form lists them; an unknown parent leaves empty lines. */
  parents(d: ActeDocument) {
    return [
      { title: 'PÈRE', p: d.father ?? ActeDocumentComponent.NONE, married: 'Marié', widowed: 'Veuf' },
      { title: 'MÈRE', p: d.mother ?? ActeDocumentComponent.NONE, married: 'Mariée', widowed: 'Veuve' },
    ];
  }

  dec(d: ActeDocument): Partial<Person> { return d.declarant ?? ActeDocumentComponent.NONE; }

  /** Which box of « Déclarant : père / mère / autre » is ticked, from the declared relationship. */
  who(d: ActeDocument): 'father' | 'mother' | 'other' | '' {
    const rel = (d.declarant?.relationship ?? '').trim().toLowerCase();
    if (!rel) return d.declarant ? 'other' : '';
    return /^p[èe]re$/.test(rel) ? 'father' : /^m[èe]re$/.test(rel) ? 'mother' : 'other';
  }

  ngOnInit() {
    this.uuid = this.route.snapshot.paramMap.get('uuid')!;
    this.api.get<ActeDocument>(`/actes/${this.uuid}/document/`).subscribe({ next: d => this.doc.set(d), error: e => this.error.set(errorMessage(e)) });
    this.api.get<Acte>(`/actes/${this.uuid}/`).subscribe({ next: a => this.acte.set(a), error: () => undefined });
    this.loadPrints();
  }

  private loadPrints() { this.api.get<{ printed_at: string; copy_number: number; printed_by_name: string }[]>(`/actes/${this.uuid}/prints/`).subscribe({ next: p => this.prints.set(p), error: () => undefined }); }

  /** Records the print in the audit trail first, then opens the browser print dialog. */
  print() {
    this.api.post(`/actes/${this.uuid}/print/`).subscribe({
      next: () => { this.loadPrints(); window.print(); },
      error: e => this.toast.error(errorMessage(e)),
    });
  }

  deliver() {
    this.busy.set(true);
    this.api.post(`/actes/${this.uuid}/deliver/`, this.dv).subscribe({
      next: () => { this.busy.set(false); this.deliveryOpen.set(false); this.toast.success('Délivrance enregistrée.'); this.dv = { recipient_name: '', recipient_relationship: '', recipient_id_type: '', recipient_id_number: '', notes: '' }; this.ngOnInit(); },
      error: e => { this.busy.set(false); this.toast.error(errorMessage(e)); },
    });
  }
}
