// Petit langage de description des documents : chaque contenu est une liste de blocs.
// Les textes acceptent **gras** et `code` ; "\n" dans une cellule de tableau = nouvelle ligne.

export const h1 = (text) => ({ t: 'h1', text });
export const h2 = (text) => ({ t: 'h2', text });
export const h3 = (text) => ({ t: 'h3', text });
export const p = (text) => ({ t: 'p', text });
export const ul = (items) => ({ t: 'ul', items });
export const ol = (items) => ({ t: 'ol', items });
export const code = (text) => ({ t: 'code', text });
export const pb = () => ({ t: 'pb' });
export const note = (text, kind = 'info') => ({ t: 'note', kind, text });
export const img = (file, caption, width = 100) => ({ t: 'img', file, caption, width });

/**
 * table({ head: [...], rows: [[...]], widths: [2,5,3], zebra: true, small: false, minRow: 0 })
 * widths : proportions relatives des colonnes.
 */
export const table = (o) => ({ t: 'table', zebra: true, ...o });

/** Formulaire à remplir : lignes « étiquette | zone vide ». */
export const form = (rows, widths = [3, 7]) => ({ t: 'table', head: null, rows, widths, zebra: false, minRow: 520, labelCol: true });

/** Bloc de signatures : parties = [{ title, lines: ['Nom :', 'Qualité :', 'Date :'] }]. */
export const sign = (parties) => ({ t: 'sign', parties });

export const BOX = '☐';
