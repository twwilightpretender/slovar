import { slice, inflateRaw } from './bytes';

export interface Resource {
  mime: string;
  data: Uint8Array;
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml',
  webp: 'image/webp', ico: 'image/x-icon', css: 'text/css', js: 'text/javascript',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', spx: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
};
export const mimeOf = (name: string): string => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** Имя ресурса из статьи → ключ поиска: без регистра, с «/», без file://, ./ и ведущего «/» или «~/». */
export function normName(name: string): string {
  let n = name.trim();
  try { n = decodeURIComponent(n); } catch { /* уже раскодировано */ }
  n = n.split(String.fromCharCode(92)).join('/').replace(/^file:\/+/i, '').replace(/[?#].*$/, '');
  n = n.replace(/^(\.\/|~\/|\/)+/, '');
  return n.toLowerCase();
}
export const baseName = (n: string) => n.slice(n.lastIndexOf('/') + 1);

/** Набор ресурсов с поиском по полному пути и, если не нашлось, по имени файла. */
export class NameIndex<T> {
  private full = new Map<string, T>();
  private base = new Map<string, T>();
  add(name: string, v: T) {
    const n = normName(name);
    if (!this.full.has(n)) this.full.set(n, v);
    const b = baseName(n);
    if (!this.base.has(b)) this.base.set(b, v);
  }
  get(name: string): T | undefined {
    const n = normName(name);
    return this.full.get(n) ?? this.base.get(baseName(n));
  }
  get size() { return this.full.size; }
}

/* ---------- ZIP (ресурсы DSL: «*.dsl.files.zip») ---------- */
interface ZipEntry { method: number; csize: number; usize: number; off: number }

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u64 = (d: DataView, p: number) => d.getUint32(p, true) + d.getUint32(p + 4, true) * 4294967296;

export class Zip {
  private index?: Promise<NameIndex<ZipEntry>>;
  constructor(private f: File) {}

  private load(): Promise<NameIndex<ZipEntry>> {
    return (this.index ??= (async () => {
      const f = this.f;
      const tailLen = Math.min(f.size, 65557);
      const tail = await slice(f, f.size - tailLen, f.size);
      const t = dv(tail);
      let e = tail.length - 22;
      while (e >= 0 && t.getUint32(e, true) !== 0x06054b50) e--;
      if (e < 0) throw new Error('не архив ZIP');
      let count = t.getUint16(e + 10, true), cdSize = t.getUint32(e + 12, true), cdOff = t.getUint32(e + 16, true);
      if (cdOff === 0xffffffff || count === 0xffff) { // ZIP64
        const loc = e - 20;
        if (loc >= 0 && t.getUint32(loc, true) === 0x07064b50) {
          const z = u64(t, loc + 8);
          const rec = dv(await slice(f, z, z + 56));
          count = u64(rec, 32); cdSize = u64(rec, 40); cdOff = u64(rec, 48);
        }
      }
      const cd = await slice(f, cdOff, cdOff + cdSize);
      const d = dv(cd);
      const utf8 = new TextDecoder('utf-8', { fatal: true });
      const cp = new TextDecoder('windows-1252');
      const idx = new NameIndex<ZipEntry>();
      for (let p = 0, i = 0; i < count && p + 46 <= cd.length; i++) {
        if (d.getUint32(p, true) !== 0x02014b50) break;
        const method = d.getUint16(p + 10, true);
        let csize = d.getUint32(p + 20, true), usize = d.getUint32(p + 24, true), off = d.getUint32(p + 42, true);
        const nl = d.getUint16(p + 28, true), el = d.getUint16(p + 30, true), cl = d.getUint16(p + 32, true);
        const nameBytes = cd.subarray(p + 46, p + 46 + nl);
        let name: string;
        try { name = utf8.decode(nameBytes); } catch { name = cp.decode(nameBytes); }
        for (let x = p + 46 + nl, end = x + el; x + 4 <= end; ) { // zip64-поля
          const id = d.getUint16(x, true), sz = d.getUint16(x + 2, true);
          if (id === 1) {
            let y = x + 4;
            if (usize === 0xffffffff) { usize = u64(d, y); y += 8; }
            if (csize === 0xffffffff) { csize = u64(d, y); y += 8; }
            if (off === 0xffffffff) off = u64(d, y);
          }
          x += 4 + sz;
        }
        if (!name.endsWith('/')) idx.add(name, { method, csize, usize, off });
        p += 46 + nl + el + cl;
      }
      return idx;
    })());
  }

  async read(name: string): Promise<Resource | null> {
    const ent = (await this.load()).get(name);
    if (!ent) return null;
    const lh = dv(await slice(this.f, ent.off, ent.off + 30));
    const start = ent.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const raw = await slice(this.f, start, start + ent.csize);
    const data = ent.method === 0 ? raw : ent.method === 8 ? await inflateRaw(raw) : null;
    return data ? { mime: mimeOf(name), data } : null;
  }
}
