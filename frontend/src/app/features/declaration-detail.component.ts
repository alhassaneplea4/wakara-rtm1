import { CommonModule, DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { ApiService, errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { AutoRefreshService } from '../core/auto-refresh.service';
import { Acte, AuditEntry, AvailableTransition, DeclarationDetail, Page, STATUS_LABELS, Status, SupportingDocument } from '../core/models';
import { ToastService } from '../core/toast.service';
import { DateLettersPipe } from '../shared/date-letters.pipe';
import { PaperFormComponent } from '../shared/paper-form.component';
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

type Numbering = { annee: number | null; registre: string; feuillet: string; numero_acte: string };

const MAIN_FLOW = [
  { key: 'DRAFT', label: 'Déclaration saisie', icon: 'file' },
  { key: 'TRANSMITTED', label: 'Transmise au secrétariat', icon: 'arrow' },
  { key: 'IN_COMPLETION', label: 'Complétée par le secrétariat', icon: 'paper' },
  { key: 'PENDING_VALIDATION', label: 'En attente de validation', icon: 'shield' },
  { key: 'VALIDATED', label: 'Validée définitivement', icon: 'check' },
  { key: 'DELIVERED', label: 'Acte délivré', icon: 'certificate' },
];

const STEP_TEXT: Record<string, { title: string; help: string; icon: string; tone: string }> = {
  DRAFT: { title: 'Déclaration créée', help: "L'agent de collecte a enregistré la déclaration. Elle reste modifiable par lui tant qu'elle n'est pas transmise.", icon: 'file', tone: 'info' },
  TRANSMITTED: { title: 'Transmise au secrétariat', help: "La déclaration est envoyée au secrétariat d'état civil, qui la complète (références du registre, père, déclarant) puis l'envoie à la validation.", icon: 'arrow', tone: 'info' },
  IN_COMPLETION: { title: 'Prise en charge par le secrétariat', help: 'Le secrétariat complète le dossier : informations manquantes, déclarant, registre et feuillet.', icon: 'paper', tone: 'info' },
  PENDING_VALIDATION: { title: 'Envoyée à la validation', help: "Le dossier est prêt côté secrétariat. L'administrateur technique doit décider : valider, renvoyer pour correction ou rejeter.", icon: 'shield', tone: 'warning' },
  TO_CORRECT_COLLECTION: { title: 'Renvoyée à la collecte pour correction', help: "L'administrateur demande à l'agent de collecte de corriger la déclaration, puis de la retransmettre.", icon: 'history', tone: 'warning' },
  TO_CORRECT_SECRETARIAT: { title: 'Renvoyée au secrétariat pour correction', help: "L'administrateur demande au secrétariat de corriger le dossier, puis de le soumettre de nouveau.", icon: 'history', tone: 'warning' },
  VALIDATED: { title: 'Validée définitivement', help: "Le numéro officiel de l'acte est attribué : le dossier est figé et l'acte peut être imprimé et délivré.", icon: 'check', tone: 'success' },
  REJECTED: { title: 'Dossier rejeté', help: "Décision définitive : le dossier est clos et aucun acte n'est établi.", icon: 'x', tone: 'danger' },
  DELIVERED: { title: 'Acte délivré', help: "L'acte a été remis au demandeur. Toute remise ultérieure est enregistrée comme duplicata.", icon: 'certificate', tone: 'success' },
};

@Component({
  selector: 'wk-declaration-detail', standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, DatePipe, IconComponent, PageHeaderComponent, StatusBadgeComponent, ConfirmComponent, PaperFormComponent, DateLettersPipe],
  template: `
    @if (d(); as d) {
      <div class="page">
        <wk-page-header [upper]="true" [title]="d.reference" [back]="['/declarations']" backLabel="Retour aux déclarations" [subtitle]="(d.child_name || 'Enfant non nommé') + ' · ' + (d.hospital_name || 'Établissement non identifié')">
          <wk-status [status]="d.status" />
          @if (d.can_edit) { <a class="btn" [routerLink]="['/declarations', d.uuid, 'edit']"><wk-icon name="edit" [size]="16" /> Modifier</a> }
          @if (d.acte_uuid && auth.can('acte.view')) {
            <a class="btn" [routerLink]="['/actes', d.acte_uuid, 'document']"><wk-icon name="eye" [size]="16" /> Aperçu de l'acte</a>
          }
        </wk-page-header>

        @if (error()) { <div class="alert alert-danger" role="alert" style="margin-bottom:16px">{{ error() }}</div> }
        @if (d.last_decision_reason && ['TO_CORRECT_COLLECTION','TO_CORRECT_SECRETARIAT','REJECTED'].includes(d.status)) {
          <div class="alert alert-warning" style="margin-bottom:16px"><strong>Motif du retour / rejet :</strong> {{ d.last_decision_reason }}</div>
        }

        @if (actions(d).length) {
          <section class="card actions" [class.decision]="isDecision(d)">
            <div>
              <h2>{{ isDecision(d) ? 'Décision finale' : 'Actions sur le dossier' }}</h2>
              <p class="soft">{{ isDecision(d) ? 'Vérifiez le dossier complet ci-dessous puis validez, retournez ou rejetez.' : 'Les actions affichées dépendent de votre rôle et de l\\'état du dossier.' }}</p>
            </div>
            <div class="row">
              @for (t of actions(d); track t.target) {
                <button class="btn" [ngClass]="meta(t).cls" (click)="start(t)"><wk-icon [name]="meta(t).icon" [size]="16" /> {{ meta(t).label }}</button>
              }
            </div>
          </section>
        }

        <div class="grid grid-2">
          <section class="card"><div class="card-title"><h2>Naissance</h2></div>
            <dl class="kv uc">
              <dt>Date</dt><dd>{{ d.birth_date | date: 'dd/MM/yyyy' }} {{ d.birth_time ? 'à ' + d.birth_time.slice(0,5) : '' }}<span class="letters">{{ d.birth_date | dateLetters }}</span></dd>
              <dt>Lieu</dt><dd>{{ d.birth_place || '—' }}</dd>
              <dt>Établissement</dt><dd>{{ d.hospital_name || 'Non identifié' }} @if (d.hospital_code) { <span class="mono muted">({{ d.hospital_code }})</span> }</dd>
              <dt>Réf. hospitalière</dt><dd>{{ d.hospital_document_ref || '—' }}</dd>
              <dt>Médecin</dt><dd>{{ d.doctor_name || '—' }}</dd><dt>Sage-femme</dt><dd>{{ d.midwife_name || '—' }}</dd>
              <dt>Reçue le</dt><dd>{{ d.received_at | date: 'dd/MM/yyyy' }}</dd><dt>Responsable</dt><dd>{{ d.assigned_to_name || '—' }}</dd>
              <dt>N° officiel de l'acte</dt><dd>{{ d.official_number || 'Non attribué' }}</dd>
            </dl></section>

          <section class="card"><div class="card-title"><h2>Enfant</h2></div>
            @if (d.child) { <dl class="kv uc">
              <dt>Prénoms</dt><dd>{{ d.child.first_names || '—' }}</dd><dt>Nom</dt><dd>{{ d.child.last_name || '—' }}</dd>
              <dt>Sexe</dt><dd>{{ d.child.gender === 'M' ? 'Masculin' : d.child.gender === 'F' ? 'Féminin' : '—' }}</dd>
              <dt>Nationalité</dt><dd>{{ d.child.nationality || '—' }}</dd><dt>NPI</dt><dd>{{ d.child.npi || '—' }}</dd>
              <dt>Rang de naissance</dt><dd>{{ d.child.birth_rank ? d.child.birth_rank + (d.child.birth_rank === 1 ? 'er' : 'e') + ' enfant de la mère' : '—' }}</dd>
            </dl> }</section>

          <section class="card"><div class="card-title"><h2>Père</h2></div>
            @if (d.father) { <dl class="kv uc"><dt>Prénoms</dt><dd>{{ d.father.first_names || '—' }}</dd><dt>Nom</dt><dd>{{ d.father.last_name || '—' }}</dd>
              <dt>Né(e) le</dt><dd>{{ d.father.date_of_birth ? (d.father.date_of_birth | date: 'dd/MM/yyyy') : '—' }}@if (d.father.date_of_birth) { <span class="letters">{{ d.father.date_of_birth | dateLetters }}</span> }</dd><dt>Lieu de naissance</dt><dd>{{ d.father.birth_place || '—' }}</dd><dt>Âge</dt><dd>{{ d.father.age ?? '—' }}</dd><dt>Profession</dt><dd>{{ d.father.profession || '—' }}</dd>
              <dt>Nationalité</dt><dd>{{ d.father.nationality || '—' }}</dd><dt>NPI</dt><dd>{{ d.father.npi || '—' }}</dd><dt>Téléphone</dt><dd>{{ d.father.phone || '—' }}</dd><dt>Domicile</dt><dd>{{ d.father.address || '—' }}</dd></dl> } @else { <p class="muted">Non renseigné.</p> }</section>

          <section class="card"><div class="card-title"><h2>Mère</h2></div>
            @if (d.mother) { <dl class="kv uc"><dt>Prénoms</dt><dd>{{ d.mother.first_names || '—' }}</dd><dt>Nom</dt><dd>{{ d.mother.last_name || '—' }}</dd>
              <dt>Né(e) le</dt><dd>{{ d.mother.date_of_birth ? (d.mother.date_of_birth | date: 'dd/MM/yyyy') : '—' }}@if (d.mother.date_of_birth) { <span class="letters">{{ d.mother.date_of_birth | dateLetters }}</span> }</dd><dt>Lieu de naissance</dt><dd>{{ d.mother.birth_place || '—' }}</dd><dt>Âge</dt><dd>{{ d.mother.age ?? '—' }}</dd><dt>Profession</dt><dd>{{ d.mother.profession || '—' }}</dd>
              <dt>Nationalité</dt><dd>{{ d.mother.nationality || '—' }}</dd><dt>NPI</dt><dd>{{ d.mother.npi || '—' }}</dd><dt>Téléphone</dt><dd>{{ d.mother.phone || '—' }}</dd><dt>Domicile</dt><dd>{{ d.mother.address || '—' }}</dd></dl> } @else { <p class="muted">Non renseignée.</p> }</section>

          <section class="card"><div class="card-title"><h2>Déclarant</h2></div>
            @if (d.declarant) { <dl class="kv uc"><dt>Nom</dt><dd>{{ d.declarant.first_names }} {{ d.declarant.last_name }}</dd>
              <dt>Lien</dt><dd>{{ d.declarant.relationship || '—' }}</dd><dt>Profession</dt><dd>{{ d.declarant.profession || '—' }}</dd><dt>Nationalité</dt><dd>{{ d.declarant.nationality || '—' }}</dd><dt>NPI</dt><dd>{{ d.declarant.npi || '—' }}</dd>
              <dt>Téléphone</dt><dd>{{ d.declarant.phone || '—' }}</dd><dt>Domicile</dt><dd>{{ d.declarant.address || '—' }}</dd></dl> } @else { <p class="muted">À renseigner par le secrétariat.</p> }</section>

          @if (acte(); as a) {
            <section class="card"><div class="card-title"><h2>Acte</h2></div>
              <dl class="kv"><dt>Année</dt><dd>{{ a.annee ?? '—' }}</dd><dt>Registre</dt><dd>{{ a.registre || '—' }}</dd><dt>Feuillet</dt><dd>{{ a.feuillet || '—' }}</dd>
                <dt>N° officiel</dt><dd>{{ a.numero_acte || 'Non attribué' }}</dd><dt>Commune</dt><dd>{{ a.commune || '—' }}</dd>
                <dt>Date de déclaration</dt><dd>{{ a.declaration_date ? (a.declaration_date | date: 'dd/MM/yyyy') : '—' }}</dd></dl></section>
          }
        </div>

        @if (d.notes) { <section class="card" style="margin-top:16px"><div class="card-title"><h2>Observations</h2></div><p class="uc">{{ d.notes }}</p></section> }

        @if (auth.can('document.view')) {
          <section class="card" style="margin-top:16px">
            <wk-paper-form [declaration]="d.uuid" [editable]="auth.can('document.upload') && !frozen(d)" />
          </section>
          <section class="card" style="margin-top:16px">
            <div class="card-title"><h2>Pièces justificatives</h2>
              @if (auth.can('document.upload') && !frozen(d)) {
                <div class="row">
                  <select class="input kind" [(ngModel)]="kind" aria-label="Type de pièce">
                    <option value="PARENT_ID">Pièce d'un parent</option><option value="HOSPITAL_FORM">Déclaration hospitalière</option>
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
          <div class="card-title"><h2>Historique du dossier</h2><span class="soft">{{ history(d).length }} étape(s) · ouvert depuis {{ openFor(d) }}</span></div>

          <ol class="flow" aria-label="Progression du dossier">
            @for (st of flow(d); track st.key) {
              <li [class.done]="st.state === 'done'" [class.current]="st.state === 'current'" [attr.aria-current]="st.state === 'current' ? 'step' : null">
                <span class="bubble"><wk-icon [name]="st.state === 'done' ? 'check' : st.icon" [size]="14" /></span>
                <span class="lbl">{{ st.label }}</span>
              </li>
            }
          </ol>
          @if (sideNote(d); as n) { <p class="side-note" [class.bad]="n.bad">{{ n.text }}</p> }

          <ol class="timeline">
            @for (h of history(d); track $index) {
              <li>
                <span class="mark" [ngClass]="h.tone"><wk-icon [name]="h.icon" [size]="15" /></span>
                <div class="body">
                  <div class="head"><strong>{{ h.title }}</strong>@if ($first) { <span class="badge badge-info">Dernière étape</span> }</div>
                  <small class="muted">Par {{ h.who }} · le {{ h.at | date: 'dd/MM/yyyy' }} à {{ h.at | date: 'HH:mm' }}@if (h.elapsed) { · {{ h.elapsed }} après l'étape précédente }</small>
                  <p class="what soft">{{ h.help }}</p>
                  @if (h.reason) { <p class="why"><span>{{ h.reasonLabel }}</span> {{ h.reason }}</p> }
                </div>
              </li>
            }
          </ol>
        </section>

        @if (auth.can('audit.view')) {
          <section class="card" style="margin-top:16px">
            <div class="card-title"><h2>Journal d'audit du dossier</h2><a class="btn btn-sm" [routerLink]="['/history', d.uuid]"><wk-icon name="search" [size]="14" /> Historique complet</a></div>
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
      @if (incomplete(); as inc) {
        <wk-confirm title="Des champs ne sont pas renseignés" confirmLabel="Valider quand même" [busy]="busy()"
          (cancel)="incomplete.set(null)" (confirm)="confirmIncomplete(inc)">
          <span class="soft">Ces informations sont encore vides :</span>
          <ul class="missing">@for (l of inc.labels; track l) { <li>{{ l }}</li> }</ul>
          <span class="soft">Retournez compléter le dossier, ou validez quand même : les champs manquants seront notés dans l'historique du dossier.</span>
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
    .letters{display:block;color:var(--wk-royal);font-size:12.5px;font-weight:600;margin-top:2px}
    .doc{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--wk-border)}
    .doc div{display:flex;flex-direction:column}
    .kind{width:auto;max-width:100%;min-height:32px;padding:4px 8px}
    .card-title{flex-wrap:wrap;gap:10px}
    .card-title .row{flex-wrap:wrap;min-width:0;max-width:100%}
    .flow{list-style:none;margin:4px 0 6px;padding:0;display:flex;gap:6px;overflow-x:auto}
    .flow li{flex:1 1 0;min-width:88px;display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;position:relative;font-size:12px;color:var(--wk-text-mute)}
    .flow li:not(:last-child)::after{content:'';position:absolute;top:13px;left:calc(50% + 16px);right:calc(-50% + 16px);height:2px;background:var(--wk-border)}
    .flow li.done:not(:last-child)::after{background:var(--wk-success)}
    .flow .bubble{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:#fff;border:2px solid var(--wk-border);color:var(--wk-text-mute);z-index:1}
    .flow .done .bubble{background:var(--wk-success);border-color:var(--wk-success);color:#fff}
    .flow .current .bubble{background:var(--wk-royal);border-color:var(--wk-royal);color:#fff;box-shadow:0 0 0 4px var(--wk-info-bg)}
    .flow .current .lbl{color:var(--wk-royal);font-weight:700}.flow .done .lbl{color:var(--wk-text)}
    .side-note{margin:6px 0 2px;padding:8px 12px;border-radius:8px;background:var(--wk-warning-bg);color:var(--wk-warning);font-size:13px}
    .side-note.bad{background:var(--wk-danger-bg);color:var(--wk-danger)}
    .timeline{list-style:none;margin:16px 0 0;padding:0;display:flex;flex-direction:column;gap:0}
    .timeline li{display:flex;gap:14px;padding-bottom:18px;position:relative}
    .timeline li:not(:last-child)::before{content:'';position:absolute;left:15px;top:34px;bottom:2px;width:2px;background:var(--wk-border)}
    .timeline .mark{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;flex:none;background:var(--wk-info-bg);color:var(--wk-royal)}
    .timeline .mark.success{background:var(--wk-success-bg);color:var(--wk-success)}
    .timeline .mark.warning{background:var(--wk-warning-bg);color:var(--wk-warning)}
    .timeline .mark.danger{background:var(--wk-danger-bg);color:var(--wk-danger)}
    .timeline .body{display:flex;flex-direction:column;gap:2px;min-width:0}
    .timeline .head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .timeline .what{margin:2px 0 0}
    .timeline .why{margin:4px 0 0;padding:8px 12px;border-left:3px solid var(--wk-royal);background:var(--wk-sky-50);border-radius:0 8px 8px 0;font-size:13px}
    .timeline .why span{font-weight:700;margin-right:4px}
    .jrow{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--wk-border)}
    .missing{margin:10px 0;padding-left:20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:2px 16px;font-weight:600}
    .num{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}
  `],
})
export class DeclarationDetailComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);
  private autoRefresh = inject(AutoRefreshService);
  auth = inject(AuthService);

  d = signal<DeclarationDetail | null>(null);
  acte = signal<Acte | null>(null);
  docs = signal<SupportingDocument[]>([]);
  journal = signal<AuditEntry[]>([]);
  error = signal('');
  busy = signal(false);
  pending = signal<AvailableTransition | null>(null);
  // the numbering typed by the validator is kept with the warning, so a refresh cannot wipe it before the confirmation
  incomplete = signal<{ t: AvailableTransition; reason: string; labels: string[]; num: Numbering } | null>(null);
  archiving = signal(false);
  kind = 'PARENT_ID';
  num: Numbering = { annee: null, registre: '', feuillet: '', numero_acte: '' };

  ngOnInit() {
    this.route.paramMap.subscribe(() => this.load());
    // every 30 s, unless the user is in the middle of a decision (confirmation dialog)
    this.autoRefresh.on(this.destroyRef, () => { if (!this.pending() && !this.incomplete() && !this.archiving() && !this.busy()) this.load(); });
  }

  private uuid() { return this.route.snapshot.paramMap.get('uuid')!; }
  kindLabel(k: string) { return ({ PAPER_FORM: 'Fiche de déclaration physique', HOSPITAL_FORM: 'Déclaration hospitalière', PARENT_ID: "Pièce d'un parent", DECLARANT_ID: 'Pièce du déclarant', OTHER: 'Autre pièce' } as Record<string, string>)[k] ?? k; }
  sizeLabel(bytes: number) { return bytes < 1024 ? '< 1 Ko' : bytes < 1048576 ? `${Math.round(bytes / 1024)} Ko` : `${(bytes / 1048576).toFixed(1)} Mo`; }
  label(s: string) { return STATUS_LABELS[s as Status] ?? s; }
  meta(t: AvailableTransition) { return ACTION[t.target] ?? { label: t.target, icon: 'arrow', cls: '' }; }
  isDecision(d: DeclarationDetail) { return d.status === 'PENDING_VALIDATION'; }
  /**
   * Buttons of the « Actions sur le dossier » card. « Prendre en charge » no longer exists and « Soumettre à
   * validation » is done from the edit form (it needs every field filled in), so the secretariat only keeps
   * « Modifier » and « Aperçu ».
   */
  actions(d: DeclarationDetail) { return d.available_transitions.filter(t => t.target !== 'IN_COMPLETION' && t.target !== 'PENDING_VALIDATION'); }
  frozen(d: DeclarationDetail) { return ['VALIDATED', 'REJECTED', 'DELIVERED'].includes(d.status); }
  /** Plain-language reading of every workflow step, newest first. */
  history(d: DeclarationDetail) {
    // the API sends the newest step first (ordered by date then id, so steps of the same second keep their true order)
    const rows = [...d.status_history].reverse();
    const view = rows.map((h, i) => {
      const s = STEP_TEXT[h.to_status] ?? { title: this.label(h.to_status), help: '', icon: 'history', tone: 'info' };
      const prev = i > 0 ? rows[i - 1] : null;
      const sentBack = h.to_status.startsWith('TO_CORRECT') || h.to_status === 'REJECTED';
      return {
        title: s.title, help: s.help, icon: s.icon, tone: s.tone, who: h.changed_by_name || 'le système', at: h.changed_at,
        reason: h.reason, reasonLabel: sentBack ? 'Motif :' : h.to_status === 'DELIVERED' ? 'Remise :' : 'Commentaire :',
        elapsed: prev ? this.duration(new Date(h.changed_at).getTime() - new Date(prev.changed_at).getTime()) : '',
      };
    });
    return view.reverse();
  }

  duration(ms: number) {
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 1) return "moins d'une minute";
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} h ${min % 60 ? (min % 60) + ' min' : ''}`.trim();
    const days = Math.floor(h / 24);
    return `${days} j ${h % 24 ? (h % 24) + ' h' : ''}`.trim();
  }

  openFor(d: DeclarationDetail) { return this.duration(Date.now() - new Date(d.created_at).getTime()); }

  /** The main path of a dossier and where it stands now. */
  flow(d: DeclarationDetail) {
    // a dossier sent back waits at the stage it was returned to; a validated one waits for its delivery
    const waits: Record<string, string> = { TO_CORRECT_COLLECTION: 'DRAFT', TO_CORRECT_SECRETARIAT: 'IN_COMPLETION', REJECTED: 'PENDING_VALIDATION', VALIDATED: 'DELIVERED' };
    const idx = MAIN_FLOW.findIndex(x => x.key === (waits[d.status] ?? d.status));
    return MAIN_FLOW.map((x, i) => ({ ...x, state: d.status === 'DELIVERED' || i < idx ? 'done' : i === idx ? 'current' : 'todo' }));
  }

  /** What the main path does not show: a correction in progress or a rejection. */
  sideNote(d: DeclarationDetail): { text: string; bad: boolean } | null {
    if (d.status === 'TO_CORRECT_COLLECTION') return { text: "Renvoyé à l'agent de collecte pour correction : il doit compléter la déclaration puis la retransmettre.", bad: false };
    if (d.status === 'TO_CORRECT_SECRETARIAT') return { text: 'Renvoyé au secrétariat pour correction : il doit corriger le dossier puis le soumettre de nouveau à la validation.', bad: false };
    if (d.status === 'REJECTED') return { text: "Dossier rejeté : la procédure est close, aucun acte ne sera établi.", bad: true };
    return null;
  }

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
        if (this.auth.can('document.view')) this.api.get<Page<SupportingDocument>>('/documents/', { declaration: d.uuid, page_size: 100 }).subscribe(p => this.docs.set(p.results.filter(x => x.kind !== 'PAPER_FORM')));
      },
      error: e => this.error.set(errorMessage(e)),
    });
  }

  start(t: AvailableTransition) {
    this.error.set('');
    if (t.reason_required || t.target === 'VALIDATED' || this.meta(t).confirm) this.pending.set(t);
    else this.run(t, '');
  }

  /** The validator read the warning and confirms: the numbering typed before it is sent again as it was. */
  confirmIncomplete(inc: { t: AvailableTransition; reason: string; num: Numbering }) {
    this.num = { ...inc.num };
    this.run(inc.t, inc.reason, true);
  }

  run(t: AvailableTransition, reason: string, acceptIncomplete = false) {
    this.busy.set(true);
    const body: any = { status: t.target, reason };
    if (acceptIncomplete) body.accept_incomplete = true;
    if (t.target === 'VALIDATED') {
      if (this.num.annee) body.annee = this.num.annee;
      body.registre = this.num.registre; body.feuillet = this.num.feuillet; body.numero_acte = this.num.numero_acte;
    }
    this.api.post<DeclarationDetail>(`/declarations/${this.uuid()}/transition/`, body).subscribe({
      next: d => { this.busy.set(false); this.pending.set(null); this.incomplete.set(null); this.d.set(d); this.toast.success(`Statut : ${this.label(d.status)}`); this.load(); },
      error: e => {
        this.busy.set(false); this.pending.set(null);
        // final validation with expected fields still empty: the validator is warned and may confirm
        if (e?.status === 409 && e.error?.code === 'incomplete_confirmation_required') {
          this.incomplete.set({ t, reason, labels: e.error.missing_labels ?? [], num: { ...this.num } });
          return;
        }
        this.incomplete.set(null);
        this.error.set(errorMessage(e)); window.scrollTo({ top: 0, behavior: 'smooth' });
      },
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
