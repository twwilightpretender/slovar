import { ripemd128 } from '../core/ripemd128';
import { NameIndex, mimeOf, type Resource } from './resources';
import { Unsupported, type Format, type Reader } from './types';

/** Всё, что нужно, чтобы снова открыть словарь без разбора ключей. */
interface MdxCache {
  title: string;
  utf16: boolean;
  headwords: string[];
  offsets: Float64Array; // смещение записи в распакованном потоке
  rComp: Float64Array; // начало блока в файле (относительно rstart), n+1
  rDec: Float64Array; // начало блока в распакованном потоке, n+1
  rstart: number;
}

const u8 = async (f: Blob, a: number, b: number) => new Uint8Array(await f.slice(a, b).arrayBuffer());
const be64 = (dv: DataView, p: number) => dv.getUint32(p) * 4294967296 + dv.getUint32(p + 4);

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Блок MDX: 4 байта тип, 4 байта adler32, дальше данные. */
async function unblock(b: Uint8Array): Promise<Uint8Array> {
  const type = b[0];
  if (type === 0) return b.subarray(8);
  if (type === 2) return inflate(b.subarray(8));
  throw new Unsupported('сжатие LZO');
}

/** Encrypted=2: индекс блоков ключей зашифрован; ключ берётся из самого блока (регистрация не нужна). */
function decryptKeyInfo(b: Uint8Array): Uint8Array {
  const seed = new Uint8Array(8);
  seed.set(b.subarray(4, 8));
  seed.set([0x95, 0x36, 0x00, 0x00], 4);
  const key = ripemd128(seed);
  const out = b.slice();
  let prev = 0x36;
  for (let i = 8; i < out.length; i++) {
    const j = i - 8, c = out[i];
    out[i] = (((c >> 4) | (c << 4)) & 0xff) ^ prev ^ (j & 0xff) ^ key[j % 16];
    prev = c;
  }
  return out;
}

async function parse(f: File, onProgress: (d: number, t: number) => void, mdd = false): Promise<MdxCache> {
  const n = new DataView((await f.slice(0, 4).arrayBuffer())).getUint32(0);
  const hdr = new TextDecoder('utf-16le').decode(await u8(f, 4, 4 + n));
  const attr = (a: string) => new RegExp(a + '="([^"]*)"', 'i').exec(hdr)?.[1];
  // в MDD ключи (пути файлов) всегда UTF-16, как бы ни был заполнен заголовок
  const enc = mdd ? 'UTF-16' : (attr('Encoding') ?? 'UTF-8').toUpperCase().replace('UTF8', 'UTF-8');
  const version = parseFloat(attr('GeneratedByEngineVersion') ?? '2');
  const encrypted = attr('Encrypted') ?? '0';
  if (version < 2) throw new Unsupported('MDX версии 1.x');
  const encBits = /^\d+$/.test(encrypted) ? parseInt(encrypted, 10) : encrypted.toLowerCase() === 'yes' ? 1 : 0;
  if (encBits & 1) throw new Unsupported('словарь с личным ключом регистрации (Encrypted=' + encrypted + ')');
  if (enc !== 'UTF-8' && enc !== 'UTF-16') throw new Unsupported('кодировка ' + enc);
  const utf16 = enc === 'UTF-16';
  const w = utf16 ? 2 : 1;
  const text = new TextDecoder(utf16 ? 'utf-16le' : 'utf-8');

  let pos = 4 + n + 4;
  const kh = new DataView((await u8(f, pos, pos + 40)).buffer);
  const nkb = be64(kh, 0), kiLen = be64(kh, 24), kbLen = be64(kh, 32);
  pos += 44;
  let kiRaw: Uint8Array = await u8(f, pos, pos + kiLen);
  if (encBits & 2) kiRaw = decryptKeyInfo(kiRaw);
  const ki = await unblock(kiRaw);
  pos += kiLen;
  const kbRaw = await u8(f, pos, pos + kbLen);
  pos += kbLen;

  const kd = new DataView(ki.buffer, ki.byteOffset, ki.byteLength);
  const blocks: [number, number][] = [];
  let p = 0;
  for (let i = 0; i < nkb; i++) {
    p += 8; // число записей
    p += 2 + (kd.getUint16(p) + 1) * w; // первый ключ
    p += 2 + (kd.getUint16(p) + 1) * w; // последний ключ
    blocks.push([be64(kd, p), be64(kd, p + 8)]);
    p += 16;
  }

  const headwords: string[] = [];
  const offs: number[] = [];
  let q = 0;
  for (let b = 0; b < blocks.length; b++) {
    const [cs] = blocks[b];
    const d = await unblock(kbRaw.subarray(q, q + cs));
    q += cs;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let i = 0;
    while (i < d.length) {
      offs.push(be64(dv, i));
      i += 8;
      let j = i;
      if (utf16) while (j + 1 < d.length && (d[j] !== 0 || d[j + 1] !== 0)) j += 2;
      else while (j < d.length && d[j] !== 0) j++;
      headwords.push(text.decode(d.subarray(i, j)));
      i = j + w;
    }
    if ((b & 15) === 0) onProgress(b, blocks.length);
  }

  const rh = new DataView((await u8(f, pos, pos + 32)).buffer);
  const nrb = be64(rh, 0), riLen = be64(rh, 16);
  const ri = new DataView((await u8(f, pos + 32, pos + 32 + riLen)).buffer);
  const rComp = new Float64Array(nrb + 1), rDec = new Float64Array(nrb + 1);
  for (let i = 0; i < nrb; i++) {
    rComp[i + 1] = rComp[i] + be64(ri, i * 16);
    rDec[i + 1] = rDec[i] + be64(ri, i * 16 + 8);
  }
  const t = (attr('Title') ?? '').replace(/<[^>]*>/g, '').trim();
  return { title: t, utf16, headwords, offsets: Float64Array.from(offs), rComp, rDec, rstart: pos + 32 + riLen };
}

