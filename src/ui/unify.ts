/**
 * «Единый вид статей» — две независимые настройки.
 *
 * Шрифты: у словарей со своим оформлением убираем собственные шрифты, абсолютные размеры (px, pt и т. п.)
 * и междустрочие, чтобы всё читалось шрифтом и размером приложения. Остаются: относительные размеры (em, %) —
 * они сохраняют иерархию «заголовок крупнее, помета мельче»; жирность и курсив; шрифты транскрипции, символов
 * и моноширинные, а также шрифты, которые словарь подключает сам (@font-face).
 *
 * Цвета: цвет текста каждого словаря сводится к одному из восьми оттенков приложения (красный, оранжевый, золотой,
 * зелёный, бирюзовый, синий, фиолетовый, малиновый); тёмно-серое становится цветом основного текста, светло-серое —
 * приглушённым. Цвет у фрагментов с собственным фоном (плашки, метки) не трогаем: белый на красном должен остаться белым.
 */

export interface Uni { font: boolean; color: boolean }

/* ---------------- шрифты ---------------- */

const ABS_SIZE = /^-?[\d.]+(px|pt|pc|cm|mm|in|rem)$|^(xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large)$/i;
const ABS_LINE = /^-?[\d.]+(px|pt|pc|cm|mm|in|rem)$/i;
const KEEP_FAMILY = /ipa|phon|\bsil\b|doulos|charis|gentium|symbol|dingbat|wingding|webdings|mono|courier|consol|emoji|math|arial unicode|lucida sans unicode/i;
const SIZE_TOKEN = /(^|\s)(-?[\d.]+(?:px|pt|pc|em|rem|%|cm|mm|in)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller)(?:\/\S+)?(?=\s|$)/i;
const REL_SIZE = /^(-?[\d.]+(em|%)|larger|smaller)$/i;

