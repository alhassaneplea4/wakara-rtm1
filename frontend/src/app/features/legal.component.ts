import { HttpClient } from '@angular/common/http';
import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { environment } from '@env/environment';
import { ConsentService } from '../core/consent.service';

type Page = 'confidentialite' | 'conditions' | 'mentions-legales' | 'cookies';
type Texts = Record<string, string>;

const FALLBACK: Texts = {
  'legal.controller': "Mairie de Ratoma — Centre d'état civil et de l'identification (CECI Ratoma)",
  'legal.address': 'Ratoma, Conakry, République de Guinée',
  'legal.contact_email': '', 'legal.contact_phone': '', 'legal.data_officer': '',
  'legal.updated': '19 novembre 2026', 'legal.validated': 'false',
};

/**
 * Public pages (no sign-in): privacy policy, terms of use, legal notice, cookies and local storage.
 * The identity of the controller and the contact come from the public settings (editable by the administrator).
 */
@Component({
  selector: 'wk-legal', imports: [RouterLink],
  template: `
    <main class="legal">
      <header>
        <a routerLink="/" class="brand"><img src="assets/logo-mark.png" alt="" width="40" height="40" /> <strong>Wakara</strong> <span>État civil · Ratoma</span></a>
        <nav aria-label="Pages légales">
          <a routerLink="/confidentialite" [class.on]="page() === 'confidentialite'">Confidentialité</a>
          <a routerLink="/conditions" [class.on]="page() === 'conditions'">Conditions d'utilisation</a>
          <a routerLink="/mentions-legales" [class.on]="page() === 'mentions-legales'">Mentions légales</a>
          <a routerLink="/cookies" [class.on]="page() === 'cookies'">Cookies et stockage</a>
        </nav>
      </header>

      <article>
        @if (t('legal.validated') !== 'true') {
          <p class="draft" role="note"><strong>Version provisoire.</strong> Ce texte décrit le fonctionnement réel de Wakara ; il doit être relu et validé par la mairie (et son conseil juridique) avant d'être considéré comme définitif.</p>
        }

        @switch (page()) {
          @case ('confidentialite') {
            <h1>Politique de confidentialité</h1>
            <p class="meta">Dernière mise à jour : {{ t('legal.updated') }}</p>
            <p>Wakara est l'outil de la mairie de Ratoma pour enregistrer les déclarations de naissance et établir les actes de naissance. Cette page explique quelles données personnelles sont traitées, pourquoi, par qui, combien de temps, et comment exercer vos droits.</p>

            <h2>1. Qui est responsable ?</h2>
            <p><strong>{{ t('legal.controller') }}</strong>, {{ t('legal.address') }}.</p>
            @if (t('legal.data_officer')) { <p>Responsable de la protection des données : {{ t('legal.data_officer') }}.</p> }
            @if (contact()) { <p>Contact pour toute question ou pour exercer vos droits : {{ contact() }}.</p> }
            @else { <p>Les coordonnées de contact seront indiquées ici par la mairie.</p> }

            <h2>2. Quelles données ?</h2>
            <table>
              <thead><tr><th>Catégorie</th><th>Données</th><th>Qui est concerné</th></tr></thead>
              <tbody>
                <tr><td>Déclarations et actes de naissance</td><td>Identité de l'enfant (nom, prénoms, sexe, date, heure et lieu de naissance), identité des parents et du déclarant (noms, dates et lieux de naissance, nationalité, profession, domicile, téléphone, numéro personnel d'identification s'il est fourni), établissement de santé, références du registre, numéro officiel de l'acte</td><td>Enfants, parents, déclarants</td></tr>
                <tr><td>Pièces justificatives</td><td>Photo ou scan de la fiche de déclaration de l'hôpital et autres pièces jointes</td><td>Enfants, parents, déclarants</td></tr>
                <tr><td>Comptes du personnel</td><td>Identifiant, nom, prénoms, e-mail, téléphone, rôle et droits, dates de connexion, état de la double authentification (jamais le mot de passe en clair)</td><td>Agents, secrétaires, administrateurs</td></tr>
                <tr><td>Journal d'activité</td><td>Qui a fait quoi et quand (création, modification, validation, impression, délivrance, connexion), adresse IP et navigateur, motif des décisions</td><td>Personnel</td></tr>
                <tr><td>Mode hors connexion</td><td>Identifiant aléatoire de l'appareil, son libellé (ex. « Chrome · Android »), dates de dernier contact ; les données locales de l'appareil sont chiffrées</td><td>Personnel</td></tr>
                <tr><td>Audience des pages publiques</td><td>Un simple compteur par jour et par page (aucune adresse, aucun identifiant)</td><td>Visiteurs, si vous l'acceptez</td></tr>
              </tbody>
            </table>

            <h2>3. Pourquoi, et sur quelle base ?</h2>
            <ul>
              <li><strong>Tenir l'état civil</strong> : enregistrer les naissances, contrôler les dossiers, numéroter, imprimer et délivrer les actes. Il s'agit de l'exercice d'une mission de service public de la mairie et d'une obligation légale.</li>
              <li><strong>Sécurité et traçabilité</strong> : savoir qui a consulté ou modifié un dossier, détecter les abus, protéger les comptes (double authentification, limitation des tentatives). Intérêt légitime de la mairie et obligation de sécurité.</li>
              <li><strong>Éviter les doublons</strong> : comparer les déclarations pour qu'une même naissance ne produise jamais deux actes. Aucun dossier n'est supprimé ni fusionné automatiquement : une personne décide.</li>
              <li><strong>Mesure d'audience anonyme</strong> des pages publiques, seulement avec votre accord (voir « Cookies et stockage »).</li>
            </ul>
            <p>Les données ne sont <strong>ni vendues, ni utilisées pour de la publicité, ni de la prospection, ni du profilage</strong>.</p>

            <h2>4. Qui y a accès ?</h2>
            <ul>
              <li>Chaque membre du personnel ne voit que ce que son rôle autorise (l'agent de collecte ne voit que ses propres déclarations) ; les droits sont vérifiés par le serveur à chaque demande.</li>
              <li>Les prestataires techniques qui hébergent le service, dans la limite strictement nécessaire à son fonctionnement : <strong>Vercel</strong> (hébergement de l'application) et <strong>Neon</strong> (base de données PostgreSQL), actuellement situés <strong>hors de Guinée (États-Unis)</strong>. Le choix définitif de l'hébergement relève de la mairie.</li>
              <li>Aucune autre communication à des tiers, sauf obligation légale ou demande d'une autorité compétente.</li>
            </ul>

            <h2>5. Combien de temps ?</h2>
            <p>Les actes et les registres d'état civil sont conservés sans limite de durée, comme le veut leur nature ; la durée de conservation du reste (journal d'activité, brouillons, pièces) sera arrêtée par la mairie. Aucune donnée d'état civil n'est supprimée par l'application : elle est archivée.</p>

            <h2>6. Comment sont-elles protégées ?</h2>
            <ul>
              <li>Connexion chiffrée (HTTPS) imposée ; base de données accessible uniquement par le service ; pièces jointes jamais accessibles par une adresse publique.</li>
              <li>Mots de passe stockés sous forme d'empreinte ; verrouillage temporaire après des essais ratés ; double authentification possible ; sessions limitées dans le temps.</li>
              <li>Mode hors connexion : les données gardées sur l'appareil sont chiffrées et protégées par un code de verrouillage personnel ; un appareil perdu se révoque.</li>
              <li>Journal d'activité qui ne peut ni être modifié ni effacé ; sauvegardes de la base.</li>
            </ul>

            <h2>7. Vos droits</h2>
            <p>Vous pouvez demander l'accès aux données qui vous concernent, leur rectification, ou vous opposer à un traitement, dans les conditions prévues par la loi guinéenne sur la protection des données à caractère personnel. Un acte d'état civil validé ne peut être rectifié que par la procédure légale prévue pour l'état civil. Pour exercer vos droits, écrivez au responsable indiqué au point 1 ; en cas de désaccord, vous pouvez saisir l'autorité nationale compétente en matière de protection des données.</p>

            <h2>8. Modifications</h2>
            <p>Cette politique peut évoluer ; la date de dernière mise à jour figure en haut de la page.</p>
          }

          @case ('conditions') {
            <h1>Conditions d'utilisation</h1>
            <p class="meta">Dernière mise à jour : {{ t('legal.updated') }}</p>
            <h2>1. Objet</h2>
            <p>Wakara est un service interne de {{ t('legal.controller') }} réservé aux personnes à qui la mairie a ouvert un compte (agents de collecte, secrétariat, administrateurs). Il n'est pas ouvert au public.</p>
            <h2>2. Votre compte</h2>
            <ul>
              <li>Le compte est <strong>personnel</strong>. Ne communiquez à personne votre mot de passe, votre code de verrouillage ni vos codes de double authentification.</li>
              <li>Choisissez un mot de passe long et difficile à deviner, changez-le dès qu'il a pu être connu d'un tiers, et déconnectez-vous d'un poste partagé.</li>
              <li>Toute action faite avec votre compte est enregistrée à votre nom : vous en répondez.</li>
            </ul>
            <h2>3. Ce qui est permis, et ce qui ne l'est pas</h2>
            <ul>
              <li>Utiliser Wakara uniquement pour les missions d'état civil de la mairie, dans la limite de votre rôle.</li>
              <li>Interdit : consulter des dossiers sans besoin professionnel, copier ou diffuser des données d'état civil hors du cadre du service, contourner les protections, tenter d'accéder aux comptes ou aux données d'autrui, introduire des fichiers piégés, perturber le service.</li>
              <li>Saisir les informations fidèlement, comme sur la fiche reçue de l'hôpital ; ne jamais inventer une information.</li>
            </ul>
            <h2>4. Appareils et mode hors connexion</h2>
            <p>L'appareil sur lequel vous travaillez hors connexion vous est confié : verrouillez-le quand vous le posez, synchronisez au moins une fois par jour, et prévenez immédiatement l'administrateur en cas de perte ou de vol (il pourra le révoquer). Le code de récupération ne se communique que par l'administrateur, après vérification de votre identité.</p>
            <h2>5. Confidentialité</h2>
            <p>Les données d'état civil sont des données personnelles : elles sont couvertes par le secret professionnel. Cette obligation continue après la fin de vos fonctions.</p>
            <h2>6. Traçabilité et contrôles</h2>
            <p>L'activité est journalisée (qui, quoi, quand, adresse IP). Ce journal peut être consulté par les administrateurs habilités et par les autorités compétentes.</p>
            <h2>7. Disponibilité et responsabilité</h2>
            <p>La mairie s'efforce d'assurer la disponibilité du service sans la garantir ; il peut être interrompu pour maintenance. Un abus constaté peut entraîner la suspension du compte et des suites disciplinaires ou judiciaires.</p>
            <h2>8. Droit applicable</h2>
            <p>Les présentes conditions sont soumises au droit guinéen.</p>
          }

          @case ('mentions-legales') {
            <h1>Mentions légales</h1>
            <p class="meta">Dernière mise à jour : {{ t('legal.updated') }}</p>
            <h2>Éditeur du service</h2>
            <p>{{ t('legal.controller') }}<br />{{ t('legal.address') }}
              @if (t('legal.contact_phone')) { <br />Téléphone : {{ t('legal.contact_phone') }} }
              @if (t('legal.contact_email')) { <br />E-mail : {{ t('legal.contact_email') }} }</p>
            <h2>Conception et développement</h2>
            <p>MAF TECH.</p>
            <h2>Hébergement</h2>
            <p>Application : Vercel Inc. (États-Unis). Base de données : Neon (États-Unis). Ces choix d'hébergement sont ceux de démarrage et peuvent évoluer à la demande de la mairie.</p>
            <h2>Propriété intellectuelle</h2>
            <p>Le nom, le logo et les contenus de Wakara sont la propriété de leurs titulaires respectifs ; la répartition des droits sur le code source est précisée dans le procès-verbal de livraison.</p>
            <h2>Signaler un problème de sécurité</h2>
            <p>Si vous constatez une faille ou un comportement anormal, écrivez au contact ci-dessus sans diffuser l'information. Merci de ne pas accéder à des données qui ne sont pas les vôtres.</p>
            <h2>Données personnelles</h2>
            <p>Voir la <a routerLink="/confidentialite">politique de confidentialité</a>.</p>
          }

          @case ('cookies') {
            <h1>Cookies et stockage local</h1>
            <p class="meta">Dernière mise à jour : {{ t('legal.updated') }}</p>
            <p>Wakara <strong>ne dépose aucun cookie publicitaire ni de suivi</strong> et n'utilise aucun service de statistiques tiers (ni Google Analytics, ni réseau social).</p>
            <h2>Stockage nécessaire au fonctionnement (pas de consentement requis)</h2>
            <table>
              <thead><tr><th>Élément</th><th>Rôle</th><th>Durée</th></tr></thead>
              <tbody>
                <tr><td>Jetons de session (stockage de session, ou stockage local si « Se souvenir de moi »)</td><td>Vous garder connecté</td><td>Fermeture de l'onglet, ou 7 jours au plus</td></tr>
                <tr><td>Service worker et cache de l'application</td><td>Ouvrir Wakara même sans Internet (jamais les données : l'API n'est pas mise en cache)</td><td>Jusqu'à désinstallation</td></tr>
                <tr><td>Base locale chiffrée (IndexedDB) et en-tête du coffre</td><td>Mode hors connexion : saisies en attente, protégées par votre code de verrouillage</td><td>Jusqu'à synchronisation, déconnexion complète ou effacement</td></tr>
                <tr><td>Identifiant aléatoire de l'appareil</td><td>Reconnaître l'appareil pour la synchronisation et la révocation</td><td>Jusqu'à effacement des données du site</td></tr>
                <tr><td>Votre choix sur ce bandeau</td><td>Mémoriser votre réponse</td><td>12 mois</td></tr>
              </tbody>
            </table>
            <h2>Mesure d'audience (avec votre accord)</h2>
            <p>Si vous acceptez, Wakara compte les visites des <strong>pages publiques</strong> (connexion, pages légales) : un compteur par jour et par page, sans adresse IP, sans identifiant, sans cookie, sans lien avec votre compte. Les pages de l'application (qui contiennent des dossiers) ne sont <strong>jamais</strong> comptées. Si votre navigateur envoie « Do Not Track » ou « Global Privacy Control », rien n'est compté.</p>
            <p>Votre choix actuel : <strong>{{ consent.choice() === 'unset' ? 'pas encore choisi' : consent.audience() ? 'mesure acceptée' : 'mesure refusée' }}</strong>.</p>
            <p class="actions">
              <button type="button" class="btn btn-primary" (click)="consent.accept()">Accepter la mesure d'audience</button>
              <button type="button" class="btn" (click)="consent.refuse()">La refuser</button>
            </p>
          }
        }
      </article>

      <footer>
        <a routerLink="/login">Retour à la connexion</a>
        <span>·</span><a routerLink="/confidentialite">Confidentialité</a>
        <span>·</span><a routerLink="/conditions">Conditions</a>
        <span>·</span><a routerLink="/mentions-legales">Mentions légales</a>
        <span>·</span><a routerLink="/cookies">Cookies</a>
      </footer>
    </main>`,
  styles: [`
    .legal{min-height:100vh;background:var(--wk-bg);color:var(--wk-text)}
    header{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;justify-content:space-between;padding:14px clamp(16px,4vw,48px);background:#fff;border-bottom:1px solid var(--wk-border)}
    .brand{display:flex;gap:10px;align-items:center;text-decoration:none;color:var(--wk-royal-dark,#0b2b6b)}
    .brand span{color:var(--wk-text-soft);font-size:13px}
    nav{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:14px}
    nav a{color:var(--wk-text-soft);text-decoration:none;padding:4px 0;border-bottom:2px solid transparent}
    nav a.on,nav a:hover{color:var(--wk-royal);border-color:var(--wk-royal)}
    article{max-width:860px;margin:0 auto;padding:28px clamp(16px,4vw,32px) 8px;line-height:1.65}
    h1{font-size:28px;margin:0 0 4px} h2{font-size:18px;margin:26px 0 6px}
    .meta{color:var(--wk-text-soft);font-size:13px;margin:0 0 16px}
    .draft{padding:10px 14px;border-radius:10px;background:var(--wk-warning-bg);color:#7a4700;font-size:14px}
    table{width:100%;border-collapse:collapse;font-size:14px;margin:8px 0}
    th,td{border:1px solid var(--wk-border);padding:8px 10px;text-align:left;vertical-align:top}
    th{background:var(--wk-info-bg);color:var(--wk-royal)}
    ul{padding-left:22px} li{margin:4px 0}
    .actions{display:flex;gap:10px;flex-wrap:wrap}
    footer{display:flex;flex-wrap:wrap;gap:6px 10px;justify-content:center;padding:24px 16px 40px;font-size:13px;color:var(--wk-text-soft)}
    footer a{color:var(--wk-royal)}
  `],
})
export class LegalComponent implements OnInit {
  private http = inject(HttpClient);
  consent = inject(ConsentService);
  /** Which page: given by the route (`data.page`, bound as an input). */
  page = input<Page>('confidentialite');
  private texts = signal<Texts>(FALLBACK);
  contact = computed(() => [this.t('legal.contact_email'), this.t('legal.contact_phone')].filter(Boolean).join(' · '));

  t(key: string): string { return this.texts()[key] ?? FALLBACK[key] ?? ''; }

  ngOnInit() {
    this.http.get<Texts>(`${environment.apiUrl}/public/settings/`).subscribe({
      next: s => this.texts.set({ ...FALLBACK, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== '')) }),
      error: () => undefined,   // offline: the built-in text is shown
    });
  }
}
