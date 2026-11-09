import { h1, h2, p, ul, table, form, sign, note, BOX } from '../dsl.mjs';
import { META } from '../meta.mjs';

const R = `${BOX} Conforme\n${BOX} Non conforme\n${BOX} Réserve`;
const sc = (id, scenario, attendu) => [id, scenario, attendu, R, ''];
const SCEN = { head: ['N°', 'Scénario à réaliser', 'Résultat attendu', 'Résultat', 'Observations'], widths: [0.7, 3.4, 3.1, 1.5, 1.9], small: true, zebra: true };

export default {
  title: 'Procès-verbal de recette',
  subtitle: 'Vérification par la mairie que la solution correspond au cahier des charges',
  audience: 'Client et prestataire',
  toc: false,
  blocks: [
    h1('Objet et mode d\'emploi'),
    p(`La recette est l'étape où la ${META.clientCourt} vérifie, par elle-même, que Wakara fait bien ce qui a été demandé dans le cahier des charges (document 01). Ce procès-verbal liste les scénarios à rejouer, enregistre le résultat de chacun, les anomalies constatées, les réserves éventuelles et la décision d'acceptation.`),
    p('Chaque scénario se joue **avec le profil indiqué** (agent de collecte, secrétariat, administrateur technique) et, de préférence, avec des **données fictives** tant que la mairie n\'a pas autorisé l\'usage de données réelles. Le manuel utilisateur (document 03) décrit chaque manipulation pas à pas.'),
    table({
      head: ['Résultat', 'Signification'], widths: [2, 8], zebra: false,
      rows: [
        [`${BOX} **Conforme**`, 'Le résultat obtenu est celui qui était attendu.'],
        [`${BOX} **Non conforme**`, 'Le résultat est différent de l\'attendu : une anomalie doit être décrite dans le tableau des anomalies.'],
        [`${BOX} **Réserve**`, 'Le résultat est acceptable en l\'état, mais la mairie demande une amélioration ou une précision, à lever avant une date convenue.'],
      ],
    }),

    h1('Informations sur la recette'),
    form([
      ['Projet', `${META.projet} — ${META.intitule}`],
      ['Version recettée', `${META.version}`],
      ['Client', META.client],
      ['Prestataire', META.prestataire],
      ['Environnement testé', `${BOX} Production (${META.url})    ${BOX} Environnement de recette    ${BOX} Autre :`],
      ['Données utilisées', `${BOX} Données fictives    ${BOX} Données réelles autorisées par la mairie`],
      ['Navigateur et poste utilisés', ''],
      ['Dates de la recette', ''],
      ['Lieu', ''],
    ]),

    h1('Participants'),
    table({
      head: ['Nom et prénoms', 'Fonction', 'Profil testé', 'Organisme'],
      widths: [3, 2.6, 2.4, 2], minRow: 520, zebra: false,
      rows: [['', '', '', ''], ['', '', '', ''], ['', '', '', ''], ['', '', '', ''], ['', '', '', ''], ['', '', '', '']],
    }),

    h1('Scénarios de recette'),
    h2('A. Accès et sécurité'),
    table({ ...SCEN, rows: [
      sc('A1', 'Se connecter avec un identifiant et un mot de passe valides.', 'L\'espace de travail s\'ouvre, adapté au profil (menu limité aux droits du compte).'),
      sc('A2', 'Se connecter avec un mauvais mot de passe, puis avec un identifiant inexistant.', 'Même message d\'erreur dans les deux cas : on ne sait pas si le compte existe.'),
      sc('A3', 'Saisir 5 fois de suite un mauvais mot de passe sur un compte de test.', 'Le compte est bloqué temporairement (15 minutes) avec un message clair.'),
      sc('A4', 'Se connecter avec un mot de passe temporaire (compte créé ou réinitialisé par l\'administrateur).', 'Le changement de mot de passe est exigé avant toute autre action ; un mot de passe trop faible est refusé.'),
      sc('A5', 'Se déconnecter depuis le menu.', 'Retour à la page de connexion ; le bouton « précédent » du navigateur ne rouvre pas la session.'),
      sc('A6', 'Avec le profil agent de collecte, tenter d\'ouvrir la page Utilisateurs (adresse /users).', 'Message « Accès refusé » ; aucune donnée affichée.'),
    ] }),
    h2('B. Agent de collecte'),
    table({ ...SCEN, rows: [
      sc('B1', 'Créer une nouvelle déclaration en ne saisissant que la date de naissance, puis « Enregistrer le brouillon ».', 'Le brouillon est enregistré avec une référence WKR-AAAA-NNNN et reste modifiable.'),
      sc('B2', 'Joindre la photo (ou le fichier) de la fiche de déclaration physique.', 'La fiche apparaît dans le dossier et s\'agrandit au clic.'),
      sc('B3', 'Saisir des informations en minuscules, un téléphone (+224 624 62 94 77), une nationalité, la date de naissance d\'un parent.', 'Affichage en majuscules ; téléphone au bon format ; liste des pays proposée ; âge calculé automatiquement.'),
      sc('B4', 'Transmettre une déclaration à laquelle il manque une information minimale (par exemple le nom de la mère).', 'La transmission est refusée avec un message qui nomme l\'information manquante.'),
      sc('B5', 'Transmettre une déclaration complète (« Enregistrer et transmettre au secrétariat »).', 'Le statut devient « Transmis au secrétariat » ; l\'agent ne peut plus modifier le dossier.'),
      sc('B6', 'Consulter un dossier retourné (« À corriger — collecte »), corriger, retransmettre.', 'Le motif du retour est affiché ; après correction, le dossier repart au secrétariat.'),
      sc('B7', 'Vérifier la liste des déclarations.', 'L\'agent ne voit que ses propres déclarations.'),
    ] }),
    h2('C. Secrétariat d\'état civil'),
    table({ ...SCEN, rows: [
      sc('C1', 'Ouvrir la « File du secrétariat ».', 'Les dossiers transmis apparaissent ; la pastille du menu indique leur nombre.'),
      sc('C2', 'Ouvrir un dossier transmis, cliquer « Prendre en charge ».', 'Le dossier passe « En complément » ; le secrétaire en est le responsable.'),
      sc('C3', 'Corriger l\'identité d\'un parent ou renseigner le déclarant (le père, la mère ou une autre personne).', 'Les modifications sont enregistrées ; si le déclarant est le père ou la mère, ses informations sont reprises.'),
      sc('C4', 'Compléter l\'acte (année, registre, feuillet, date de déclaration, mentions).', 'L\'enregistrement réussit ; le numéro officiel reste « Non attribué » (réservé à l\'administrateur).'),
      sc('C5', 'Soumettre à validation un dossier sans date de déclaration ou sans déclarant.', 'Refus avec message précis ; avec les informations requises, le dossier passe « En attente de validation ».'),
      sc('C6', 'Chercher une action « Valider » ou « Rejeter » avec ce profil.', 'Aucune action de décision n\'est proposée au secrétaire.'),
      sc('C7', 'Ouvrir l\'aperçu d\'un acte non validé.', 'Filigrane « ACTE NON VALIDE » ; impression et délivrance désactivées.'),
      sc('C8', 'Créer, modifier, désactiver puis archiver un établissement de santé.', 'Chaque opération réussit ; un établissement utilisé par des dossiers n\'est jamais supprimé.'),
      sc('C9', 'Sur un acte validé : « Imprimer ».', 'L\'aperçu s\'imprime sans filigrane ; l\'impression est enregistrée (copie n°).'),
      sc('C10', 'Enregistrer une délivrance, puis une seconde pour le même acte.', 'La première est une délivrance ; la seconde est marquée « Duplicata » ; les deux apparaissent dans « Délivrances ».'),
    ] }),
    h2('D. Administrateur technique'),
    table({ ...SCEN, rows: [
      sc('D1', 'Ouvrir la « File de validation » puis un dossier en attente.', 'La zone « Décision finale » propose : valider, retourner à la collecte, retourner au secrétariat, rejeter.'),
      sc('D2', 'Valider définitivement en saisissant le numéro officiel.', 'Statut « Validé définitivement » ; numéro enregistré ; dossier figé.'),
      sc('D3', 'Valider un second acte avec le même numéro dans la même année et le même registre.', 'Refus : numéro déjà utilisé.'),
      sc('D4', 'Valider un dossier dont certains champs attendus sont vides.', 'Avertissement qui liste les champs ; possibilité de revenir compléter ou de « Valider quand même » ; les champs manquants sont notés dans l\'historique.'),
      sc('D5', 'Retourner un dossier à la collecte ou au secrétariat sans écrire de motif, puis avec motif.', 'Refus sans motif ; avec motif, le dossier est retourné et le motif visible par le destinataire.'),
      sc('D6', 'Rejeter un dossier avec motif.', 'Statut « Rejeté » ; dossier clos et figé.'),
      sc('D7', 'Tenter de modifier un dossier validé ou rejeté.', 'Aucune modification possible.'),
      sc('D8', 'Créer un utilisateur, lui attribuer un rôle, le désactiver.', 'Le compte est créé avec mot de passe temporaire ; le rôle s\'applique ; un compte désactivé ne peut plus se connecter ; aucun compte n\'est supprimé.'),
      sc('D9', 'Modifier les permissions d\'un rôle (puis rétablir).', 'La modification est enregistrée et tracée ; l\'administrateur ne peut pas modifier son propre compte.'),
      sc('D10', 'Ouvrir le tableau de bord, changer la période, cliquer une carte de chiffres.', 'La liste affichée contient exactement le nombre indiqué sur la carte, avec la même période et les mêmes filtres.'),
      sc('D11', 'Ouvrir « Historiques des actes », chercher un dossier, ouvrir son histoire.', 'On voit qui a fait quoi et quand, avec l\'ancienne et la nouvelle valeur de chaque modification.'),
      sc('D12', 'Ouvrir « Journaux d\'activité », filtrer, exporter en CSV.', 'Les opérations sont horodatées et attribuées à leur auteur ; l\'export s\'ouvre dans un tableur.'),
      sc('D13', 'Modifier un texte de la page de connexion dans « Paramètres ».', 'Le texte est visible sur la page de connexion.'),
    ] }),
    h2('E. Contrôles transversaux'),
    table({ ...SCEN, rows: [
      sc('E1', 'Chercher un moyen de supprimer définitivement un dossier, un acte, un utilisateur.', 'Aucun bouton de suppression : les éléments sont archivés ou désactivés, jamais effacés.'),
      sc('E2', 'Vérifier que toute opération réalisée pendant la recette figure au journal d\'activité.', 'Chaque opération a un auteur, une date et une heure.'),
      sc('E3', 'Ouvrir l\'application sur un téléphone.', 'L\'affichage reste lisible et utilisable.'),
      sc('E4', 'Imprimer un acte validé sur papier (si possible sur le papier officiel).', 'Le rendu est lisible et complet ; la mairie confirme que le modèle convient ou précise ses corrections.'),
      sc('E5', 'Faire exécuter une sauvegarde puis une restauration sur un environnement de test (document 04).', 'Les données restaurées sont identiques à celles sauvegardées.'),
    ] }),

    h1('Anomalies constatées'),
    table({
      head: ['N°', 'Scénario', 'Description de l\'anomalie', 'Gravité', 'Correction prévue le'],
      widths: [0.6, 1.2, 4.8, 1.8, 1.6], minRow: 600, zebra: false, small: true,
      rows: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [String(n), '', '', `${BOX} Bloquante\n${BOX} Majeure\n${BOX} Mineure`, '']),
    }),
    note('**Gravité.** Bloquante : un scénario essentiel ne peut pas être réalisé. Majeure : le scénario est réalisable mais avec une gêne importante. Mineure : défaut d\'aspect ou de confort sans effet sur le résultat.', 'info'),

    h1('Réserves de la mairie'),
    table({
      head: ['N°', 'Réserve', 'À lever avant le', 'Levée le'],
      widths: [0.6, 6.2, 1.8, 1.4], minRow: 600, zebra: false,
      rows: [['1', '', '', ''], ['2', '', '', ''], ['3', '', '', ''], ['4', '', '', '']],
    }),

    h1('Décision'),
    table({
      head: null, widths: [10], zebra: false,
      rows: [
        [`${BOX} **La solution est acceptée sans réserve.**`],
        [`${BOX} **La solution est acceptée avec les réserves ci-dessus**, à lever par le prestataire dans les délais indiqués.`],
        [`${BOX} **La solution est refusée** pour les motifs suivants :`],
      ],
    }),
    form([['Motifs et commentaires', '']], [3, 7]),
    p('Fait en deux exemplaires originaux.'),

    h1('Signatures'),
    sign([
      { title: `Pour la ${META.clientCourt} (le client)`, lines: ['Nom :', 'Fonction :', 'Date :'] },
      { title: 'Pour le prestataire', lines: ['Nom :', 'Fonction :', 'Date :'] },
    ]),
  ],
};
