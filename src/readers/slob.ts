import { inflateZlib, slice } from './bytes';
import { NameIndex, mimeOf, type Resource } from './resources';
import { Unsupported, type Format, type Reader } from './types';

interface SlobCache {
  title: string;
  headwords: string[];
  bin: Uint32Array; // номер блока у каждой записи
  item: Uint16Array; // номер статьи внутри блока
  binPos: Float64Array; // положение каждого блока в файле
  resKeys: string[]; // ресурсы (css, js, картинки): ключ, блок, номер, тип
  resBin: Uint32Array;
  resItem: Uint16Array;
  resType: string[];
}

const u32 = (b: Uint8Array, p: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(p);
const u64 = (b: Uint8Array, p: number) => {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return d.getUint32(p) * 4294967296 + d.getUint32(p + 4);
};

async function parse(f: File): Promise<SlobCache> {
  const head = await slice(f, 0, Math.min(f.size, 1 << 16));
  const magic = new TextDecoder('latin1').decode(head.subarray(0, 7));
  if (magic !== '!-1SLOB') throw new Unsupported('это не файл Slob');
  let p = 8 + 16;
  const tiny = () => { const n = head[p++]; const s = head.subarray(p, p + n); p += n; return s; };
  const enc = new TextDecoder().decode(tiny());
  const td = new TextDecoder(enc || 'utf-8');
  const comp = td.decode(tiny());
  if (comp && comp !== 'zlib') throw new Unsupported('сжатие ' + comp + ' (Slob читается только с zlib)');
  let title = '';
  for (let n = head[p++]; n > 0; n--) {
    const k = td.decode(tiny()), v = td.decode(tiny()).replace(/\0+$/, '');
    if (k.replace(/\0+$/, '') === 'label') title = v;
  }
  const types: string[] = [];
  for (let n = head[p++]; n > 0; n--) {
    const len = (head[p] << 8) | head[p + 1];
    p += 2;
    types.push(td.decode(head.subarray(p, p + len)));
    p += len;
  }
  p += 4; // число блоков
  const storeOff = u64(head, p);
  p += 16; // storeOff + размер файла
  const refsOff = p;
  const isText = types.map((t) => /^text\/(html|plain)/i.test(t));

  // --- блоки хранилища и типы их статей ---
  const sc = u32(await slice(f, storeOff, storeOff + 4), 0);
  const pos = await slice(f, storeOff + 4, storeOff + 4 + 8 * sc);
  const base = storeOff + 4 + 8 * sc;
  const binPos = new Float64Array(sc);
  for (let i = 0; i < sc; i++) binPos[i] = base + u64(pos, i * 8);
  const binIds: Uint8Array[] = new Array(sc); // для каждого блока: тип содержимого каждой его статьи
  for (let i = 0; i < sc; i += 32) {
    await Promise.all(
      Array.from({ length: Math.min(32, sc - i) }, async (_, j) => {
        const b = i + j;
        const cnt = u32(await slice(f, binPos[b], binPos[b] + 4), 0);
        const ids = await slice(f, binPos[b] + 4, binPos[b] + 4 + cnt);
        binIds[b] = ids;
      }),
    );
  }

  // --- ссылки (заголовки) ---
  const refCount = u32(await slice(f, refsOff, refsOff + 4), 0);
  const refs = await slice(f, refsOff + 4 + 8 * refCount, storeOff);
  const rd = new TextDecoder(enc || 'utf-8');
  const headwords: string[] = [];
  const bin: number[] = [];
  const item: number[] = [];
  const seen = new Set<string>();
  const resKeys: string[] = [], resBin: number[] = [], resItem: number[] = [], resType: string[] = [];
  let q = 0;
  for (let i = 0; i < refCount && q + 2 <= refs.length; i++) {
    const kl = (refs[q] << 8) | refs[q + 1];
    q += 2;
    const key = rd.decode(refs.subarray(q, q + kl));
    q += kl;
    const b = u32(refs, q);
    const it = (refs[q + 4] << 8) | refs[q + 5];
    q += 6;
    q += 1 + refs[q]; // фрагмент (якорь) не нужен
    const tid = binIds[b]?.[it];
    if (tid === undefined) continue;
    if (!isText[tid]) { // CSS, скрипт, картинка — не заголовок, а ресурс
      resKeys.push(key); resBin.push(b); resItem.push(it); resType.push(types[tid]);
      continue;
    }
    const id = b + ':' + it + ':' + key;
    if (seen.has(id)) continue;
    seen.add(id);
    headwords.push(key);
    bin.push(b);
    item.push(it);
  }
  return {
    title, headwords, bin: Uint32Array.from(bin), item: Uint16Array.from(item), binPos,
    resKeys, resBin: Uint32Array.from(resBin), resItem: Uint16Array.from(resItem), resType,
  };
}

class SlobReader implements Reader {
  private cache = new Map<number, { cnt: number; data: Uint8Array }>();
  private td = new TextDecoder('utf-8');
  title: string;
  constructor(private f: File, private c: SlobCache, fallback: string) { this.title = c.title || fallback; }
  get headwords() { return this.c.headwords; }

  private async bin(b: number) {
    const hit = this.cache.get(b);
    if (hit) return hit;
    const pos = this.c.binPos[b];
    const cnt = u32(await slice(this.f, pos, pos + 4), 0);
    const clen = u32(await slice(this.f, pos + 4 + cnt, pos + 8 + cnt), 0);
    const data = await inflateZlib(await slice(this.f, pos + 8 + cnt, pos + 8 + cnt + clen));
    const r = { cnt, data };
    this.cache.set(b, r);
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
    return r;
  }

  private async item(b: number, it: number): Promise<Uint8Array> {
    const { cnt, data } = await this.bin(b);
    const off = 4 * cnt + u32(data, 4 * it); // таблица из cnt позиций, затем статьи (длина + байты)
    const len = u32(data, off);
    return data.subarray(off + 4, off + 4 + len);
  }

  async read(i: number): Promise<string> {
    return this.td.decode(await this.item(this.c.bin[i], this.c.item[i]));
  }

  bodyId(i: number) { return this.c.bin[i] * 65536 + this.c.item[i]; }

  private resIdx?: NameIndex<number>;
  async resource(name: string): Promise<Resource | null> {
    if (!this.resIdx) {
      this.resIdx = new NameIndex<number>();
      this.c.resKeys.forEach((k, i) => this.resIdx!.add(k, i));
    }
    const i = this.resIdx.get(name);
    if (i === undefined) return null;
    const mime = this.c.resType[i].split(';')[0].trim();
    return { mime: mime || mimeOf(name), data: await this.item(this.c.resBin[i], this.c.resItem[i]) };
  }
}

export const slob: Format = {
  id: 'slob',
  async open(src, cached) {
    const c = (cached as SlobCache | undefined) ?? (await parse(src.main));
    return { reader: new SlobReader(src.main, c, ''), cache: c };
  },
};
