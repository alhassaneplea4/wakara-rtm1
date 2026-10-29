# Compte rendu des tests

Dernière mise à jour : 29/10/2026 — Windows 11, Python 3.14, Django 5.2, Node 24, Angular 17.

## 1. Backend — `python manage.py test tests` : **76 tests, tous réussis**

| Domaine | Fichier | Ce qui est vérifié |
|---|---|---|
| Authentification | `test_auth_permissions.py` | Connexion (identifiant / e-mail), 401 générique sans énumération de comptes, verrouillage après échecs, compte désactivé refusé **même avec un jeton déjà émis**, déconnexion = refresh token en liste noire, 401 anonyme partout, changement de mot de passe forcé, mots de passe faibles refusés, aucun mot de passe dans le journal |
| Permissions | idem | Superuser Django sans permission métier ; admin Wakara ≠ superuser ; chaque rôle limité à ses droits ; permissions *fail-closed* ; surcharges par utilisateur ; rôle inactif sans effet |
| Anti-escalade | idem | Pas de modification de ses propres rôles / permissions / statut ; `is_superuser`, `is_staff`, rôles ignorés à la création et sur le profil ; le rôle admin garde ses permissions de verrouillage ; utilisateurs et rôles non supprimables |
| Workflow | `test_workflow.py` | Circuit complet + historique ; seul l'admin valide / rejette ; statut non forçable ; transitions sautées refusées ; motif obligatoire ; retours collecte / secrétariat ; dossiers figés ; verrouillage selon le service ; données minimales exigées ; visibilité limitée pour l'agent |
| Numérotation | idem | Numéro manuel requis par défaut ; doublon refusé par registre (rollback complet) ; numérotation automatique seulement si activée ; numéro jamais écrasé |
| Documents d'acte | idem | Aperçu non officiel avant validation ; impression / délivrance refusées avant validation et à l'agent |
| Intégrité | `test_integrity.py` | `delete()` bloqué partout ; `DELETE` API = archivage tracé ; établissement utilisé désactivé / archivé sans perte ; `AuditLog` et `StatusHistory` en ajout seul ; API d'audit en lecture seule |
| Audit | idem | `created_by` / `updated_by` côté serveur ; diff des champs ; consultation et export du journal tracés ; exports réservés ; événements de gestion des comptes |
| Pièces | idem | Dépôt, SHA-256, téléchargement authentifié et audité ; extension / signature / taille ; accès hors visibilité refusé ; dossier figé ; nom aléatoire |
| Statistiques | idem | KPI, répartitions, série mensuelle = données de la base ; filtres ; périmètre ; compteurs de notifications |
| Divers | `test_misc.py` | Filtre « responsable » (sans doublon, réservé aux profils autorisés) ; textes publics de connexion seuls exposés ; édition des paramètres protégée et auditée ; journal filtrable par dossier |
| Sauvegarde | `test_backup.py` | Sauvegarde → corruption → restauration SQLite |

## 2. Frontend

