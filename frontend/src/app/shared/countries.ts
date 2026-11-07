/**
 * Static list of the countries of the world (French), with the matching nationality.
 * The nationality is what is stored on the dossier ("Guinéenne"); the country name is the datalist label,
 * so an agent can look a nationality up by typing either one.
 * Nationalities are in the feminine form already used for the child ("Guinéenne").
 */
export interface Country { country: string; nationality: string; }

const RAW = `Afghanistan|Afghane
Afrique du Sud|Sud-africaine
Albanie|Albanaise
Algérie|Algérienne
Allemagne|Allemande
Andorre|Andorrane
Angola|Angolaise
Antigua-et-Barbuda|Antiguaise-et-barbudienne
Arabie saoudite|Saoudienne
Argentine|Argentine
Arménie|Arménienne
Australie|Australienne
Autriche|Autrichienne
Azerbaïdjan|Azerbaïdjanaise
Bahamas|Bahamienne
Bahreïn|Bahreïnienne
Bangladesh|Bangladaise
Barbade|Barbadienne
Belgique|Belge
Belize|Bélizienne
Bénin|Béninoise
Bhoutan|Bhoutanaise
Biélorussie|Biélorusse
Birmanie (Myanmar)|Birmane
Bolivie|Bolivienne
Bosnie-Herzégovine|Bosnienne
Botswana|Botswanaise
Brésil|Brésilienne
Brunei|Brunéienne
Bulgarie|Bulgare
Burkina Faso|Burkinabè
Burundi|Burundaise
Cambodge|Cambodgienne
Cameroun|Camerounaise
Canada|Canadienne
Cap-Vert|Cap-verdienne
Centrafrique|Centrafricaine
Chili|Chilienne
Chine|Chinoise
Chypre|Chypriote
Colombie|Colombienne
Comores|Comorienne
Congo (Brazzaville)|Congolaise
Congo (République démocratique du)|Congolaise (RDC)
Corée du Nord|Nord-coréenne
Corée du Sud|Sud-coréenne
Costa Rica|Costaricienne
Côte d'Ivoire|Ivoirienne
Croatie|Croate
Cuba|Cubaine
Danemark|Danoise
Djibouti|Djiboutienne
Dominique|Dominiquaise
Égypte|Égyptienne
Émirats arabes unis|Émirienne
Équateur|Équatorienne
Érythrée|Érythréenne
Espagne|Espagnole
Estonie|Estonienne
Eswatini|Swazie
États-Unis|Américaine
Éthiopie|Éthiopienne
Fidji|Fidjienne
Finlande|Finlandaise
France|Française
Gabon|Gabonaise
Gambie|Gambienne
Géorgie|Géorgienne
Ghana|Ghanéenne
Grèce|Grecque
Grenade|Grenadienne
Guatemala|Guatémaltèque
Guinée|Guinéenne
Guinée-Bissau|Bissau-guinéenne
Guinée équatoriale|Équato-guinéenne
Guyana|Guyanienne
Haïti|Haïtienne
Honduras|Hondurienne
Hongrie|Hongroise
Îles Cook|Cookienne
Îles Marshall|Marshallaise
Îles Salomon|Salomonaise
Inde|Indienne
Indonésie|Indonésienne
Irak|Irakienne
Iran|Iranienne
Irlande|Irlandaise
Islande|Islandaise
Israël|Israélienne
Italie|Italienne
Jamaïque|Jamaïcaine
Japon|Japonaise
Jordanie|Jordanienne
Kazakhstan|Kazakhe
Kenya|Kényane
Kirghizistan|Kirghize
Kiribati|Kiribatienne
Kosovo|Kosovare
Koweït|Koweïtienne
Laos|Laotienne
Lesotho|Lesothane
Lettonie|Lettone
Liban|Libanaise
Liberia|Libérienne
Libye|Libyenne
Liechtenstein|Liechtensteinoise
Lituanie|Lituanienne
Luxembourg|Luxembourgeoise
Macédoine du Nord|Macédonienne
Madagascar|Malgache
Malaisie|Malaisienne
Malawi|Malawienne
Maldives|Maldivienne
Mali|Malienne
Malte|Maltaise
Maroc|Marocaine
Maurice|Mauricienne
Mauritanie|Mauritanienne
Mexique|Mexicaine
Micronésie|Micronésienne
Moldavie|Moldave
Monaco|Monégasque
Mongolie|Mongole
Monténégro|Monténégrine
Mozambique|Mozambicaine
Namibie|Namibienne
Nauru|Nauruane
Népal|Népalaise
Nicaragua|Nicaraguayenne
Niger|Nigérienne
Nigeria|Nigériane
Niue|Niuéenne
Norvège|Norvégienne
Nouvelle-Zélande|Néo-zélandaise
Oman|Omanaise
Ouganda|Ougandaise
Ouzbékistan|Ouzbèke
Pakistan|Pakistanaise
Palaos|Palaosienne
Palestine|Palestinienne
Panama|Panaméenne
Papouasie-Nouvelle-Guinée|Papouasienne
Paraguay|Paraguayenne
Pays-Bas|Néerlandaise
Pérou|Péruvienne
Philippines|Philippine
Pologne|Polonaise
Portugal|Portugaise
Qatar|Qatarienne
République dominicaine|Dominicaine
République tchèque|Tchèque
Roumanie|Roumaine
Royaume-Uni|Britannique
Russie|Russe
Rwanda|Rwandaise
Saint-Christophe-et-Niévès|Kittitienne-et-névicienne
Sainte-Lucie|Saint-lucienne
Saint-Marin|Saint-marinaise
Saint-Siège (Vatican)|Vaticane
Saint-Vincent-et-les-Grenadines|Saint-vincentaise
Salvador|Salvadorienne
Samoa|Samoane
São Tomé-et-Principe|Santoméenne
Sénégal|Sénégalaise
Serbie|Serbe
Seychelles|Seychelloise
Sierra Leone|Sierra-léonaise
Singapour|Singapourienne
Slovaquie|Slovaque
Slovénie|Slovène
Somalie|Somalienne
Soudan|Soudanaise
Soudan du Sud|Sud-soudanaise
Sri Lanka|Sri-lankaise
Suède|Suédoise
Suisse|Suisse
Suriname|Surinamaise
Syrie|Syrienne
Tadjikistan|Tadjike
Taïwan|Taïwanaise
Tanzanie|Tanzanienne
Tchad|Tchadienne
Thaïlande|Thaïlandaise
Timor oriental|Timoraise
Togo|Togolaise
Tonga|Tongienne
Trinité-et-Tobago|Trinidadienne
Tunisie|Tunisienne
Turkménistan|Turkmène
Turquie|Turque
Tuvalu|Tuvaluane
Ukraine|Ukrainienne
Uruguay|Uruguayenne
Vanuatu|Vanuatuane
Venezuela|Vénézuélienne
Viêt Nam|Vietnamienne
Yémen|Yéménite
Zambie|Zambienne
Zimbabwe|Zimbabwéenne`;

export const COUNTRIES: Country[] = RAW.split('\n').map(line => {
  const [country, nationality] = line.split('|');
  return { country, nationality };
});

/** Id of the shared <datalist> rendered by <wk-nationality-list>. */
export const NATIONALITY_LIST_ID = 'wk-nationalities';
