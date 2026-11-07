import { dateEnLettres, heureEnLettres, nombreEnLettres } from './date-letters';

describe('Dates in words', () => {
  it('writes a date in full letters', () => {
    expect(dateEnLettres('2026-10-28')).toBe('le vingt-huit octobre deux mille vingt-six');
    expect(dateEnLettres('2026-01-01')).toBe('le premier janvier deux mille vingt-six');
    expect(dateEnLettres('2025-02-21')).toBe('le vingt et un février deux mille vingt-cinq');
    expect(dateEnLettres('1999-07-14')).toBe('le quatorze juillet mille neuf cent quatre-vingt-dix-neuf');
  });
  it('agrees « quatre-vingts » and « cents » only at the end', () => {
    expect(dateEnLettres('1980-05-08')).toBe('le huit mai mille neuf cent quatre-vingts');
    expect(dateEnLettres('2080-05-08')).toBe('le huit mai deux mille quatre-vingts');
    expect(nombreEnLettres(200)).toBe('deux cents');
    expect(nombreEnLettres(1971)).toBe('mille neuf cent soixante et onze');
  });
  it('returns nothing for a value that is not a date', () => {
    expect(dateEnLettres('')).toBe('');
    expect(dateEnLettres('2026-13-01')).toBe('');
    expect(dateEnLettres(null)).toBe('');
  });
});

describe('Time in words', () => {
  it('writes an hour and its minutes', () => {
    expect(heureEnLettres('08:30')).toBe('huit heures trente');
    expect(heureEnLettres('01:05:00')).toBe('une heure cinq');
    expect(heureEnLettres('21:00')).toBe('vingt et une heures');
    expect(heureEnLettres('00:00')).toBe('minuit');
    expect(heureEnLettres('12:15')).toBe('midi quinze');
  });
  it('returns nothing for a value that is not a time', () => {
    expect(heureEnLettres('')).toBe('');
    expect(heureEnLettres(null)).toBe('');
    expect(heureEnLettres('25:00')).toBe('');
  });
});