/** Блоки записей MDX/MDD: распаковка с кэшем и чтение диапазонов. */
class Records {
  private cache = new Map<number, Uint8Array>();
  constructor(private f: File, private c: MdxCache) {}

  private async block(i: number): Promise<Uint8Array> {
    const hit = this.cache.get(i);
    if (hit) { this.cache.delete(i); this.cache.set(i, hit); return hit; }
    const { rComp, rstart } = this.c;
    const d = await unblock(await u8(this.f, rstart + rComp[i], rstart + rComp[i + 1]));
    this.cache.set(i, d);
    if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!);
    return d;
  }

  private blockOf(off: number): number {
    const { rDec } = this.c;
    let lo = 0, hi = rDec.length - 1; // последний блок, у которого rDec[b] <= off
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rDec[m] <= off) lo = m; else hi = m; }
    return lo;
  }

  /** Запись MDX: текст до нулевого символа. */
  async text(off: number): Promise<string> {
    const { rDec, utf16 } = this.c;
    let b = this.blockOf(off), start = off - rDec[b];
    const parts: Uint8Array[] = [];
    for (;;) {
      const d = await this.block(b);
      let e = start;
      if (utf16) while (e + 1 < d.length && (d[e] !== 0 || d[e + 1] !== 0)) e += 2;
      else while (e < d.length && d[e] !== 0) e++;
      parts.push(d.subarray(start, e));
      if (e < d.length || b + 2 >= rDec.length) break;
      b++; start = 0; // запись продолжается в следующем блоке
    }
    const all = parts.length === 1 ? parts[0] : concat(parts);
    return new TextDecoder(utf16 ? 'utf-16le' : 'utf-8').decode(all);
  }

  /** Запись MDD: байты от off до end (конец записи = начало следующей). */
  async range(off: number, end: number): Promise<Uint8Array> {
    const { rDec } = this.c;
    const parts: Uint8Array[] = [];
    let b = this.blockOf(off), pos = off;
    while (pos < end && b < rDec.length - 1) {
      const d = await this.block(b);
      const e = Math.min(end - rDec[b], d.length);
      parts.push(d.subarray(pos - rDec[b], e));
      pos = rDec[b] + e;
      b++;
    }
    return parts.length === 1 ? parts[0] : concat(parts);
  }
}

/** Ресурсы словаря из файлов .mdd: разбираются при первом обращении. */
class Mdd {
  private ready?: Promise<{ idx: NameIndex<{ r: Records; off: number; end: number }> }>;
  constructor(private files: File[]) {}

  private load() {
    return (this.ready ??= (async () => {
      const idx = new NameIndex<{ r: Records; off: number; end: number }>();
      for (const f of this.files) {
        const c = await parse(f, () => {}, true);
        const r = new Records(f, c);
        const total = c.rDec[c.rDec.length - 1];
        const sorted = Float64Array.from(c.offsets).sort();
        c.headwords.forEach((name, i) => {
          let lo = 0, hi = sorted.length; // первое смещение больше текущего
          while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= c.offsets[i]) lo = m + 1; else hi = m; }
          idx.add(name, { r, off: c.offsets[i], end: lo < sorted.length ? sorted[lo] : total });
        });
      }
      return { idx };
    })());
  }

  async get(name: string): Promise<Resource | null> {
    if (!this.files.length) return null;
    const hit = (await this.load()).idx.get(name);
    return hit ? { mime: mimeOf(name), data: await hit.r.range(hit.off, hit.end) } : null;
  }
}

class MdxReader implements Reader {
  private rec: Records;
  private mdd: Mdd;
  private hw: string[];
  constructor(f: File, private c: MdxCache, mdd: File[]) {
    this.rec = new Records(f, c);
    this.mdd = new Mdd(mdd);
    // в некоторых словарях (Le Robert historique) в заголовки попала HTML-разметка («AP<span…>Ô»): убираем теги при открытии
    this.hw = c.headwords.some((h) => h.includes('<')) ? c.headwords.map((h) => (h.includes('<') ? h.replace(/<[^>]*>/g, '') : h)) : c.headwords;
  }
  get title() { return this.c.title; }
  get headwords() { return this.hw; }
  read(i: number) { return this.rec.text(this.c.offsets[i]); }
  bodyId(i: number) { return this.c.offsets[i]; }
  resource(name: string) { return this.mdd.get(name); }
}

function concat(a: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
  let p = 0;
  for (const x of a) { out.set(x, p); p += x.length; }
  return out;
}

export const mdx: Format = {
  id: 'mdx',
  async open(src, cached, onProgress) {
    const c = (cached as MdxCache | undefined) ?? (await parse(src.main, onProgress));
    return { reader: new MdxReader(src.main, c, src.mdd), cache: c };
  },
};
