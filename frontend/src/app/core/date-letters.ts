/**
 * Dates written in full words, as the civil-registry texts require
 * (« le vingt-huit octobre deux mille vingt-six »). Display only: the stored value stays an ISO date.
 */
const UNITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze',
  'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
const TENS = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function below100(n: number, final: boolean): string {
  if (n < 20) return UNITS[n];
  const t = Math.floor(n / 10);
  const u = n % 10;
  if (t === 7) return u === 1 ? 'soixante et onze' : `soixante-${UNITS[10 + u]}`;
  if (t === 8) return u === 0 ? (final ? 'quatre-vingts' : 'quatre-vingt') : `quatre-vingt-${UNITS[u]}`;
  if (t === 9) return `quatre-vingt-${UNITS[10 + u]}`;
  if (u === 0) return TENS[t];
  return u === 1 ? `${TENS[t]} et un` : `${TENS[t]}-${UNITS[u]}`;
}

function below1000(n: number, final: boolean): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h === 0) return below100(r, final);
  if (h === 1) return r ? `cent ${below100(r, final)}` : 'cent';
  return r ? `${UNITS[h]} cent ${below100(r, final)}` : `${UNITS[h]} cent${final ? 's' : ''}`;
}

/** Whole number from 0 to 999 999 in French words. */
export function nombreEnLettres(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return String(n);
  if (n < 1000) return below1000(n, true);
  const k = Math.floor(n / 1000);
  const r = n % 1000;
  const thousands = k === 1 ? 'mille' : `${below1000(k, false)} mille`;
  return r ? `${thousands} ${below1000(r, true)}` : thousands;
}

/** « le premier janvier deux mille vingt-six » from an ISO date (YYYY-MM-DD); empty when the value is not a date. */
export function dateEnLettres(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return '';
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `le ${day === 1 ? 'premier' : nombreEnLettres(day)} ${MONTHS[month - 1]} ${nombreEnLettres(year)}`;
}

/** « huit heures trente » from `HH:MM` (or `HH:MM:SS`); empty when the value is not a time. */
export function heureEnLettres(hhmm: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})/.exec((hhmm ?? '').trim());
  if (!m) return '';
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return '';
  const hours = h === 0 ? 'minuit' : h === 12 ? 'midi' : `${nombreEnLettres(h).replace(/\bun$/, 'une')} heure${h > 1 ? 's' : ''}`;
  return min ? `${hours} ${nombreEnLettres(min)}` : hours;
}
