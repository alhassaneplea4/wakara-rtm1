import { Pipe, PipeTransform } from '@angular/core';
import { dateEnLettres } from '../core/date-letters';

/** `'2026-10-28' | dateLetters` → « le vingt-huit octobre deux mille vingt-six » (display only). */
@Pipe({ name: 'dateLetters', standalone: true })
export class DateLettersPipe implements PipeTransform {
  transform(value: string | null | undefined): string { return dateEnLettres(value); }
}
