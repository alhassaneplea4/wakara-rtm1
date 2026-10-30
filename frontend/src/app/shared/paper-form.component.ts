import { CommonModule, DatePipe } from '@angular/common';
import { Component, ElementRef, HostListener, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../core/api.service';
import { Page, SupportingDocument } from '../core/models';
import { ToastService } from '../core/toast.service';
import { IconComponent } from './ui';

interface Pending { file: File; preview: string | null; }
interface Saved { doc: SupportingDocument; url: string | null; }

const MAX_SIDE = 2400;          // longest side of an uploaded photo, in pixels
const RECOMPRESS_ABOVE = 1e6;   // bytes: smaller photos are sent untouched
const TARGET_SIZE = 3.5e6;      // bytes: stays under the 4.5 MB request limit of serverless hosting

/** Re-encodes a phone photo as a reasonably sized JPEG; falls back to the original if the browser cannot decode it. */
async function shrink(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.size <= RECOMPRESS_ABOVE) return file;
  try {
    const bitmap = await createImageBitmap(file);
    let blob: Blob | null = null;
    // Re-encode, then shrink step by step until the file is light enough.
    for (const [side, quality] of [[MAX_SIDE, 0.85], [2000, 0.78], [1600, 0.7]] as const) {
      const k = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * k); canvas.height = Math.round(bitmap.height * k);
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', quality));
      if (blob && blob.size <= TARGET_SIZE) break;
    }
    bitmap.close();
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}

/**
 * Photo / scan of the PHYSICAL declaration form.
 * - With `declaration`: files are sent immediately and the saved pages are listed.
 * - Without it (new dossier): files are kept in memory until the parent calls `uploadPending(uuid)`.
 */
@Component({
  selector: 'wk-paper-form', standalone: true, imports: [CommonModule, DatePipe, IconComponent],
  template: `
    <div class="head">
      <div>
        <h2>Fiche de déclaration physique</h2>
        <p class="soft">Photographiez la fiche papier remise par l'hôpital ou importez une image ou un PDF. Elle reste jointe au dossier.</p>
      </div>
      @if (editable) {
        <div class="row">
          <label class="btn btn-sm photo"><wk-icon name="camera" [size]="14" /> Prendre une photo
            <input #camera type="file" hidden accept="image/*" capture="environment" (change)="pick($event)" /></label>
          <label class="btn btn-sm"><wk-icon name="upload" [size]="14" /> Importer un fichier
            <input #library type="file" hidden multiple accept="image/*,.pdf,application/pdf" (change)="pick($event)" /></label>
        </div>
      }
    </div>

    @if (busy()) { <p class="soft"><span class="spinner dark"></span> Traitement de l'image…</p> }

    <div class="pages">
      @for (s of saved(); track s.doc.uuid) {
        <figure>
          <button type="button" class="thumb" (click)="open(s)" [attr.aria-label]="'Ouvrir ' + s.doc.original_name">
            @if (s.url) { <img [src]="s.url" [alt]="s.doc.original_name" /> } @else { <wk-icon name="file" [size]="40" /> }
          </button>
          <figcaption>
            <span class="name">{{ s.doc.original_name }}</span>
            <small class="muted">{{ s.doc.uploaded_by_name }} · {{ s.doc.created_at | date: 'dd/MM/yyyy HH:mm' }}</small>
            @if (editable) { <button type="button" class="link danger" (click)="remove(s)">Retirer</button> }
          </figcaption>
        </figure>
      }
      @for (p of pending(); track p.file; let i = $index) {
        <figure class="new">
          <span class="thumb">
            @if (p.preview) { <img [src]="p.preview" [alt]="p.file.name" /> } @else { <wk-icon name="file" [size]="40" /> }
          </span>
          <figcaption>
            <span class="name">{{ p.file.name }}</span>
            <small class="muted">À enregistrer avec le dossier</small>
            <button type="button" class="link danger" (click)="drop(i)">Retirer</button>
          </figcaption>
        </figure>
      }
    </div>
    @if (!saved().length && !pending().length && !busy()) {
      <p class="muted empty">{{ editable ? 'Aucune fiche jointe pour le moment.' : 'Aucune fiche physique jointe.' }}</p>
    }
    @if (message()) { <div class="alert alert-danger" role="alert">{{ message() }}</div> }

    @if (viewer(); as v) {
      <div class="lightbox" (click)="viewer.set(null)" role="dialog" aria-modal="true" aria-label="Fiche de déclaration">
        <button type="button" class="close" (click)="viewer.set(null)" aria-label="Fermer"><wk-icon name="x" [size]="22" /></button>
        <img [src]="v.url" [alt]="v.name" (click)="$event.stopPropagation()" />
      </div>
    }
  `,
  styles: [`
    :host{display:block}
    .head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:12px}
    .head h2{font-size:16px}
    .head p{margin-top:4px;max-width:560px}
    .photo{background:var(--wk-royal);border-color:var(--wk-royal);color:#fff}
    .pages{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
    figure{margin:0;display:flex;flex-direction:column;gap:6px;min-width:0}
    .thumb{display:grid;place-items:center;aspect-ratio:3/4;border:1px solid var(--wk-border);border-radius:10px;background:#f4f7fc;overflow:hidden;padding:0;cursor:pointer;color:var(--wk-text-mute)}
    figure.new .thumb{cursor:default;border-style:dashed}
    .thumb img{width:100%;height:100%;object-fit:contain}
    figcaption{display:flex;flex-direction:column;gap:2px;font-size:13px;min-width:0}
    .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
    .link{align-self:flex-start;background:none;border:0;padding:0;font:inherit;color:var(--wk-royal);cursor:pointer}
    .link.danger{color:var(--wk-danger)}
    .empty{margin:4px 0 0}
    .alert{margin-top:12px}
    .lightbox{position:fixed;inset:0;z-index:200;background:rgba(7,27,68,.88);display:grid;place-items:center;padding:16px}
    .lightbox img{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;background:#fff}
    .close{position:absolute;top:12px;right:12px;width:44px;height:44px;border-radius:50%;border:0;background:#fff;color:var(--wk-navy-800);display:grid;place-items:center;cursor:pointer}
  `],
})
export class PaperFormComponent implements OnChanges, OnDestroy {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  /** UUID of an existing dossier; empty while creating one. */
  @Input() declaration = '';
  @Input() editable = true;

