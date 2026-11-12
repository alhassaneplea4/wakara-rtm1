/**
 * « Situation matrimoniale » of the father, the mother and the declarant.
 * The stored value is a code; the wording agrees with the person: masculine for the father, feminine for the
 * mother, neutral (« Marié(e) ») for the declarant, who may be anyone.
 */
export type MaritalKind = 'father' | 'mother' | 'other';

const WORDS: Record<string, Record<MaritalKind, string>> = {
  CELIBATAIRE: { father: 'Célibataire', mother: 'Célibataire', other: 'Célibataire' },
  MARIE: { father: 'Marié', mother: 'Mariée', other: 'Marié(e)' },
  DIVORCE: { father: 'Divorcé', mother: 'Divorcée', other: 'Divorcé(e)' },
  VEUF: { father: 'Veuf', mother: 'Veuve', other: 'Veuf(ve)' },
};

export const MARITAL_CODES = Object.keys(WORDS);

export const maritalOptions = (kind: MaritalKind) => MARITAL_CODES.map(v => ({ v, l: WORDS[v][kind] }));
export const maritalLabel = (code: string | null | undefined, kind: MaritalKind) => (code && WORDS[code]?.[kind]) || '';
