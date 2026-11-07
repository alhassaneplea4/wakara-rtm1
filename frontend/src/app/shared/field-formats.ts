import { Component, Directive, ElementRef, HostListener, forwardRef, inject } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { COUNTRIES, NATIONALITY_LIST_ID } from './countries';

/* ── Phone numbers ───────────────────────────────── */

const GN = '224';

/**
 * Formats what the user types as a phone number.
 * Guinea (default): `+224 624 62 94 77`; a number typed without a prefix is taken as a Guinean one.
 * Another country: `+` followed by the digits (E.164, 15 digits at most).
 */
export function formatPhone(raw: string): string {
  const text = (raw ?? '').trim();
  if (!text) return '';
  const plus = text.startsWith('+') || text.startsWith('00');
  let digits = text.replace(/\D/g, '');
  if (text.startsWith('00')) digits = digits.slice(2);
  if (!digits) return plus ? '+' : '';
  const foreign = plus && !digits.startsWith(GN) && !GN.startsWith(digits);
  if (foreign) return '+' + digits.slice(0, 15);
  if (digits.startsWith(GN)) digits = digits.slice(GN.length);
  else if (plus) return '+' + digits;  // "+2", "+22": the country code is still being typed
  const n = digits.slice(0, 9);
  const groups = [n.slice(0, 3), n.slice(3, 5), n.slice(5, 7), n.slice(7, 9)].filter(Boolean);
  return ('+' + GN + ' ' + groups.join(' ')).trim();
}

/** Error message for an optional phone number, or '' when it is empty or well formed. */
export function phoneError(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!v || v === '+' || v === '+' + GN) return '';
  const digits = v.replace(/\D/g, '');
  if (v.startsWith('+' + GN)) {
    const national = digits.slice(GN.length);
    return national.length === 9 && national[0] !== '0' ? '' : 'Numéro incomplet : +224 suivi de 9 chiffres (ex. +224 624 62 94 77).';
  }
  return digits.length >= 8 && digits.length <= 15 ? '' : 'Numéro invalide : indicatif du pays puis 8 à 15 chiffres.';
}

/**
 * Phone input: `type="tel"`, numeric keypad on mobile, live mask `+224 624 62 94 77`.
 * It is its own ControlValueAccessor so the masked text is exactly what ngModel receives.
 */
@Directive({
  selector: 'input[wkPhone]', standalone: true,
  host: { type: 'tel', inputmode: 'tel', autocomplete: 'tel', maxlength: '20', placeholder: '+224 624 62 94 77' },
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => PhoneInputDirective), multi: true }],
})
export class PhoneInputDirective implements ControlValueAccessor {
  private el = inject<ElementRef<HTMLInputElement>>(ElementRef).nativeElement;
  private onChange: (v: string) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  writeValue(v: string | null) { this.el.value = v ?? ''; }
  registerOnChange(fn: (v: string) => void) { this.onChange = fn; }
  registerOnTouched(fn: () => void) { this.onTouched = fn; }
  setDisabledState(disabled: boolean) { this.el.disabled = disabled; }

  @HostListener('input') input() {
    const before = this.el.value;
    const caret = this.el.selectionStart ?? before.length;
    const digitsBeforeCaret = before.slice(0, caret).replace(/\D/g, '').length;
    const formatted = formatPhone(before);
    if (formatted !== before) {
      this.el.value = formatted;
      // keep the caret next to the same digit when the user edits in the middle of the number
      if (caret < before.length) {
        let seen = 0, pos = 0;
        while (pos < formatted.length && seen < digitsBeforeCaret) { if (/\d/.test(formatted[pos])) seen++; pos++; }
        this.el.setSelectionRange(pos, pos);
      }
    }
    this.onChange(formatted);
  }

  @HostListener('blur') blur() {
    // a lone "+" or "+224" carries no information
    if (['+', '+' + GN].includes(this.el.value.trim())) { this.el.value = ''; this.onChange(''); }
    this.onTouched();
  }
}

/* ── Integers (age, rank…) ───────────────────────── */

/** Numeric keypad on mobile and no "e", "+", "-", "." or "," in a number field. */
@Directive({ selector: 'input[wkInteger]', standalone: true, host: { type: 'number', inputmode: 'numeric', step: '1' } })
export class IntegerInputDirective {
  @HostListener('keydown', ['$event']) keydown(e: KeyboardEvent) {
    if (['e', 'E', '+', '-', '.', ','].includes(e.key)) e.preventDefault();
  }
}

/* ── Nationalities ───────────────────────────────── */

/** Shared <datalist> of the countries of the world: the nationality is the value, the country the label. */
@Component({
  selector: 'wk-nationality-list', standalone: true,
  template: `<datalist [id]="id">@for (c of countries; track c.country) { <option [value]="c.nationality" [attr.label]="c.country"></option> }</datalist>`,
})
export class NationalityListComponent {
  id = NATIONALITY_LIST_ID;
  countries = COUNTRIES;
}

/** Nationality input bound to the shared list (type to filter, free text still allowed for older records). */
@Directive({
  selector: 'input[wkNationality]', standalone: true,
  host: { type: 'text', list: NATIONALITY_LIST_ID, autocomplete: 'off', autocapitalize: 'characters', placeholder: 'Choisir ou saisir…' },
})
export class NationalityInputDirective {}

/* ── Age ─────────────────────────────────────────── */

/**
 * Age in whole years on ``today`` for a birth date typed as `YYYY-MM-DD`.
 * Returns null when the date is empty, malformed, in the future or older than 120 years, so the age field is
 * left to the user in those cases.
 */
export function ageFromBirthDate(dob: string | null | undefined, today: Date = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dob ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const born = new Date(y, mo - 1, d);
  if (born.getFullYear() !== y || born.getMonth() !== mo - 1 || born.getDate() !== d) return null;
  let age = today.getFullYear() - y;
  if (today.getMonth() < mo - 1 || (today.getMonth() === mo - 1 && today.getDate() < d)) age--;
  return age >= 0 && age <= 120 ? age : null;
}
