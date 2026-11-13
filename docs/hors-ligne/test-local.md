# Tester le mode hors connexion en local

Banc d'essai isolé : une base SQLite à part, des comptes fictifs, le **build de production** (le service worker n'existe que dans ce build — `ng serve` ne permet donc pas de tester le hors-ligne). Rien n'est envoyé nulle part et la base de développement n'est pas touchée.

## Lancer

Depuis le dossier `frontend` :

```bash
npm run local
```

Au premier lancement (environ une minute) : construction de l'application, création de la base, des comptes et de 4 dossiers d'exemple. Les lancements suivants réutilisent la base. Pour repartir de zéro :

```bash
npm run local:reset
```

Le terminal affiche l'adresse, les comptes et le mot de passe (rappelés dans `frontend/.local-test/identifiants.txt`, ignoré par git). `Ctrl+C` arrête tout.

| Adresse | Rôle |
|---|---|
| <http://localhost:4321> | Wakara (même adresse pour le site et l'API, comme sur Vercel) |
| <http://localhost:4321/__test> | Panneau de pannes simulées |

| Compte | Usage |
|---|---|
| `agent.collecte` | L'agent qui travaille hors ligne. Il a 4 dossiers : un brouillon (Mariama Diallo), un transmis (Ibrahima Bah), un à corriger (Aissatou Camara) et un validé (Mamadou Sylla). |
| `agent2.collecte` | Un second agent, pour tester « un autre compte sur le même appareil ». |
| `secretaire` | Secrétaire d'état civil. |
| `admin` | Administrateur : écran « Appareils hors connexion », Paramètres, journal d'audit. |

Utilisez **Chrome** (ou Edge) sur `http://localhost:4321`. N'utilisez pas `http://127.0.0.1` : le chiffrement et le service worker demandent `localhost`.

## Couper le réseau

Deux façons, au choix :

- **Mode avion du navigateur** : DevTools (`F12`) → onglet *Réseau* → *Hors connexion*. C'est la coupure la plus réaliste (la page peut même être rechargée).
- **Panneau de pannes** (`/__test`, dans un autre onglet) : le navigateur croit être en ligne mais le serveur ne répond plus, comme avec un signal sans données.

| Mode du panneau | Ce qu'il simule |
|---|---|
| `panne` | Le serveur ne répond plus. |
| `expiree` | Le serveur refuse la session (jeton expiré) ; la connexion reste possible. |
| `perdue` | La prochaine synchronisation est appliquée **mais sa réponse est perdue** (une seule fois) : on doit voir un seul dossier créé, pas deux. |
| `normal` | Tout fonctionne. |

## Parcours à essayer

Connectez-vous en `agent.collecte`, une fois **avec Internet** : l'écran « Protégez cet appareil » apparaît, choisissez un code (6 caractères minimum, pas de suite évidente comme `123456`).

1. **Mise en cache** : restez 10 secondes en ligne, puis passez *Hors connexion* et rechargez la page : elle doit s'ouvrir sur l'écran de code. Déverrouillez : les 4 dossiers sont là.
2. **Saisie hors ligne** : *Nouvelle déclaration*, remplissez (date, heure, lieu, sexe de l'enfant au minimum), ajoutez une photo, enregistrez. Le dossier apparaît avec la référence `LOCAL-…` et l'indicateur orange **Sur cet appareil**. Le bandeau jaune et la pastille *Hors connexion* sont visibles.
3. **Modifier hors ligne** : ouvrez le dossier, « Modifier », changez un champ.
4. **Transmettre hors ligne** : « Transmettre au secrétariat ». Le dossier passe en *Transmis*, toujours **Sur cet appareil**, et n'est plus modifiable.
5. **Retour de la connexion** : décochez *Hors connexion*. Les indicateurs passent à **En ligne** et la référence devient `WKR-…`. Vérifiez côté serveur en vous connectant en `secretaire` (dans une fenêtre privée) : la déclaration transmise est dans sa liste.
6. **Écran Synchronisation** : liste des opérations, état de chacune, journal.
7. **Déconnexion bloquée** : hors ligne, créez un dossier, puis cliquez *Déconnexion* : Wakara refuse et explique pourquoi. « Verrouiller l'appareil » fonctionne.
8. **Autre compte** : appareil verrouillé avec un dossier en attente, essayez de vous connecter en `agent2.collecte` : refusé tant que le premier n'a pas synchronisé.
9. **Code erroné** : 5 mauvais codes → blocage temporaire.
10. **Réponse perdue** (panneau → `perdue`) : créez un dossier, observez : un seul dossier à la fin.
11. **Session expirée** (panneau → `expiree`) : le bandeau rouge « Session expirée » apparaît, vous continuez à saisir ; repassez en `normal`, « Se reconnecter », la file part.
12. **Conflit** : ouvrez le dossier « Mariama Diallo » hors ligne, modifiez-le ; sans fermer l'onglet, ouvrez un second profil de navigateur, connectez-vous en `agent.collecte` (avec un autre code, c'est un autre appareil), modifiez le même dossier et laissez-le synchroniser ; revenez au premier onglet, remettez le réseau : **Conflit à résoudre**.
13. **Dossier à corriger** : « Aissatou Camara » est modifiable hors ligne puis retransmissible ; le dossier validé n'est jamais modifiable.
14. **Administrateur** : connectez-vous en `admin` (fenêtre privée) → *Appareils hors connexion* : l'appareil de l'agent y apparaît ; *Révoquer* puis resynchroniser côté agent : le message « appareil révoqué » s'affiche.
15. **Interrupteur à distance** : `admin` → *Paramètres* : le réglage `offline.enabled` figure dans la liste. Mis à `false` puis enregistré, l'appareil de l'agent revient au mode en ligne à son prochain contact.

## Deux appareils sur la même machine

Un profil de navigateur = un « appareil » (chaque profil a son identifiant, son code et sa base). Utilisez deux profils Chrome, ou une fenêtre de navigation privée, pour simuler deux téléphones.

## Remettre à zéro l'appareil seulement

DevTools → *Application* → *Stockage* → *Effacer les données du site* : efface le code et la base locale de ce navigateur (le serveur garde ses données). Pour effacer aussi le serveur de test : `npm run local:reset`.

## Tests automatiques

```bash
npm run test:ci      # tests unitaires
npm run e2e          # 6 scénarios de bout en bout (base temporaire, indépendante du banc d'essai)
```

## Limites de ce banc d'essai

- Un téléphone réel (Android, iOS) n'est pas couvert. Pour l'essayer en local, utilisez le débogage USB de Chrome avec la redirection de port (`chrome://inspect` → *Port forwarding* `4321 → localhost:4321`) : l'adresse reste `localhost`, donc le service worker fonctionne.
- Le comportement sous Vercel (en-têtes de cache du service worker, démarrages à froid de la base) ne se teste qu'avec un aperçu Vercel.
