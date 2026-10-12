const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const SIMPLE: Record<string, [string, string]> = {
  b: ['<b>', '</b>'],
  i: ['<i>', '</i>'],
  u: ['<u>', '</u>'],
  sub: ['<sub>', '</sub>'],
  sup: ['<sup>', '</sup>'],
  p: ['<span class="p">', '</span>'],
  ex: ['<span class="ex">', '</span>'],
  com: ['<span class="com">', '</span>'],
  trn: ['<span class="trn">', '</span>'],
  lang: ['<span class="lang">', '</span>'],
  t: ['<span class="tr">', '</span>'],
  '*': ['<span class="opt">', '</span>'],
  "'": ['<span class="st">', '</span>'],
  ref: ['<a class="ref">', '</a>'], // адрес перехода берётся из текста ссылки при показе
  trs: ['', ''],
  '!trs': ['', ''],
  preview: ['<span hidden>', '</span>'],
  video: ['<span hidden>', '</span>'],
};
const KNOWN_COLORS = new Set(['red', 'gray', 'grey', 'green', 'darkgreen', 'blue', 'darkblue', 'brown', 'violet', 'purple', 'darkslategray', 'slategray', 'dimgray', 'darkgray']);
const SOUND = /\.(wav|mp3|ogg|oga|flac|aac|m4a|spx|opus)$/i;
const IMAGE = /\.(jpe?g|png|gif|bmp|svg|webp|tiff?)$/i;

// один разбор: экранирование, теги [..], комментарии {{..}}, ссылки <<..>>, обычный текст
const TOKEN = /\\(.)|\[(\/?)([^\[\]\s]+)(?:\s+([^\]]*))?\]|\{\{[\s\S]*?\}\}|<<([^<>]+?)>>|[^\\\[<{]+|[\s\S]/g;

/** Статья DSL (текст всех строк тела) → HTML. Ресурсы ([s], [video]) пока не подгружаются. */
export function dslToHtml(text: string): string {
  const out: string[] = [];
  const stack: { name: string; close: string }[] = [];
  let capture: { name: string; buf: string } | null = null;

  const closeTag = (name: string) => {
    let k = stack.length - 1;
    while (k >= 0 && stack[k].name !== name) k--;
    if (k < 0) return;
    while (stack.length > k) out.push(stack.pop()!.close);
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '').replace(/^[ \t]+/, '');
    if (!line) continue;
    let block = false;
    TOKEN.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = TOKEN.exec(line)); ) {
      if (m[1] !== undefined) { // экранированный символ
        const t = esc(m[1]);
        if (capture) capture.buf += t; else out.push(t);
      } else if (m[3] !== undefined) { // тег
        const close = m[2] === '/', name = m[3].toLowerCase(), arg = m[4];
        if (capture) {
          if (close && name === capture.name) {
            const c = capture; capture = null;
            const val = c.buf.trim();
            if (c.name === 's') {
              if (SOUND.test(val)) out.push(`<span class="snd" data-snd="${esc(val)}">🔊</span>`);
              else if (IMAGE.test(val)) out.push(`<img data-res="${esc(val)}">`);
            } else if (c.name === 'url') {
              out.push(`<a href="${esc(val)}" target="_blank" rel="noopener noreferrer">${esc(val)}</a>`);
            }
          } else capture.buf += ''; // теги внутри [s]/[url] не нужны
          continue;
        }
        if (name === 's' || name === 'url') {
          if (!close) capture = { name, buf: '' };
          continue;
        }
        if (/^m\d?$/.test(name)) {
          if (close) closeTag('m');
          else {
            out.push(`<div class="m m${name.slice(1) || '1'}">`);
            stack.push({ name: 'm', close: '</div>' });
          }
          block = true;
          continue;
        }
        if (name === 'c') {
          if (close) closeTag('c');
          else {
            const col = (arg ?? 'green').trim().replace(/^"|"$/g, '').toLowerCase();
            const tag = KNOWN_COLORS.has(col) ? `<span class="c-${col}">` : `<span style="color:${/^[#a-z0-9(),.% ]+$/.test(col) ? col : 'inherit'}">`;
            out.push(tag);
            stack.push({ name: 'c', close: '</span>' });
          }
          continue;
        }
        const tag = SIMPLE[name];
        if (!tag) continue;
        if (close) closeTag(name);
        else {
          out.push(tag[0]);
          stack.push({ name, close: tag[1] });
        }
      } else if (m[5] !== undefined) { // <<ссылка>>
        out.push(`<a class="ref" data-w="${esc(m[5])}">${esc(m[5])}</a>`);
      } else if (m[0].startsWith('{{')) {
        // комментарий разработчика словаря — не показываем
      } else {
        // в части словарей текст уже содержит сущности HTML (&lt; &amp;), раскрываем их перед экранированием
        const plain = m[0].replace(/&(lt|gt|amp|quot|apos|nbsp|#\d+);/g, (_, n: string) =>
          ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' })[n] ?? String.fromCharCode(+n.slice(1)));
        if (capture) capture.buf += plain; else out.push(esc(plain));
      }
    }
    if (capture) capture = null; // незакрытый [s]/[url] не должен съесть остаток статьи
    if (!block) out.push('<br>');
  }
  while (stack.length) out.push(stack.pop()!.close);
  return out.join('');
}

/** Заголовок DSL: убираем {служебные теги}, снимаем экранирование. */
export function cleanHeadword(h: string): string {
  return h
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * В DSL текст в круглых скобках внутри заголовка необязателен: «(se) souvenir» ищется и как «souvenir».
 * Возвращает заголовок как есть и, если есть необязательная часть, вариант без неё.
 */
export function headVariants(raw: string): string[] {
  const main = cleanHeadword(raw);
  const BS = String.fromCharCode(92);
  // экранированные скобки — обычные символы, прячем их на время поиска необязательной части
  const guarded = raw.split(BS + '(').join('\u0001').split(BS + ')').join('\u0002');
  const stripped = guarded.replace(/[(][^()]*[)]/g, ' ');
  if (stripped === guarded) return [main];
  const v = cleanHeadword(stripped.split('\u0001').join(BS + '(').split('\u0002').join(BS + ')'));
  return v && v !== main ? [main, v] : [main];
}
