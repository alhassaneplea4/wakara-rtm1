import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { Acte, ActeDocument, Person } from '../core/models';
import { ToastService } from '../core/toast.service';
import { IconComponent, PageHeaderComponent } from '../shared/ui';

/**
 * Printable model of the acte. The official layout/signatures are NOT validated yet
 * (docs/business-decisions.md): until the dossier is validated the page carries a
 * "projet — sans valeur juridique" watermark and printing is not recorded.
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
        <section class="card noprint" style="max-width:820px;margin:0 auto 16px">
          <div class="card-title"><h2>Historique des impressions</h2></div>
          @for (p of prints(); track p.printed_at) { <div class="prow"><span class="mono">{{ p.printed_at | date: 'dd/MM/yyyy HH:mm' }}</span><span>Exemplaire n° {{ p.copy_number }}</span><span class="soft">{{ p.printed_by_name }}</span></div> }
        </section>
      }
      @if (doc(); as d) {
        <article class="sheet" [class.draft]="!d.is_official">
          @if (!d.is_official) { <div class="watermark">PROJET — SANS VALEUR JURIDIQUE</div> }
          <header>
            <p class="rep">RÉPUBLIQUE DE GUINÉE</p><p class="mot">Travail — Justice — Solidarité</p>
            <p class="adm">Région de {{ d.region || '…' }} · Préfecture de {{ d.prefecture || '…' }} · Commune de {{ d.commune || '…' }}</p>
            <p class="adm">{{ d.centre }}</p>
            <h1>ACTE DE NAISSANCE</h1>
            <p class="refs">Année : <b>{{ d.annee ?? '…' }}</b> · Registre : <b>{{ d.registre || '…' }}</b> · Feuillet : <b>{{ d.feuillet || '…' }}</b> · N° : <b>{{ d.official_number || '…' }}</b></p>
          </header>
          <section>
            <p>L'an <b>{{ d.child.birth_date | date: 'yyyy' }}</b>, le <b>{{ d.child.birth_date | date: 'dd/MM/yyyy' }}</b>{{ d.child.birth_time ? ' à ' + d.child.birth_time.slice(0,5) : '' }}, est né(e) à <b>{{ d.child.birth_place || d.hospital || '…' }}</b> :</p>
            <p class="child">{{ d.child.first_names }} <b>{{ d.child.last_name }}</b> — sexe {{ d.child.gender === 'M' ? 'masculin' : d.child.gender === 'F' ? 'féminin' : '…' }}</p>
            <div class="two">
              <div><h3>Père</h3>{{ who(d.father) }}</div>
              <div><h3>Mère</h3>{{ who(d.mother) }}</div>
            </div>
            <p>Déclaration faite le <b>{{ d.declaration_date ? (d.declaration_date | date: 'dd/MM/yyyy') : '…' }}</b> par
              <b>{{ d.declarant ? d.declarant.first_names + ' ' + d.declarant.last_name : '…' }}</b>{{ d.declarant?.relationship ? ' (' + d.declarant!.relationship + ')' : '' }}.</p>
            @if (d.mentions) { <p><b>Mentions :</b> {{ d.mentions }}</p> }
          </section>
          <footer><div>Le déclarant</div><div>L'officier d'état civil<br /><small>{{ d.officer_name }}</small></div></footer>
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
    .sheet{position:relative;background:#fff;max-width:820px;margin:0 auto;padding:48px 56px;border:1px solid var(--wk-border);box-shadow:var(--shadow-md);font-family:Georgia,'Times New Roman',serif;color:#111;line-height:1.7}
    header{text-align:center}header p{margin:0}
    .rep{font-weight:700;letter-spacing:.08em}.mot{font-style:italic;font-size:13px}.adm{font-size:13px}
    h1{font-family:Georgia,serif;font-size:26px;letter-spacing:.14em;margin:18px 0 6px;color:#111}
    .refs{font-size:14px}
    section{margin-top:22px}.child{font-size:18px;text-align:center;margin:12px 0}
    h3{font-family:Georgia,serif;font-size:14px;text-transform:uppercase;letter-spacing:.08em;margin:0}
    .two{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:14px 0}
    footer{display:flex;justify-content:space-between;margin-top:64px;text-align:center}
    .watermark{position:absolute;inset:0;display:grid;place-items:center;font:700 44px/1.2 var(--wk-font);color:rgba(220,53,69,.16);transform:rotate(-24deg);pointer-events:none;text-align:center;padding:40px}
    .prow{display:flex;gap:16px;padding:6px 0;border-top:1px solid var(--wk-border)}
    .sheet.draft{border-style:dashed}
    @media (max-width:640px){.sheet{padding:24px 18px}.two{grid-template-columns:1fr}}
    @media print{.noprint{display:none!important}.page{padding:0}.sheet{border:0;box-shadow:none;max-width:none}}
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

  who(p: Person | null) {
    if (!p) return '…';
    return [`${p.first_names} ${p.last_name}`.trim(), p.profession, p.address].filter(Boolean).join(' — ') || '…';
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