  @ViewChild('camera') camera?: ElementRef<HTMLInputElement>;
  @ViewChild('library') library?: ElementRef<HTMLInputElement>;

  saved = signal<Saved[]>([]);
  pending = signal<Pending[]>([]);
  busy = signal(false);
  message = signal('');
  viewer = signal<{ url: string; name: string } | null>(null);
  private urls: string[] = [];

  @HostListener('document:keydown.escape') closeViewer() { this.viewer.set(null); }

  ngOnChanges(c: SimpleChanges) { if (c['declaration']) this.load(); }
  ngOnDestroy() { this.urls.forEach(u => URL.revokeObjectURL(u)); }

  hasPending() { return this.pending().length > 0; }

  private track(blob: Blob) { const u = URL.createObjectURL(blob); this.urls.push(u); return u; }

  load() {
    if (!this.declaration) { this.saved.set([]); return; }
    this.api.get<Page<SupportingDocument>>('/documents/', { declaration: this.declaration, kind: 'PAPER_FORM', page_size: 50 }).subscribe({
      next: async page => {
        const items: Saved[] = await Promise.all(page.results.map(async doc => {
          if (!doc.content_type.startsWith('image/')) return { doc, url: null };
          try { return { doc, url: this.track(await firstValueFrom(this.api.blob(`/documents/${doc.uuid}/download/`))) }; }
          catch { return { doc, url: null }; }
        }));
        this.saved.set(items.sort((a, b) => a.doc.created_at.localeCompare(b.doc.created_at)));
      },
      error: () => this.saved.set([]),
    });
  }

  async pick(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    this.message.set(''); this.busy.set(true);
    try {
      for (const original of files) {
        const file = await shrink(original);
        if (this.declaration) await this.send(file);
        else this.pending.update(p => [...p, { file, preview: file.type.startsWith('image/') ? this.track(file) : null }]);
      }
    } finally { this.busy.set(false); }
  }

  private async send(file: File) {
    const fd = new FormData();
    fd.append('declaration', this.declaration); fd.append('kind', 'PAPER_FORM'); fd.append('file', file);
    try { await firstValueFrom(this.api.post<SupportingDocument>('/documents/', fd)); this.toast.success('Fiche jointe au dossier.'); this.load(); }
    catch (e) { this.message.set(`${file.name} : ${errorMessage(e)}`); }
  }

  drop(index: number) { this.pending.update(p => p.filter((_, i) => i !== index)); }

  /** Sends the files kept in memory to a dossier that has just been created. Returns the number of failures. */
  async uploadPending(declaration: string): Promise<number> {
    let failed = 0;
    for (const p of this.pending()) {
      const fd = new FormData();
      fd.append('declaration', declaration); fd.append('kind', 'PAPER_FORM'); fd.append('file', p.file);
      try { await firstValueFrom(this.api.post<SupportingDocument>('/documents/', fd)); }
      catch { failed++; }
    }
    return failed;
  }

  remove(s: Saved) {
    this.api.delete(`/documents/${s.doc.uuid}/`).subscribe({
      next: () => { this.toast.success('Page retirée du dossier.'); this.load(); },
      error: e => this.message.set(errorMessage(e)),
    });
  }

  open(s: Saved) {
    if (s.url) { this.viewer.set({ url: s.url, name: s.doc.original_name }); return; }
    this.api.blob(`/documents/${s.doc.uuid}/download/`).subscribe({
      next: b => { const u = URL.createObjectURL(new Blob([b], { type: s.doc.content_type })); window.open(u, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(u), 60000); },
      error: e => this.toast.error(errorMessage(e)),
    });
  }
}