/** Имена шрифтов, объявленных в @font-face этой таблицы стилей. */
export function fontFaceNames(css: string): string[] {
  const names: string[] = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const f = /font-family\s*:\s*([^;}]+)/i.exec(m[1]);
    if (f) names.push(f[1].trim().replace(/^['"]|['"]$/g, '').toLowerCase());
  }
  return names;
}

function keepFamily(val: string, faces: string[]): boolean {
  if (KEEP_FAMILY.test(val)) return true;
  const v = val.toLowerCase();
  return faces.some((n) => v.includes(n));
}

/** Заменяет одно объявление шрифта; пустая строка — объявление убрано. */
function fixFont(prop: string, raw: string, faces: string[]): string {
  const imp = /!\s*important\s*$/i.test(raw) ? ' !important' : '';
  const val = raw.replace(/!\s*important\s*$/i, '').trim();
  const p = prop.toLowerCase();
  if (p === 'font-family') return keepFamily(val, faces) ? `font-family:${val}${imp}` : '';
  if (p === 'font-size') return ABS_SIZE.test(val) ? '' : `font-size:${val}${imp}`;
  if (p === 'line-height') return ABS_LINE.test(val) ? '' : `line-height:${val}${imp}`;
  // сокращение font: оставляем только жирность, курсив и относительный размер
  const sz = SIZE_TOKEN.exec(val);
  if (!sz) return ''; // системные значения (caption, menu…) и всё непонятное
  const before = val.slice(0, sz.index);
  const family = val.slice(sz.index + sz[0].length).trim();
  const out: string[] = [];
  const w = /\b(bold|bolder|lighter|[1-9]00)\b/i.exec(before);
  if (w) out.push(`font-weight:${w[1]}${imp}`);
  if (/\b(italic|oblique)\b/i.test(before)) out.push(`font-style:italic${imp}`);
  if (/\bsmall-caps\b/i.test(before)) out.push(`font-variant:small-caps${imp}`);
  if (REL_SIZE.test(sz[2])) out.push(`font-size:${sz[2]}${imp}`);
  if (family && keepFamily(family, faces)) out.push(`font-family:${family}${imp}`);
  return out.join(';');
}

/* ---------------- цвета ---------------- */

/** Восемь оттенков: для светлой темы (она же служит основой для карточек со своим CSS, их инвертирует фильтр) и для тёмной. */
const HUES = [
  { name: 'red', light: '#c2311f', dark: '#ff8a75' },
  { name: 'orange', light: '#b5651d', dark: '#f0a860' },
  { name: 'gold', light: '#8a6d00', dark: '#e6c84f' },
  { name: 'green', light: '#1f7a3a', dark: '#6fd08c' },
  { name: 'teal', light: '#167a86', dark: '#6fd0dc' },
  { name: 'blue', light: '#2f5bea', dark: '#8fb0ff' },
  { name: 'violet', light: '#7a3fb0', dark: '#c9a0ff' },
  { name: 'magenta', light: '#b02f7a', dark: '#f08ac0' },
];
/** Верхние границы оттенка (градусы) для каждой из восьми групп; красный замыкает круг. */
const HUE_EDGES = [15, 45, 75, 165, 200, 255, 300, 345];

let ctx: CanvasRenderingContext2D | null | undefined;
const rgbCache = new Map<string, [number, number, number] | null>();

/** Значение CSS-цвета (имя, #hex, rgb(), hsl()) → [r, g, b]; null — не цвет, прозрачный или зависит от контекста. */
export function rgbOf(value: string): [number, number, number] | null {
  const v = value.trim();
  if (rgbCache.has(v)) return rgbCache.get(v)!;
  let res: [number, number, number] | null = null;
  if (v && !/^(inherit|initial|unset|revert|currentcolor|transparent)$|var\(|calc\(/i.test(v)) {
    if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#010203';
      ctx.fillStyle = v;
      const s = String(ctx.fillStyle);
      const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
      if (hex && s.toLowerCase() !== '#010203') res = [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
    }
  }
  rgbCache.set(v, res);
  return res;
}

export type Tone = { grey: 'text' | 'muted' } | { hue: number };

/** Оттенок цвета: серый (основной текст или приглушённый) либо номер из HUES. null — оставить как есть (почти белый). */
export function toneOf([r, g, b]: [number, number, number]): Tone | null {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  const L = (mx + mn) / 2, d = mx - mn;
  if (L > 0.88) return null;
  if (d < 0.14) return { grey: L < 0.3 ? 'text' : 'muted' }; // серые и почти чёрные
  let h = mx === R ? (G - B) / d + (G < B ? 6 : 0) : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h *= 60;
  let i = HUE_EDGES.findIndex((e) => h < e);
  if (i < 0) i = 0; // 345…360 — красный
  return { hue: i };
}

/**
 * Цвет для тона. 'styled' — статья со своим CSS: светлая основа, в тёмной теме её инвертирует фильтр.
 * 'light' / 'dark' — статья без своего CSS: серые берутся из переменных темы, оттенки подбираются под тему.
 */
export function toneColor(t: Tone, mode: 'styled' | 'light' | 'dark'): string {
  if ('grey' in t) {
    if (mode === 'styled') return t.grey === 'text' ? '#222222' : '#777777';
    return t.grey === 'text' ? 'var(--text)' : 'var(--muted)';
  }
  return mode === 'dark' ? HUES[t.hue].dark : HUES[t.hue].light;
}

function fixColor(raw: string): string | null {
  const imp = /!\s*important\s*$/i.test(raw) ? ' !important' : '';
  const rgb = rgbOf(raw.replace(/!\s*important\s*$/i, ''));
  const t = rgb && toneOf(rgb);
  return t ? `color:${toneColor(t, 'styled')}${imp}` : null;
}

/* ---------------- разбор CSS ---------------- */

const FONT_DECL = /(^|[;{\s])(font-family|font-size|line-height|font)\s*:\s*([^;}]*)/gi;
const COLOR_DECL = /(^|[;{\s])color\s*:\s*([^;}]*)/gi;
const HAS_BG = /(^|[;{\s])background(-color|-image)?\s*:\s*(?!\s*(none|transparent|inherit|initial)\s*(;|!|$))/i;

/** Таблица стилей словаря → без собственных шрифтов и абсолютных размеров и/или с едиными цветами. */
export function unifyCss(css: string, faces: string[], o: Uni): string {
  const keep: string[] = [];
  let s = css.replace(/@font-face\s*\{[^}]*\}/g, (m) => { keep.push(m); return `\u0000${keep.length - 1}\u0000`; });
  if (o.font) s = s.replace(FONT_DECL, (_m, lead: string, prop: string, val: string) => lead + fixFont(prop, val, faces));
  if (o.color) {
    s = s.replace(/\{([^{}]*)\}/g, (m, body: string) => {
      if (HAS_BG.test(body)) return m; // плашки и метки с фоном: цвет текста подобран под фон
      return '{' + body.replace(COLOR_DECL, (m2, lead: string, val: string) => lead + (fixColor(val) ?? 'color:' + val)) + '}';
    });
  }
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => keep[+i]);
}

/** Атрибут style у элемента: убираем шрифты и абсолютные размеры (цвета подгоняются позже, уже в готовой статье). */
export function unifyInline(style: string): string {
  return unifyCss(style, [], { font: true, color: false }).replace(/;{2,}/g, ';').replace(/^\s*;|;\s*$/g, '');
}
