import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { ApiService, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { Acte, AuditEntry, AvailableTransition, DeclarationDetail, Page, STATUS_LABELS, Status, SupportingDocument } from '../core/models';
import { ToastService } from '../core/toast.service';
import { ConfirmComponent, IconComponent, PageHeaderComponent, StatusBadgeComponent } from '../shared/ui';

const ACTION: Partial<Record<Status, { label: string; icon: string; cls: string; confirm?: string }>> = {
  TRANSMITTED: { label: 'Transmettre au secrétariat', icon: 'arrow', cls: 'btn-primary', confirm: 'Le dossier ne sera plus modifiable par la collecte.' },
  IN_COMPLETION: { label: 'Prendre en charge', icon: 'paper', cls: 'btn-primary' },
  PENDING_VALIDATION: { label: 'Soumettre à validation', icon: 'shield', cls: 'btn-primary', confirm: 'Le dossier sera transmis à l\'administrateur technique pour décision.' },
  VALIDATED: { label: 'Valider définitivement', icon: 'check', cls: 'btn-success' },
  TO_CORRECT_COLLECTION: { label: 'Retourner à la collecte', icon: 'history', cls: '' },
  TO_CORRECT_SECRETARIAT: { label: 'Retourner au secrétariat', icon: 'history', cls: '' },
  REJECTED: { label: 'Rejeter le dossier', icon: 'x', cls: 'btn-danger' },
};

@Component({
  selector: 'wk-declaration-detail', standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, DatePipe, IconComponent, PageHeaderComponent, StatusBadgeComponent, ConfirmComponent],
  template: `
    @if (d(); as d) {
      <div class="page">
        <wk-page-header [title]="d.reference" [subtitle]="(d.child_name || 'Enfant non nommé') + ' · ' + (d.hospital_name || 'Établissement non identifié')">
          <wk-status [status]="d.status" />
          @if (d.can_edit) { <a class="btn" [routerLink]="['/declarations', d.uuid, 'edit']"><wk-icon name="edit" [size]="16" /> Modifier</a> }
          @if (d.acte_uuid && auth.can('acte.view')) {
            @if (acte()?.can_edit) { <a class="btn" [routerLink]="['/declarations', d.uuid, 'acte']"><wk-icon name="certificate" [size]="16" /> Compléter l'acte</a> }
            <a class="btn" [routerLink]="['/actes', d.acte_uuid, 'document']"><wk-icon name="eye" [size]="16" /> Aperçu de l'acte</a>
          }
        </wk-page-header>

        @if (error()) { <div class="alert alert-danger" role="alert" style="margin-bottom:16px">{{ error() }}</div> }
        @if (d.last_decision_reason && ['TO_CORRECT_COLLECTION','TO_CORRECT_SECRETARIAT','REJECTED'].includes(d.status)) {
          <div class="alert alert-warning" style="margin-bottom:16px"><strong>Motif du retour / rejet :</strong> {{ d.last_decision_reason }}</div>
        }

        @if (d.available_transitions.length) {
          <section class="card actions" [class.decision]="isDecision(d)">
            <div>
              <h2>{{ isDecision(d) ? 'Décision finale' : 'Actions sur le dossier' }}</h2>
              <p class="soft">{{ isDecision(d) ? 'Vérifiez le dossier complet ci-dessous puis validez, retournez ou rejetez.' : 'Les actions affichées dépendent de votre rôle et de l\\'état du dossier.' }}</p>
            </div>
            <div class="row">
              @for (t of d.available_transitions; track t.target) {
                <button class="btn" [ngClass]="meta(t).cls" (click)="start(t)"><wk-icon [name]="meta(t).icon" [size]="16" /> {{ meta(t).label }}</button>
              }
            </div>
          </section>
        }

        <div class="grid grid-2">
          <section class="card"><div class="card-title"><h2>Naissance</h2></div>
            <dl class="kv">
              <dt>Date</dt><dd>{{ d.birth_date | date: 'dd/MM/yyyy' }} {{ d.birth_time ? 'à ' + d.birth_time.slice(0,5) : '' }}</dd>
              <dt>Lieu</dt><dd>{{ d.birth_place || '—' }}</dd>
              <dt>Établissement</dt><dd>{{ d.hospital_name || 'Non identifié' }}</dd>
              <dt>Réf. hospitalière</dt><dd>{{ d.hospital_document_ref || '—' }}</dd>
              <dt>Médecin</dt><dd>{{ d.doctor_name || '—' }}</dd><dt>Sage-femme</dt><dd>{{ d.midwife_name || '—' }}</dd>
              <dt>Reçue le</dt><dd>{{ d.received_at | date: 'dd/MM/yyyy' }}</dd><dt>Responsable</dt><dd>{{ d.assigned_to_name || '—' }}</dd>
              <dt>N° officiel de l'acte</dt><dd>{{ d.official_number || 'Non attribué' }}</dd>
            </dl></section>

          <section class="card"><div class="card-title"><h2>Enfant</h2></div>
            @if (d.child) { <dl class="kv">
              <dt>Prénoms</dt><dd>{{ d.child.first_names || '—' }}</dd><dt>Nom</dt><dd>{{ d.child.last_name || '—' }}</dd>
              <dt>Sexe</dt><dd>{{ d.child.gender === 'M' ? 'Masculin' : d.child.gender === 'F' ? 'Féminin' : '—' }}</dd>
              <dt>Poids</dt><dd>{{ d.child.birth_weight ? d.child.birth_weight + ' kg' : '—' }}</dd>
              <dt>Taille</dt><dd>{{ d.child.birth_length ? d.child.birth_length + ' cm' : '—' }}</dd></dl> }</section>

          <section class="card"><div class="card-title"><h2>Mère</h2></div>
            @if (d.mother) { <dl class="kv"><dt>Prénoms</dt><dd>{{ d.mother.first_names || '—' }}</dd><dt>Nom</dt><dd>{{ d.mother.last_name || '—' }}</dd>
              <dt>Âge</dt><dd>{{ d.mother.age ?? '—' }}</dd><dt>Profession</dt><dd>{{ d.mother.profession || '—' }}</dd>
              <dt>Nationalité</dt><dd>{{ d.mother.nationality || '—' }}</dd><dt>Domicile</dt><dd>{{ d.mother.address || '—' }}</dd></dl> } @else { <p class="muted">Non renseignée.</p> }</section>

          <section class="card"><div class="card-title"><h2>Père</h2></div>
            @if (d.father) { <dl class="kv"><dt>Prénoms</dt><dd>{{ d.father.first_names || '—' }}</dd><dt>Nom</dt><dd>{{ d.father.last_name || '—' }}</dd>
              <dt>Âge</dt><dd>{{ d.father.age ?? '—' }}</dd><dt>Profession</dt><dd>{{ d.father.profession || '—' }}</dd>
              <dt>Nationalité</dt><dd>{{ d.father.nationality || '—' }}</dd><dt>Domicile</dt><dd>{{ d.father.address || '—' }}</dd></dl> } @else { <p class="muted">Non renseigné.</p> }</section>

          <section class="card"><div class="card-title"><h2>Déclarant</h2></div>
            @if (d.declarant) { <dl class="kv"><dt>Nom</dt><dd>{{ d.declarant.first_names }} {{ d.declarant.last_name }}</dd>
              <dt>Lien</dt><dd>{{ d.declarant.relationship || '—' }}</dd><dt>Profession</dt><dd>{{ d.declarant.profession || '—' }}</dd>
              <dt>Pièce</dt><dd>{{ d.declarant.id_type }} {{ d.declarant.id_number }}</dd><dt>Domicile</dt><dd>{{ d.declarant.address || '—' }}</dd></dl> } @else { <p class="muted">À renseigner par le secrétariat.</p> }</section>

          @if (acte(); as a) {
            <section class="card"><div class="card-title"><h2>Acte</h2></div>
              <dl class="kv"><dt>Année</dt><dd>{{ a.annee ?? '—' }}</dd><dt>Registre</dt><dd>{{ a.registre || '—' }}</dd><dt>Feuillet</dt><dd>{{ a.feuillet || '—' }}</dd>
                <dt>N° officiel</dt><dd>{{ a.numero_acte || 'Non attribué' }}</dd><dt>Commune</dt><dd>{{ a.commune || '—' }}</dd>
                <dt>Date de déclaration</dt><dd>{{ a.declaration_date ? (a.declaration_date | date: 'dd/MM/yyyy') : '—' }}</dd></dl></section>
          }
        </div>

        @if (d.notes) { <section class="card" style="margin-top:16px"><div class="card-title"><h2>Observations</h2></div><p>{{ d.notes }}</p></section> }

        @if (auth.can('document.view')) {
          <section class="card" style="margin-top:16px">
            <div class="card-title"><h2>Pièces justificatives</h2>
              @if (auth.can('document.upload') && !frozen(d)) {
                <div class="row">
                  <select class="input kind" [(ngModel)]="kind" aria-label="Type de pièce">
                    <option value="HOSPITAL_FORM">Déclaration hospitalière</option><option value="PARENT_ID">Pièce d'un parent</option>
                    <option value="DECLARANT_ID">Pièce du déclarant</option><option value="OTHER">Autre</option></select>
                  <label class="btn btn-sm"><wk-icon name="upload" [size]="14" /> Ajouter (PDF, JPG, PNG)
                    <input type="file" hidden accept=".pdf,.jpg,.jpeg,.png" (change)="upload($event)" /></label>
                </div>
              }
            </div>
            @for (doc of docs(); track doc.uuid) {
              <div class="doc"><wk-icon name="file" /><div><strong>{{ doc.original_name }}</strong><small class="muted">{{ kindLabel(doc.kind) }} · {{ sizeLabel(doc.size) }} · {{ doc.uploaded_by_name }} · {{ doc.created_at | date: 'dd/MM/yyyy HH:mm' }}</small></div>
                <span class="spacer"></span><button class="btn btn-sm" (click)="download(doc)"><wk-icon name="eye" [size]="14" /> Ouvrir</button></div>
            } @empty { <p class="muted">Aucune pièce jointe.</p> }
          </section>
        }

        <section class="card" style="margin-top:16px">
          <div class="card-title"><h2>Historique du dossier</h2></div>
          <ol class="timeline">
            @for (h of historyDesc(d); track $index) {
              <li><span class="dot"></span><div>
                <strong>{{ label(h.from_status) }} @if (h.from_status) { → } {{ label(h.to_status) }}</strong>
                <small class="muted">{{ h.changed_by_name || 'Système' }} · {{ h.changed_at | date: 'dd/MM/yyyy HH:mm' }}</small>
                @if (h.reason) { <p class="soft">« {{ h.reason }} »</p> }</div></li>
            }
          </ol>
        </section>

        @if (auth.can('audit.view')) {
          <section class="card" style="margin-top:16px">
            <div class="card-title"><h2>Journal d'audit du dossier</h2></div>
            @for (e of journal(); track e.id) {
              <div class="jrow"><span class="mono muted">{{ e.created_at | date: 'dd/MM/yyyy HH:mm' }}</span><strong>{{ e.username || 'Système' }}</strong>
                <span class="badge badge-info">{{ e.action }}</span><span class="soft">{{ e.object_type }}</span>@if (e.reason) { <em class="soft">« {{ e.reason }} »</em> }</div>
            } @empty { <p class="muted">Aucun événement.</p> }
          </section>
        }

        @if (auth.can('declaration.archive') && ['DRAFT','REJECTED'].includes(d.status)) {
          <p style="margin-top:16px"><button class="btn btn-ghost" (click)="archiving.set(true)">Archiver ce dossier</button></p>
        }
      </div>

      @if (pending(); as t) {
        <wk-confirm [title]="meta(t).label" [confirmLabel]="meta(t).label" [danger]="t.target === 'REJECTED'" [busy]="busy()"
          [askReason]="t.reason_required" [reasonRequired]="true"
          reasonLabel="Motif (obligatoire)" (cancel)="pending.set(null)" (confirm)="run(t, $event)">
          @if (t.target === 'VALIDATED') {
            <span class="soft">Le numéro officiel est attribué à la validation. Vérifiez-le avant de confirmer.</span>
            <span class="num">
              <span class="field"><label>Année du registre</label><input class="input" type="number" [(ngModel)]="num.annee" /></span>
              <span class="field"><label>Registre</label><input class="input" [(ngModel)]="num.registre" /></span>
              <span class="field"><label>Feuillet</label><input class="input" [(ngModel)]="num.feuillet" /></span>
              <span class="field"><label>N° officiel de l'acte</label><input class="input" [(ngModel)]="num.numero_acte" placeholder="Saisie manuelle" /></span>
            </span>
          } @else { {{ meta(t).confirm || 'Confirmer cette action ?' }} }
        </wk-confirm>
      }
      @if (archiving()) {
        <wk-confirm title="Archiver le dossier" confirmLabel="Archiver" [danger]="true" (cancel)="archiving.set(false)" (confirm)="archive()">
          Le dossier sera masqué des listes mais conservé (aucune suppression physique).
        </wk-confirm>
      }
    } @else if (error()) { <div class="page"><div class="alert alert-danger">{{ error() }}</div></div> }
    @else { <div class="page"><div class="card"><div class="skeleton" style="height:320px"></div></div></div> }
  `,
  styles: [`
    .actions{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:16px;border-left:4px solid var(--wk-royal)}
    .actions.decision{border-left-color:var(--wk-success);background:linear-gradient(90deg,#f1fbf6,#fff)}
    .doc{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--wk-border)}
    .doc div{display:flex;flex-direction:column}
    .kind{width:auto;min-height:32px;padding:4px 8px}
    .timeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px}
    .timeline li{display:flex;gap:12px}
    .timeline li>div{display:flex;flex-direction:column}
    .dot{width:10px;height:10px;border-radius:50%;background:var(--wk-royal);margin-top:6px;flex:none;box-shadow:0 0 0 4px var(--wk-info-bg)}
    .jrow{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--wk-border)}
    .num{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}
  `],
})
export class DeclarationDetailComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);
  auth = inject(AuthService);

  d = signal<DeclarationDetail | null>(null);
  acte = signal<Acte | null>(null);
  docs = signal<SupportingDocument[]>([]);
  journal = signal<AuditEntry[]>([]);
  error = signal('');
  busy = signal(false);
  pending = signal<AvailableTransition | null>(null);
  archiving = signal(false);
  kind = 'HOSPITAL_FORM';
  num: { annee: number | null; registre: string; feuillet: string; numero_acte: string } = { annee: null, registre: '', feuillet: '', numero_acte: '' };

  ngOnInit() { this.route.paramMap.subscribe(() => this.load()); }

  private uuid() { return this.route.snapshot.paramMap.get('uuid')!; }
  kindLabel(k: string) { return ({ HOSPITAL_FORM: 'Déclaration hospitalière', PARENT_ID: "Pièce d'un parent", DECLARANT_ID: 'Pièce du déclarant', OTHER: 'Autre pièce' } as Record<string, string>)[k] ?? k; }
  sizeLabel(bytes: number) { return bytes < 1024 ? '< 1 Ko' : bytes < 1048576 ? `${Math.round(bytes / 1024)} Ko` : `${(bytes / 1048576).toFixed(1)} Mo`; }
  label(s: string) { return STATUS_LABELS[s as Status] ?? s; }
  meta(t: AvailableTransition) { return ACTION[t.target] ?? { label: t.target, icon: 'arrow', cls: '' }; }
  isDecision(d: DeclarationDetail) { return d.status === 'PENDING_VALIDATION'; }
  frozen(d: DeclarationDetail) { return ['VALIDATED', 'REJECTED', 'DELIVERED'].includes(d.status); }
  historyDesc(d: DeclarationDetail) { return d.status_history; }

  load() {
    this.error.set('');
    this.api.get<DeclarationDetail>(`/declarations/${this.uuid()}/`).subscribe({
      next: d => {
        this.d.set(d);
        if (d.acte_uuid && this.auth.can('acte.view')) {
          this.api.get<Acte>(`/actes/${d.acte_uuid}/`).subscribe({
            next: a => { this.acte.set(a); this.num = { annee: a.annee, registre: a.registre, feuillet: a.feuillet, numero_acte: a.numero_acte ?? '' }; },
            error: () => this.acte.set(null),
          });
        }
        if (this.auth.can('audit.view')) {
          const ids = [d.uuid, d.acte_uuid].filter(Boolean) as string[];
          forkJoin(ids.map(id => this.api.get<Page<AuditEntry>>('/audit/', { object_id: id, page_size: 50 }))).subscribe({
            next: pages => this.journal.set(pages.flatMap(p => p.results).sort((a, b) => b.created_at.localeCompare(a.created_at))),
            error: () => this.journal.set([]),
          });
        }
        if (this.auth.can('document.view')) this.api.get<Page<SupportingDocument>>('/documents/', { declaration: d.uuid }).subscribe(p => this.docs.set(p.results));
      },
      error: e => this.error.set(errorMessage(e)),
    });
  }

  start(t: AvailableTransition) {
    this.error.set('');
    if (t.reason_required || t.target === 'VALIDATED' || this.meta(t).confirm) this.pending.set(t);
    else this.run(t, '');
  }

  run(t: AvailableTransition, reason: string) {
    this.busy.set(true);
    const body: any = { status: t.target, reason };
    if (t.target === 'VALIDATED') {
      if (this.num.annee) body.annee = this.num.annee;
      body.registre = this.num.registre; body.feuillet = this.num.feuillet; body.numero_acte = this.num.numero_acte;
    }
    this.api.post<DeclarationDetail>(`/declarations/${this.uuid()}/transition/`, body).subscribe({
      next: d => { this.busy.set(false); this.pending.set(null); this.d.set(d); this.toast.success(`Statut : ${this.label(d.status)}`); this.load(); },
      error: e => { this.busy.set(false); this.pending.set(null); this.error.set(errorMessage(e)); window.scrollTo({ top: 0, behavior: 'smooth' }); },
    });
  }

  upload(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('declaration', this.uuid()); fd.append('kind', this.kind); fd.append('file', file);
    this.api.post<SupportingDocument>('/documents/', fd).subscribe({
      next: () => { this.toast.success('Pièce ajoutée.'); input.value = ''; this.load(); },
      error: e => { input.value = ''; this.toast.error(errorMessage(e)); },
    });
  }

  download(doc: SupportingDocument) {
    this.api.blob(`/documents/${doc.uuid}/download/`).subscribe({
      next: b => { const url = URL.createObjectURL(new Blob([b], { type: doc.content_type })); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60000); },
      error: e => this.toast.error(errorMessage(e)),
    });
  }

  archive() {
    this.api.delete(`/declarations/${this.uuid()}/`).subscribe({
      next: () => { this.toast.success('Dossier archivé.'); this.router.navigate(['/declarations']); },
      error: e => { this.archiving.set(false); this.error.set(errorMessage(e)); },
    });
  }
}