- `npm run build` (production) : **réussi, sans avertissement** (bundle initial 562 ko).
- `tsc -p tsconfig.spec.json` : les tests unitaires **compilent**.
- Tests unitaires `core.spec.ts` (aides d'erreur API, gardes, déconnexion / expiration de session) : **non exécutés** — aucun navigateur headless
  exploitable dans l'environnement de développement (Chrome absent, Edge refuse de démarrer sous Karma). À lancer avec `npm test` sur un poste avec Chrome.

### Vérifications manuelles dans le navigateur (données de démonstration, API réelle)

| Parcours | Résultat |
|---|---|
| Connexion (bureau et mobile 375 px), redirection selon les droits | OK, pas de débordement horizontal |
| Les 13 entrées du menu, cliquées à la suite | OK : bonne page, données chargées, aucun message d'erreur |
| Déconnexion depuis le menu latéral, le tiroir mobile et le menu du compte (jeton en `sessionStorage` et en `localStorage`) | OK : retour à `/login`, jetons effacés, événement `logout` dans le journal |
| **Circuit complet par l'interface** : création → transmission → prise en charge → soumission refusée si champs manquants (message clair) → complément de l'acte → déclarant → soumission → validation refusée sans numéro → validation avec n° → aperçu officiel → délivrance | OK |
| Historique du dossier et journal d'audit du dossier | OK (10 événements tracés pour le dossier de test) |
| Fiche utilisateur : informations, rôles, ajustements, historique | Affichage OK |
| Filtre « Responsable » (liste des dossiers) | OK après correction d'un doublon (test ajouté) |
| Aucun débordement horizontal sur les 13 pages en largeur étroite (636 px) | OK après correction des petits tableaux des statistiques |
| Établissements : création (code normalisé en majuscules), désactivation, archivage, liste des archivés avec « Restaurer » | OK |
| Paramètres : modification d'un texte de la page de connexion → visible publiquement, puis rétabli | OK |
| Rôles : ajout d'une permission à un rôle, enregistrement côté serveur, puis rétabli | OK |
| Création d'un utilisateur : mot de passe faible refusé (messages en français) puis accepté ; attribution d'un rôle depuis la fiche | OK |
| **Profil secrétaire** (compte de test créé par l'interface) : changement de mot de passe forcé (navigation ailleurs bloquée, confirmation contrôlée), menu limité (sans validation, utilisateurs, rôles, journal, paramètres), `/users` et `/validation` → « Accès refusé », aucune action de décision sur un dossier en attente, validation forcée par l'API → 403 | OK |
| **Profil agent de collecte** : mot de passe forcé, arrivée sur Déclarations (pas de tableau de bord), menu limité, uniquement ses dossiers, ni export ni filtre responsable, aucune action de gestion sur les établissements | OK |
| Pièce jointe : fichier au contenu falsifié (`.pdf` factice) refusé avec message ; PDF valide ajouté, listé (type et taille lisibles), ouverture authentifiée | OK |
| Export CSV des déclarations (`declarations.csv`, séparateur `;`, en-têtes français) et événement d'audit associé | OK |
| Graphiques des statistiques (barres reçues / validées, anneau par statut) et tableaux | Affichage OK |
| Débordement horizontal en largeur étroite sur le formulaire, la fiche dossier, le complément d'acte et l'aperçu de l'acte | Aucun |
| Comptes de test créés pour ces contrôles | Désactivés à la fin (les comptes ne se suppriment pas) |

## 3. Défauts constatés et corrigés (cette passe)

| Symptôme signalé / constaté | Cause | Correction |
|---|---|---|
| Le menu latéral ne répondait plus, la déconnexion ne redirigeait pas | Onglet resté ouvert après l'arrêt / la reconstruction du serveur : les pages chargées à la demande (dont **la page de connexion**) n'existaient plus (`Failed to fetch dynamically imported module`) | Page de connexion chargée d'emblée ; déconnexion qui vide d'abord la session puis redirige, avec rechargement forcé de `/login` si le routeur échoue ; gestionnaire d'erreur de navigation qui recharge la page cible (une fois) ou affiche un message ; plus aucune dépendance au réseau pour se déconnecter |
| Tiroir de menu mobile rogné / défilé, éléments inaccessibles | Tout le panneau défilait, titre et pied sortaient de l'écran | En-tête, « Mon profil » et « Déconnexion » fixes, seul le menu défile ; bouton de fermeture, touche Échap, fermeture au changement de page et au redimensionnement |
| Liens `javascript:void(0)` (déconnexion, mot de passe oublié) | Mauvaise pratique d'accessibilité et fragile | Vrais boutons |
| Message « session expirée » possible juste après une déconnexion volontaire | 401 tardifs d'une requête en vol | Drapeau de déconnexion volontaire |
| Messages d'erreur avec noms de champs techniques (`numero_acte : …`) | Affichage brut de l'API | Libellés français |
| Un utilisateur « mot de passe à changer » pouvait naviguer ailleurs depuis le menu (l'API refusait avec un message brut) | Garde d'authentification exécuté seulement à l'entrée dans l'application | Garde appliqué à toutes les routes enfants |
| Barre de défilement horizontale sur les statistiques en largeur étroite | Petits tableaux avec largeur minimale de 640 px | Variante de tableau compacte |
| Doublons dans le filtre « Responsable » | Tri par défaut ajouté au `DISTINCT` | `order_by()` + test |

## 4. Non testé / limites connues

- **Non vérifié** : l'impression réelle (boîte de dialogue du navigateur), le rendu sur un vrai téléphone (seulement émulation de largeur), la sélection d'un fichier avec le sélecteur natif (simulée par script).
- Impression réelle (boîte de dialogue du navigateur) non déclenchée ; l'enregistrement de l'impression est testé côté API.
- PostgreSQL, `pg_dump` / `pg_restore`, charge et concurrence non testés (SQLite uniquement ; les verrous de ligne n'ont pas d'effet sous SQLite).
- Accessibilité : attributs ARIA et navigation clavier de base, pas d'audit formel.
- `check --deploy` : seules alertes restantes = avertissements de schéma OpenAPI et `SECURE_HSTS_PRELOAD` (facultatif).
