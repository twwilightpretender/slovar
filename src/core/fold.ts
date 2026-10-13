/**
 * Текстовый поиск: приведение текста к виду «без регистра, диакритики и знаков ударения, дефисы и
 * апострофы одинаковые, пробелы сжаты» — и запрос, и статья приводятся одинаково.
 */
import { IGNORABLE } from './normalize';

const ASCII = /^[\x00-\x7f]*$/;

export function foldFast(s: string): string {
  s = s.toLowerCase();
  if (!ASCII.test(s)) {
    s = s
      .replace(/œ/g, 'oe')
      .replace(/æ/g, 'ae')
      .replace(/ß/g, 'ss')
      .replace(/ё/g, 'е')
      .replace(/й/g, '') // «й» не должна превращаться в «и»
      .replace(/ς/g, 'σ')
      .normalize('NFD')
      .replace(IGNORABLE, '')
      .replace(//g, 'й')
      .replace(/[’‘`´\u1FBD\u1FBF\u02BC]/g, "'")
      .normalize('NFC');
  }
  return s.replace(/[-‐‑–—_]/g, ' ').replace(/\s+/g, ' ');
}

function foldChar(ch: string): string {
  const c = ch.toLowerCase();
  if (c === 'ς') return 'σ';
  if (c === 'œ') return 'oe';
  if (c === 'æ') return 'ae';
  if (c === 'ß') return 'ss';
  if (c === 'ё') return 'е';
  if (c === 'й') return 'й';
  const d = c.normalize('NFD').replace(IGNORABLE, '').normalize('NFC');
  if (/[’‘`´\u1FBD\u1FBF\u02BC]/.test(d)) return "'";
  if (/[-‐‑–—_\s]/.test(d)) return ' ';
  return d;
}

/** То же приведение, но с таблицей «позиция в приведённом тексте → позиция в исходном» (для фрагментов). */
export function foldMap(p: string): { f: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < p.length; i++) {
    for (const c of foldChar(p[i])) {
      if (c === ' ') {
        if (prevSpace) continue;
        prevSpace = true;
      } else prevSpace = false;
      out.push(c);
      map.push(i);
    }
  }
  return { f: out.join(''), map };
}

const BLOCK = /<\/?(br|p|div|li|tr|td|th|h[1-6]|dt|dd|ol|ul|table|section|article)\b[^>]*>/gi;
const NAMED: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** HTML статьи → чистый текст для поиска. */
export function plainText(html: string): string {
  const s = html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(BLOCK, ' ')
    .replace(/<[^>]*>/g, '');
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, n: string) => {
    if (n[0] === '#') {
      const code = n[1] === 'x' || n[1] === 'X' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[n.toLowerCase()] ?? m;
  });
}

const BASE = 'aàáâãäåāăąæ|eèéêëēėęě|iìíîïīį|oòóôõöøō|uùúûüūůű|cçćč|nñń|yýÿ|sšśß|zžźż|lł|её'.split('|');
/** Для каждой буквы: она сама и все её написания с диакритикой одним символом (ά ὰ ᾶ ἄ ᾄ…, é, ё…). Строится по таблицам Юникода. */
const CLASS = new Map<string, string>();
{
  const variants = new Map<string, Set<string>>();
  const add = (base: string, ch: string) => (variants.get(base) ?? variants.set(base, new Set([base])).get(base)!).add(ch);
  for (const [a, b] of [[0xc0, 0x24f], [0x370, 0x3ff], [0x400, 0x4ff], [0x1e00, 0x1eff], [0x1f00, 0x1fff]]) {
    for (let cp = a; cp <= b; cp++) {
      const ch = String.fromCodePoint(cp);
      if (ch.toLowerCase() !== ch || ch === 'й') continue; // заглавные покрывает флаг i; «й» остаётся отдельной буквой
      const base = ch.normalize('NFD').replace(IGNORABLE, '');
      if (base !== ch && base.length === 1) add(base, ch);
    }
  }
  add('σ', 'ς');
  for (const g of BASE) for (const ch of g) add(g[0], ch);
  for (const [base, set] of variants) CLASS.set(base, [...set].join(''));
}
const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Регулярное выражение для текстового поиска: терпимо к регистру, диакритике, знакам ударения,
 * дефисам/пробелам/апострофам и лигатурам (œ, æ, ß). Проверяется прямо по сырому тексту — это в разы
 * быстрее, чем приводить к единому виду каждую статью. null — запрос слишком короткий.
 */
export function buildSearchRegex(q: string, flags = 'iu'): RegExp | null {
  const f = foldFast(q).trim();
  if (f.length < 2) return null;
  const MARKS = '\\p{M}*'; // знаки ударения и диакритика отдельными символами
  const chars = [...f];
  let src = '';
  for (let k = 0; k < chars.length; k++) {
    const c = chars[k], n = chars[k + 1];
    if (c === 'o' && n === 'e') { src += `(?:o\\p{M}*[eèéêë]|œ)${MARKS}`; k++; continue; }
    if (c === 'a' && n === 'e') { src += `(?:a\\p{M}*[eèéêë]|æ)${MARKS}`; k++; continue; }
    if (c === 's' && n === 's') { src += `(?:ss|ß)${MARKS}`; k++; continue; }
    if (c === ' ') { src += '[\\s\\-‐‑–—_]+'; continue; }
    if (c === "'") { src += "['’‘`´]"; continue; }
    const g = CLASS.get(c);
    src += (g ? `[${g}]` : c.replace(RE_SPECIAL, '\\$&')) + MARKS;
  }
  try { return new RegExp(src, flags); } catch { return null; }
}

/**
 * Части запроса. «Фраза» (all = false): весь запрос как одна фраза, кавычки отбрасываются.
 * «Все слова» (all = true): каждое слово отдельно, слова в «кавычках» — как одна фраза; нужны все части.
 */
export function parseTerms(q: string, all: boolean): string[] {
  if (!all) {
    const t = q.replace(/["«»“”„]/g, ' ').replace(/\s+/g, ' ').trim();
    return t ? [t] : [];
  }
  const out: string[] = [];
  const re = /["«“„]([^"»”]+)["»”]|(\S+)/g;
  for (let m = re.exec(q); m; m = re.exec(q)) {
    const t = (m[1] ?? m[2]).replace(/["«»“”„]/g, '').trim();
    if (t) out.push(t);
  }
  return out;
}

/** Быстрая очистка HTML для поиска: все теги — пробелы, только нужные сущности. */
export function plainFast(html: string): string {
  let s = html;
  if (s.includes('<')) {
    if (/<(style|script|head)\b/i.test(s)) s = s.replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(BLOCK, ' ').replace(/<[^>]*>/g, '');
  }
  if (s.includes('&')) {
    s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, n: string) => {
      if (n[0] === '#') {
        const code = n[1] === 'x' || n[1] === 'X' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return NAMED[n.toLowerCase()] ?? m;
    });
  }
  return s;
}
