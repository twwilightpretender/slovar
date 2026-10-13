/**
 * Знаки, которые при поиске не учитываем: диакритика латиницы, греческие ударения, придыхания и подстрочная йота,
 * ударения в кириллице, огласовки иврита и арабского, невидимые знаки форматирования.
 * Знаки гласных деванагари, тайского и т. п. и дакутэн японской каны не трогаем: это часть буквы.
 */
export const IGNORABLE = /[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f\p{Cf}]/gu;

/** Ключ поиска: без регистра, диакритики, дефисов, апострофов и пробелов. */
export function key(s: string): string {
  s = s.toLowerCase();
  if (/^[a-z0-9]*$/.test(s)) return s;
  s = s
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/ё/g, 'е')
    .replace(/ς/g, 'σ') // конечная сигма и обычная — одна буква
    .replace(/й/g, '\uE000'); // «й» не должна превращаться в «и»
  s = s.normalize('NFD').replace(IGNORABLE, '').replace(/\uE000/g, 'й').normalize('NFC');
  return s.replace(/[-'’‘`\s.\u1FBD\u1FBF\u02BC]/g, '');
}
