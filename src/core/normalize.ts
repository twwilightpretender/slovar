/** Ключ поиска: без регистра, диакритики, дефисов, апострофов и пробелов. */
export function key(s: string): string {
  s = s.toLowerCase();
  if (/^[a-z0-9]*$/.test(s)) return s;
  s = s
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/ё/g, 'е')
    .replace(/й/g, '\uE000'); // «й» не должна превращаться в «и»
  s = s.normalize('NFD').replace(/[\p{M}\p{Cf}]/gu, '').replace(/\uE000/g, 'й');
  return s.replace(/[-'’‘`\s.]/g, '');
}
