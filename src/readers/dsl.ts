import { concat, eachChunk, openBytes, type Bytes } from './bytes';
import { dslToHtml, headVariants } from './dslhtml';
import { Zip, type Resource } from './resources';
import { Unsupported, type Format, type Reader } from './types';

interface DslCache {
  title: string;
  lang: string;
  utf16: boolean;
  headwords: string[];
  starts: Float64Array; // начало тела статьи (байты распакованного файла)
  ends: Float64Array;
}

/**
 * Строка без отступа, которая на самом деле начало статьи, а не заголовок (в Grimm у ~10 статей потерялась строка
 * заголовка, и статья начинается прямо с «слово, текст…»): в ней закрывающие теги DSL, метка абзаца [m1],
 * либо она слишком длинная для заголовка и похожа на предложение.
 */
const looksLikeBody = (s: string) => s.length > 300 || /\[\/(?:i|b|c|m|u|sup|sub|ex|trn|\*)\]|\[m\d?\]/.test(s) || (s.length > 150 && /[.;:]\s/.test(s));

/** Заголовки из такой строки: слово (или слова через запятую) до первой разметки либо до первой запятой с пробелом. */
function defectiveHeads(line: string): string[] {
  // слова без пробелов, через запятую без пробела («gewerbe-,gewerbslegislation,[m1]…»), дальше разметка или пробел
  const m = /^([^\s\[,]+(?:,[^\s\[,]+)*),?(?=\[|\s|$)/.exec(line);
  const head = m ? m[1] : line.split(/,\s/)[0];
  return head.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 6);
}

/**
 * Один проход по потоку: тело статьи читаем только как диапазон байт, декодируем лишь строки заголовков.
 * Поэтому Трезор (380 МБ) не превращается в строку в памяти.
 */
async function parse(bytes: Bytes, onProgress: (d: number, t: number) => void): Promise<DslCache> {
  const headwords: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let title = '';
  let lang = '';
  let utf16 = false;
  let dec = new TextDecoder('utf-8');
  let unit = 1;
  let started = false;

  let heads: string[] = [];
  let bodyStart = -1, bodyEnd = -1;
  const flush = () => {
    if (bodyStart >= 0) {
      for (const h of heads) {
        for (const c of headVariants(h)) if (c) { headwords.push(c); starts.push(bodyStart); ends.push(bodyEnd); }
      }
    }
    heads = [];
    bodyStart = bodyEnd = -1;
  };

  let carry: Uint8Array = new Uint8Array(0);
  let carryAbs = 0; // абсолютное смещение carry[0]
  let lastReport = 0;

  const process = (buf: Uint8Array, base: number, final: boolean): number => {
    let p = 0;
    for (;;) {
      let nl = -1;
      if (unit === 1) nl = buf.indexOf(10, p);
      else {
        for (let i = buf.indexOf(10, p); i >= 0; i = buf.indexOf(10, i + 1)) {
          if (((base + i) & 1) === 0 && buf[i + 1] === 0) { nl = i; break; }
          if (i + 1 >= buf.length) break;
        }
      }
      let next: number;
      if (nl < 0) {
        if (!final || p >= buf.length) return p;
        nl = buf.length;
        next = buf.length;
      } else next = nl + unit;
      let le = nl; // конец строки без CR
      if (unit === 1 ? buf[le - 1] === 13 && le > p : le - 2 >= p && buf[le - 2] === 13 && buf[le - 1] === 0) le -= unit;

      if (le > p) {
        const c = buf[p], hi = unit === 2 ? buf[p + 1] : 0;
        if (c === 32 || c === 9) { // тело
          if (heads.length) { if (bodyStart < 0) bodyStart = base + p; bodyEnd = base + next; }
        } else if (c === 35 && hi === 0 && !heads.length && bodyStart < 0) { // #NAME и другие
          const line = dec.decode(buf.subarray(p, le));
          const m = /^#NAME\s+"(.*)"/.exec(line);
          if (m) title = m[1];
          const l = /^#INDEX_LANGUAGE\s+"(.*)"/.exec(line);
          if (l) lang = l[1];
        } else { // заголовок
          const line = dec.decode(buf.subarray(p, le));
          if (looksLikeBody(line)) { // потерянная строка заголовка: слово берём из начала строки, сама строка — начало тела
            flush();
            heads = defectiveHeads(line);
            bodyStart = base + p;
            bodyEnd = base + next;
          } else {
            if (bodyStart >= 0) flush();
            heads.push(line);
          }
        }
      }
      p = next;
      if (p >= buf.length) return p;
    }
  };

  await eachChunk(bytes.stream(), (chunk) => {
    let buf = carry.length ? concat([carry, chunk]) : chunk;
    let base = carryAbs;
    if (!started) {
      if (buf.length < 4) { carry = buf; return; }
      started = true;
      let skip = 0;
      if (buf[0] === 0xff && buf[1] === 0xfe) { utf16 = true; skip = 2; }
      else if (buf[0] === 0xfe && buf[1] === 0xff) throw new Unsupported('UTF-16 big-endian');
      else if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) skip = 3;
      else if (buf[1] === 0 && buf[0] !== 0) utf16 = true;
      if (utf16) { dec = new TextDecoder('utf-16le'); unit = 2; }
      if (skip) { buf = buf.subarray(skip); base += skip; }
    }
    const used = process(buf, base, false);
    carry = buf.slice(used);
    carryAbs = base + used;
    const now = performance.now();
    if (now - lastReport > 150) { lastReport = now; onProgress(carryAbs, bytes.size); }
  });
  if (!started) throw new Unsupported('пустой файл');
  if (carry.length) process(carry, carryAbs, true);
  flush();
  return {
    title, lang, utf16, headwords,
    starts: Float64Array.from(starts),
    ends: Float64Array.from(ends),
  };
}

/**
 * Кэши, собранные до исправления: «заголовок»-начало статьи (looksLikeBody) заменяем настоящим заголовком,
 * а тело начинаем с самой этой строки (она лежит сразу за концом предыдущей статьи).
 */
export function repairCache(c: DslCache): DslCache {
  if (!c.headwords.some(looksLikeBody)) return c;
  const hw: string[] = [], st: number[] = [], en: number[] = [];
  for (let i = 0; i < c.headwords.length; i++) {
    const h = c.headwords[i];
    if (!looksLikeBody(h)) { hw.push(h); st.push(c.starts[i]); en.push(c.ends[i]); continue; }
    if (i > 0 && c.starts[i] === c.starts[i - 1] && looksLikeBody(c.headwords[i - 1])) continue; // варианты той же строки
    const from = i > 0 ? Math.min(c.ends[i - 1], c.starts[i]) : c.starts[i];
    for (const w of defectiveHeads(h)) for (const v of headVariants(w)) if (v) { hw.push(v); st.push(from); en.push(c.ends[i]); }
  }
  return { ...c, headwords: hw, starts: Float64Array.from(st), ends: Float64Array.from(en) };
}

class DslReader implements Reader {
  private c: DslCache;
  private dec: TextDecoder;
  private zip?: Zip;
  constructor(private bytes: Bytes, c0: DslCache, fallbackTitle: string, zip?: File) {
    const c = repairCache(c0);
    this.c = c;
    if (zip) this.zip = new Zip(zip);
    this.dec = new TextDecoder(c.utf16 ? 'utf-16le' : 'utf-8');
    this.title = c.title || fallbackTitle;
  }
  title: string;
  get lang() { return this.c.lang; }
  bodyId(i: number) { return this.c.starts[i]; }
  scan(on: boolean) { this.bytes.readAhead?.(on); }
  /** Чистый текст прямо из разметки DSL, без превращения в HTML (для текстового поиска). */
  async text(i: number): Promise<string> {
    const raw = this.dec.decode(await this.bytes.read(this.c.starts[i], this.c.ends[i]));
    return raw
      .replace(/\{\{[\s\S]*?\}\}/g, ' ')
      .replace(/(?<!\\)\[\/?[^\[\]\\]*\]/g, '')
      .replace(/<<|>>/g, '')
      .replace(/\\(.)/g, '$1');
  }
  async resource(name: string): Promise<Resource | null> { return this.zip ? this.zip.read(name) : null; }
  get headwords() { return this.c.headwords; }
  async read(i: number): Promise<string> {
    const raw = await this.bytes.read(this.c.starts[i], this.c.ends[i]);
    return dslToHtml(this.dec.decode(raw));
  }
}

export const dsl: Format = {
  id: 'dsl',
  async open(src, cached, onProgress) {
    const bytes = await openBytes(src.main);
    const c = (cached as DslCache | undefined) ?? (await parse(bytes, onProgress));
    return { reader: new DslReader(bytes, c, '', src.aux['files.zip']), cache: c };
  },
};
