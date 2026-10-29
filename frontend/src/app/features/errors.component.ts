import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'wk-forbidden', standalone: true, imports: [RouterLink],
  template: `<div class="page"><div class="card empty"><strong>Accès refusé</strong>
    <p>Votre rôle ne vous autorise pas à consulter cette page. Si vous pensez que c'est une erreur, contactez l'administrateur technique.</p>
    <p style="margin-top:16px"><a class="btn btn-primary" routerLink="/">Retour à l'accueil</a></p></div></div>`,
})
export class ForbiddenComponent {}

@Component({
  selector: 'wk-not-found', standalone: true, imports: [RouterLink],
  template: `<div class="page"><div class="card empty"><strong>Page introuvable</strong>
    <p>L'adresse demandée n'existe pas ou a été déplacée.</p>
    <p style="margin-top:16px"><a class="btn btn-primary" routerLink="/">Retour à l'accueil</a></p></div></div>`,
})
export class NotFoundComponent {}
