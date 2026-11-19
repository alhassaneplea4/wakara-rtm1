import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConsentService } from '../core/consent.service';

/** Cookie and local-storage banner: informs, and asks only for the (optional) anonymous audience measurement. */
@Component({
  selector: 'wk-consent-banner', imports: [RouterLink],
  template: `
    @if (consent.bannerVisible()) {
      <aside class="banner" role="dialog" aria-live="polite" aria-labelledby="cb-title">
        <div class="text">
          <strong id="cb-title">Cookies et stockage</strong>
          <p>Wakara ne dépose <strong>aucun cookie publicitaire ni de suivi</strong>. Il garde seulement sur votre appareil ce qui est nécessaire à son fonctionnement (session, mode hors connexion). Acceptez-vous en plus une <strong>mesure d'audience anonyme</strong> des pages publiques (un compteur, sans identifiant) ?
            <a routerLink="/cookies">En savoir plus</a></p>
        </div>
        <div class="buttons">
          <button type="button" class="btn" (click)="consent.refuse()">Refuser</button>
          <button type="button" class="btn btn-primary" (click)="consent.accept()">Accepter</button>
        </div>
      </aside>
    }`,
  styles: [`
    .banner{position:fixed;left:12px;right:12px;bottom:12px;z-index:900;display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap;
      max-width:960px;margin:0 auto;padding:14px 18px;background:#fff;border:1px solid var(--wk-border);border-radius:14px;box-shadow:var(--shadow-lg)}
    .text{flex:1 1 380px;font-size:13.5px;line-height:1.5} .text p{margin:4px 0 0}
    .buttons{display:flex;gap:10px}
    a{color:var(--wk-royal)}
  `],
})
export class ConsentBannerComponent { consent = inject(ConsentService); }
