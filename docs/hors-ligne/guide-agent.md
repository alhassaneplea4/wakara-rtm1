# Travailler sans connexion — guide de l'agent de collecte

## Première utilisation sur un appareil

1. Connectez-vous **avec Internet**, comme d'habitude.
2. Wakara vous demande de choisir un **code de verrouillage** (6 caractères au minimum). Ce code protège les déclarations enregistrées sur l'appareil.
3. **Notez-le** dans un endroit sûr (pas sur le téléphone). Si vous l'oubliez, l'administrateur peut vous aider (voir « Code oublié » plus bas) ; sans cette aide, les déclarations de l'appareil qui n'ont pas encore été envoyées seraient perdues.

Vous pouvez choisir « Continuer sans le mode hors connexion » sur un ordinateur partagé : vous travaillerez alors uniquement en ligne.

## Au quotidien

- À chaque ouverture de Wakara, saisissez votre code. Cela fonctionne **sans Internet**.
- En haut de l'écran, la pastille indique **En ligne** ou **Hors connexion**, et le nombre d'opérations en attente.
- Sans connexion, vous pouvez créer une déclaration, la modifier, prendre la fiche en photo et la transmettre au secrétariat. Tout est enregistré sur l'appareil.
- Dès que la connexion revient, Wakara envoie tout **automatiquement**. Vous pouvez aussi appuyer sur **Synchroniser**.

## Savoir où en est chaque déclaration

Dans la liste et sur chaque dossier, un indicateur vous le dit :

| Indicateur | Ce que cela veut dire | Que faire |
|---|---|---|
| **En ligne** (vert) | Le dossier est sur le serveur. | Rien. |
| **Sur cet appareil** (orange) | Le dossier n'existe que sur votre appareil. Sa référence commence par `LOCAL-`. | Il partira au retour de la connexion. |
| **Modifications à envoyer** (orange) | Le dossier est sur le serveur, mais vos dernières modifications ne le sont pas encore. | Elles partiront au retour de la connexion. |
| **Envoi en cours** (bleu) | L'envoi est en train de se faire. | Patientez. |
| **Refusée par le serveur** (rouge) | Le serveur n'a pas accepté une opération (information manquante, par exemple). | Ouvrez le dossier : le motif est affiché. Corrigez puis « Renvoyer ». |
| **Conflit à résoudre** (rouge) | Le dossier a changé sur le serveur pendant que vous travailliez hors connexion. | Ouvrez le dossier et choisissez la version à garder. Rien n'est écrasé sans votre choix. |

Une fois envoyé, le dossier reçoit sa vraie référence (`WKR-…`).

Le menu **Synchronisation** liste toutes les opérations de l'appareil : en attente, envoyées, refusées.

## Photos de la fiche

Le menu « Qualité des photos » propose :

- **Qualité standard** — le bon choix en général ;
- **Économique (léger)** — prend moins de place et s'envoie plus vite sur un réseau faible ;
- **Haute qualité** — pour une fiche difficile à lire.

Une photo en attente porte l'indicateur « Sur cet appareil » ; elle est supprimée de l'appareil dès que le serveur l'a reçue.

## Quitter l'appareil

- **Verrouiller l'appareil** (pastille de connexion, ou menu de votre compte) : vos déclarations restent sur l'appareil, protégées par votre code. À utiliser chaque fois que vous posez le téléphone.
- **Déconnexion** : toujours possible. Vos déclarations non synchronisées **restent sur l'appareil (chiffrées)** et partent à votre prochaine connexion. Le code de verrouillage se crée **une seule fois par appareil** : après une reconnexion, vous le saisissez simplement pour déverrouiller.
- Après 15 minutes sans activité, l'appareil se verrouille tout seul. S'il reste des saisies à envoyer et que la connexion est là, elles sont **envoyées avant l'oubli de la clé** (10 minutes au plus). Verrouillé ou page fermée, l'appareil n'envoie plus rien : pensez à synchroniser avant de quitter une zone couverte.
- **Saisie non enregistrée** : si le téléphone se verrouille, se recharge ou se ferme pendant la saisie d'une déclaration, Wakara la propose à la réouverture (« Reprendre cette saisie »). Les photos non enregistrées ne sont pas gardées.
- **Page ancienne** : hors connexion, une page déjà consultée s'affiche avec la date de sa copie ; elle peut ne plus être à jour.
- **Rappel** : une bannière rouge apparaît quand des saisies attendent depuis plus de 24 heures.
- **Sauvegarde de secours** (page Synchronisation) : enregistre dans un fichier ce qui n'est pas encore envoyé. À garder ailleurs que sur le téléphone (courriel à soi-même, autre appareil). Si le navigateur efface les données, écran de code → « Restaurer une sauvegarde de secours », puis reconnexion et code d'origine.
- **iPhone** : installez Wakara sur l'écran d'accueil (Partager → « Sur l'écran d'accueil »). Hors application installée, Safari peut effacer les données après 7 jours sans usage.

## En cas de problème

- **« Session expirée »** : vos saisies sont intactes. Appuyez sur « Se reconnecter » et saisissez votre mot de passe ; l'envoi reprend.
- **Code oublié** : écran de verrouillage → « Code oublié ? » → **appelez l'administrateur**. Après avoir vérifié qui vous êtes, il vous dicte un **code de récupération** (24 caractères, par groupes de 4). Touchez « J'ai un code de récupération », saisissez-le et choisissez un nouveau code de verrouillage : l'appareil s'ouvre avec **toutes vos déclarations non envoyées**. Ce code ne sert qu'une fois (l'appareil en prépare un nouveau). Si l'écran ne propose pas de code de récupération, la seule issue est d'effacer les données de l'appareil avec le mot de passe de votre compte : les déclarations non envoyées seraient alors perdues.
- **Double authentification** : si votre compte l'utilise, après le mot de passe saisissez le code à 6 chiffres de votre application d'authentification (ou un code de secours). Téléphone perdu : contactez l'administrateur.
- **Appareil révoqué** : contactez l'administrateur. Vos déclarations restent sur l'appareil en attendant.
- **Appareil perdu ou volé** : prévenez tout de suite l'administrateur, qui le révoquera.

Conseil : synchronisez dès que vous avez du réseau, et au moins une fois par jour.
