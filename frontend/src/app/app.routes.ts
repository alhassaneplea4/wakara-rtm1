import { Routes } from '@angular/router';
import { authGuard, guestGuard, lockGuard, offlineGuard, permissionGuard } from './core/guards';
import { ShellComponent } from './layout/shell.component';
import { LoginComponent } from './features/login.component';
import { inject } from '@angular/core';
import { AuthService } from './core/auth.service';
import { Router } from '@angular/router';

export const routes: Routes = [
  { path: 'login', canActivate: [guestGuard], component: LoginComponent, title: 'Connexion — Wakara' },
  // offline mode: choose or type the code that protects the data kept on this device
  { path: 'verrouillage', canActivate: [lockGuard], title: 'Verrouillage — Wakara', loadComponent: () => import('./features/lock.component').then(m => m.LockComponent) },
  {
    path: '', component: ShellComponent, canActivate: [authGuard, offlineGuard], canActivateChild: [authGuard, offlineGuard],
    children: [
      {
        path: '', pathMatch: 'full',
        canActivate: [() => { const a = inject(AuthService); return inject(Router).createUrlTree([a.can('stats.view') ? '/dashboard' : '/declarations']); }],
        children: [],
      },
      { path: 'dashboard', canActivate: [permissionGuard], data: { perms: ['stats.view'] }, title: 'Tableau de bord — Wakara', loadComponent: () => import('./features/dashboard.component').then(m => m.DashboardComponent) },
      { path: 'declarations', canActivate: [permissionGuard], data: { perms: ['declaration.view'], mode: 'all' }, title: 'Déclarations — Wakara', loadComponent: () => import('./features/declarations-list.component').then(m => m.DeclarationsListComponent) },
      { path: 'declarations/new', canActivate: [permissionGuard], data: { perms: ['declaration.create'] }, title: 'Nouvelle déclaration — Wakara', loadComponent: () => import('./features/declaration-form.component').then(m => m.DeclarationFormComponent) },
      { path: 'declarations/:uuid/edit', canActivate: [permissionGuard], data: { perms: ['declaration.update', 'acte.update'] }, title: 'Modifier la déclaration — Wakara', loadComponent: () => import('./features/declaration-form.component').then(m => m.DeclarationFormComponent) },
      // the acte header now sits at the top of the edit form
      { path: 'declarations/:uuid/acte', redirectTo: 'declarations/:uuid/edit' },
      { path: 'declarations/:uuid', canActivate: [permissionGuard], data: { perms: ['declaration.view'] }, title: 'Dossier — Wakara', loadComponent: () => import('./features/declaration-detail.component').then(m => m.DeclarationDetailComponent) },
      // the secretariat queue is merged into « Déclarations »
      { path: 'secretariat', pathMatch: 'full', redirectTo: 'declarations' },
      { path: 'validation', canActivate: [permissionGuard], data: { perms: ['dossier.validate'], mode: 'validation' }, title: 'File de validation — Wakara', loadComponent: () => import('./features/declarations-list.component').then(m => m.DeclarationsListComponent) },
      { path: 'actes', canActivate: [permissionGuard], data: { perms: ['acte.view'] }, title: 'Actes de naissance — Wakara', loadComponent: () => import('./features/actes-list.component').then(m => m.ActesListComponent) },
      { path: 'actes/:uuid/document', canActivate: [permissionGuard], data: { perms: ['acte.view'] }, title: "Acte de naissance — Wakara", loadComponent: () => import('./features/acte-document.component').then(m => m.ActeDocumentComponent) },
      { path: 'deliveries', canActivate: [permissionGuard], data: { perms: ['acte.view'] }, title: 'Délivrances — Wakara', loadComponent: () => import('./features/deliveries.component').then(m => m.DeliveriesComponent) },
      { path: 'hospitals', canActivate: [permissionGuard], data: { perms: ['hospital.view'] }, title: 'Établissements — Wakara', loadComponent: () => import('./features/hospitals.component').then(m => m.HospitalsComponent) },
      { path: 'users', canActivate: [permissionGuard], data: { perms: ['user.view'] }, title: 'Utilisateurs — Wakara', loadComponent: () => import('./features/users.component').then(m => m.UsersComponent) },
      { path: 'roles', canActivate: [permissionGuard], data: { perms: ['role.view'] }, title: 'Rôles et permissions — Wakara', loadComponent: () => import('./features/roles.component').then(m => m.RolesComponent) },
      { path: 'history', canActivate: [permissionGuard], data: { perms: ['audit.view'] }, title: 'Historiques des actes — Wakara', loadComponent: () => import('./features/history-list.component').then(m => m.HistoryListComponent) },
      { path: 'history/:uuid', canActivate: [permissionGuard], data: { perms: ['audit.view'] }, title: "Historique d'un dossier — Wakara", loadComponent: () => import('./features/history-detail.component').then(m => m.HistoryDetailComponent) },
      { path: 'statistics', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'audit', canActivate: [permissionGuard], data: { perms: ['audit.view'] }, title: "Journal d'activité — Wakara", loadComponent: () => import('./features/audit.component').then(m => m.AuditComponent) },
      { path: 'appareils', canActivate: [permissionGuard], data: { perms: ['audit.view'] }, title: 'Appareils hors connexion — Wakara', loadComponent: () => import('./features/devices.component').then(m => m.DevicesComponent) },
      { path: 'settings', canActivate: [permissionGuard], data: { perms: ['settings.manage'] }, title: 'Paramètres — Wakara', loadComponent: () => import('./features/settings.component').then(m => m.SettingsComponent) },
      { path: 'synchronisation', title: 'Synchronisation — Wakara', loadComponent: () => import('./features/sync-center.component').then(m => m.SyncCenterComponent) },
      { path: 'profile', title: 'Mon profil — Wakara', loadComponent: () => import('./features/profile.component').then(m => m.ProfileComponent) },
      { path: 'forbidden', title: 'Accès refusé — Wakara', loadComponent: () => import('./features/errors.component').then(m => m.ForbiddenComponent) },
      { path: '**', title: 'Page introuvable — Wakara', loadComponent: () => import('./features/errors.component').then(m => m.NotFoundComponent) },
    ],
  },
];
