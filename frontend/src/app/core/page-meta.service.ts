import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Meta } from '@angular/platform-browser';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { PUBLIC_PAGES } from './consent.service';

const ORIGIN = 'https://wakara-rtm.vercel.app';
const DESCRIPTIONS: Record<string, string> = {
  '/login': "Connexion à Wakara, la plateforme de la mairie de Ratoma pour enregistrer les déclarations et établir les actes de naissance. Accès réservé au personnel autorisé.",
  '/confidentialite': "Politique de confidentialité de Wakara : quelles données personnelles sont traitées, pourquoi, par qui, combien de temps, et vos droits.",
  '/conditions': "Conditions d'utilisation de Wakara, le service d'état civil de la mairie de Ratoma réservé au personnel autorisé.",
  '/mentions-legales': "Mentions légales de Wakara : éditeur, hébergement, conception et contact.",
  '/cookies': "Cookies et stockage local de Wakara : aucun cookie de suivi, mesure d'audience anonyme facultative.",
};

/**
 * Per-page meta tags (the static ones for crawlers that do not run scripts are in index.html). Only the public pages may
 * be indexed; every page of the application is « noindex ». The canonical address of a public page is set too.
 */
@Injectable({ providedIn: 'root' })
export class PageMetaService {
  private meta = inject(Meta);
  private router = inject(Router);
  private doc = inject(DOCUMENT);

  constructor() {
    this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd)).subscribe(e => this.apply(e.urlAfterRedirects.split(/[?#]/)[0]));
  }

  private apply(path: string) {
    const isPublic = PUBLIC_PAGES.includes(path);
    this.meta.updateTag({ name: 'robots', content: isPublic ? 'index, follow' : 'noindex, nofollow' });
    this.meta.updateTag({ name: 'description', content: DESCRIPTIONS[path] ?? DESCRIPTIONS['/login'] });
    this.meta.updateTag({ property: 'og:url', content: isPublic ? ORIGIN + path : ORIGIN + '/' });
    let canonical = this.doc.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) { canonical = this.doc.createElement('link'); canonical.rel = 'canonical'; this.doc.head.appendChild(canonical); }
    canonical.href = isPublic ? ORIGIN + path : ORIGIN + '/login';
  }
}
