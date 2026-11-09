// Informations communes à tous les documents du dossier. Modifiez ici, puis relancez « npm run build ».

export const META = {
  projet: 'WAKARA',
  intitule: "Plateforme de gestion des déclarations et des actes de naissance",
  client: "Mairie de Ratoma — Centre d'état civil et de l'identification (CECI Ratoma)",
  clientCourt: 'Mairie de Ratoma',
  ville: 'Conakry, République de Guinée',
  prestataire: 'Elhadj Alhassana Camara',
  version: '1.0',
  date: '9 novembre 2026',
  url: 'https://wakara-rtm.vercel.app',
  depot: 'https://github.com/alhassaneplea4/wakara-rtm1',
  diffusion: 'Diffusion restreinte — mairie de Ratoma et prestataire',
};

export const DOCS = [
  { id: '01', fichier: '01-Cahier-des-charges', module: './contenus/01-cahier-des-charges.mjs' },
  { id: '02', fichier: '02-Dossier-technique', module: './contenus/02-dossier-technique.mjs' },
  { id: '03', fichier: '03-Manuel-utilisateur', module: './contenus/03-manuel-utilisateur.mjs' },
  { id: '04', fichier: '04-Guide-installation-exploitation', module: './contenus/04-guide-exploitation.mjs' },
  { id: '05', fichier: '05-Rapport-de-tests', module: './contenus/05-rapport-de-tests.mjs' },
  { id: '06', fichier: '06-PV-de-recette', module: './contenus/06-pv-recette.mjs' },
  { id: '07', fichier: '07-PV-de-livraison', module: './contenus/07-pv-livraison.mjs' },
];
