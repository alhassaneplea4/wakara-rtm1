import { ageFromBirthDate } from './field-formats';

describe('ageFromBirthDate', () => {
  const today = new Date(2026, 10, 7); // 7 November 2026

  it('counts whole years', () => {
    expect(ageFromBirthDate('1990-11-07', today)).toBe(36);   // birthday today
    expect(ageFromBirthDate('1990-11-08', today)).toBe(35);   // birthday tomorrow
    expect(ageFromBirthDate('1990-01-01', today)).toBe(36);
    expect(ageFromBirthDate('2026-11-07', today)).toBe(0);
  });

  it('leaves the field to the user when the date is not usable', () => {
    expect(ageFromBirthDate('', today)).toBeNull();
    expect(ageFromBirthDate(null, today)).toBeNull();
    expect(ageFromBirthDate('07/11/1990', today)).toBeNull();
    expect(ageFromBirthDate('1990-02-31', today)).toBeNull();
    expect(ageFromBirthDate('2027-01-01', today)).toBeNull();  // in the future
    expect(ageFromBirthDate('1800-01-01', today)).toBeNull();  // older than 120 years
  });
});
