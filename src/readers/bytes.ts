import { Unsupported } from './types';

/** Файл как набор байт с произвольным доступом (обычный, dictzip или целиком распакованный gzip). */
export interface Bytes {
  readAhead?(on: boolean): void;
  size: number; // размер распакованных данных
  read(start: number, end: number): Promise<Uint8Array>;
  /** Весь распакованный поток подряд (для разбора индекса). */
  stream(): ReadableStream<Uint8Array>;
}

export const slice = async (f: Blob, a: number, b: number) => new Uint8Array(await f.slice(a, b).arrayBuffer());

async function inflate(data: Uint8Array, format: 'deflate' | 'deflate-raw' | 'gzip'): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export const inflateZlib = (d: Uint8Array) => inflate(d, 'deflate');
export const inflateRaw = (d: Uint8Array) => inflate(d, 'deflate-raw');

class Plain implements Bytes {
  ahead = false; // при просмотре всех статей подряд читаем окнами по 8 МБ
  private win?: { start: number; data: Uint8Array };
  constructor(private f: File) {}
  get size() { return this.f.size; }
  async read(a: number, b: number): Promise<Uint8Array> {
    if (!this.ahead) return slice(this.f, a, b);
    const w = this.win;
    if (w && a >= w.start && b <= w.start + w.data.length) return w.data.subarray(a - w.start, b - w.start);
    const data = await slice(this.f, a, Math.min(this.f.size, a + Math.max(b - a, 8 << 20)));
    this.win = { start: a, data };
    return data.subarray(0, b - a);
  }
  readAhead(on: boolean) { this.ahead = on; if (!on) this.win = undefined; }
  stream() { return this.f.stream() as ReadableStream<Uint8Array>; }
}

/** gzip без таблицы dictzip: распаковывается один раз целиком (годится для небольших .idx.gz/.syn.gz). */
class WholeGzip implements Bytes {
  private data?: Promise<Uint8Array>;
  constructor(private f: File, public size: number) {}
  private all() { return (this.data ??= slice(this.f, 0, this.f.size).then((d) => inflate(d, 'gzip'))); }
  async read(a: number, b: number) { return (await this.all()).subarray(a, b); }
  stream() {
    return this.f.stream().pipeThrough(new DecompressionStream('gzip')) as ReadableStream<Uint8Array>;
  }
}

/** dictzip: gzip, в заголовке которого лежит таблица независимо сжатых кусков (поле «RA»). */
class DictZip implements Bytes {
  private cache = new Map<number, Uint8Array>();
  constructor(
    private f: File,
    public size: number,
    private dataStart: number,
    private chlen: number,
    private cum: Float64Array, // начало каждого куска в сжатом потоке, n+1
  ) {}

  private async chunk(i: number, raw: Uint8Array): Promise<Uint8Array> {
    const hit = this.cache.get(i);
    if (hit) return hit;
    const last = i === this.cum.length - 2;
    let out: Uint8Array;
    // куски кончаются Z_FULL_FLUSH, у распаковщика нет финального блока: добавляем пустой финальный
    const sealed = new Uint8Array(raw.length + 5);
    sealed.set(raw);
    sealed.set([1, 0, 0, 255, 255], raw.length);
    try {
      out = await inflate(last ? raw : sealed, 'deflate-raw');
    } catch {
      out = await inflate(last ? sealed : raw, 'deflate-raw');
    }
    this.cache.set(i, out);
    if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value!);
    return out;
  }

  async read(a: number, b: number): Promise<Uint8Array> {
    b = Math.min(b, this.size);
    if (b <= a) return new Uint8Array(0);
    const c0 = Math.floor(a / this.chlen), c1 = Math.floor((b - 1) / this.chlen);
    const comp = await slice(this.f, this.dataStart + this.cum[c0], this.dataStart + this.cum[c1 + 1]);
    const parts: Uint8Array[] = [];
    for (let c = c0; c <= c1; c++) {
      const raw = comp.subarray(this.cum[c] - this.cum[c0], this.cum[c + 1] - this.cum[c0]);
      parts.push(await this.chunk(c, raw));
    }
    const all = parts.length === 1 ? parts[0] : concat(parts);
    return all.subarray(a - c0 * this.chlen, b - c0 * this.chlen);
  }

  stream() {
    return this.f.stream().pipeThrough(new DecompressionStream('gzip')) as ReadableStream<Uint8Array>;
  }
}

export function concat(a: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
  let p = 0;
  for (const x of a) { out.set(x, p); p += x.length; }
  return out;
}

export async function openBytes(f: File): Promise<Bytes> {
  const head = await slice(f, 0, Math.min(f.size, 1 << 17));
  if (head[0] !== 0x1f || head[1] !== 0x8b) return new Plain(f);
  const tail = new DataView((await slice(f, Math.max(0, f.size - 4), f.size)).buffer);
  const total = tail.getUint32(0, true); // ISIZE: размер распакованных данных (по модулю 2^32)
  const flg = head[3];
  let p = 10;
  let chlen = 0;
  let sizes: number[] | null = null;
  if (flg & 4) {
    const xlen = head[p] | (head[p + 1] << 8);
    p += 2;
    for (let i = p; i + 4 <= p + xlen; ) {
      const len = head[i + 2] | (head[i + 3] << 8);
      if (head[i] === 0x52 && head[i + 1] === 0x41) { // «RA»
        chlen = head[i + 6] | (head[i + 7] << 8);
        const cnt = head[i + 8] | (head[i + 9] << 8);
        sizes = [];
        for (let k = 0; k < cnt; k++) sizes.push(head[i + 10 + 2 * k] | (head[i + 11 + 2 * k] << 8));
      }
      i += 4 + len;
    }
    p += xlen;
  }
  if (flg & 8) { while (head[p++] !== 0); }
  if (flg & 16) { while (head[p++] !== 0); }
  if (flg & 2) p += 2;
  if (!sizes || !chlen) return new WholeGzip(f, total);
  if (p >= head.length) throw new Unsupported('слишком длинный заголовок dictzip');
  const cum = new Float64Array(sizes.length + 1);
  for (let i = 0; i < sizes.length; i++) cum[i + 1] = cum[i] + sizes[i];
  return new DictZip(f, total, p, chlen, cum);
}

/** Читает поток кусками; callback получает кусок. */
export async function eachChunk(s: ReadableStream<Uint8Array>, fn: (c: Uint8Array) => void | Promise<void>) {
  const r = s.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    await fn(value);
  }
}
