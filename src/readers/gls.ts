import { concat, eachChunk } from './bytes';
import { Unsupported, type Format, type Reader } from './types';

/** Babylon Glossary Source: «### …» шапка, затем статьи через пустую строку: строка заголовков (через |), строки тела. */
interface GlsCache {
  title: string;
  headwords: string[];
  starts: Float64Array;
  ends: Float64Array;
}

async function parse(f: File, onProgress: (d: number, t: number) => void): Promise<GlsCache> {
  const dec = new TextDecoder('utf-8');
  const headwords: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let title = '';
  let inSection = false;
  let heads: string[] = [];
  let bodyStart = -1, bodyEnd = -1;
  const flush = () => {
    if (bodyStart >= 0) for (const h of heads) { headwords.push(h); starts.push(bodyStart); ends.push(bodyEnd); }
    heads = [];
    bodyStart = bodyEnd = -1;
  };

  let carry: Uint8Array = new Uint8Array(0);
  let carryAbs = 0;
  let first = true;
  let last = 0;

  const scan = (buf: Uint8Array, base: number, final: boolean): number => {
    let p = 0;
    for (;;) {
      let nl = buf.indexOf(10, p), next: number;
      if (nl < 0) {
        if (!final || p >= buf.length) return p;
        nl = next = buf.length;
      } else next = nl + 1;
      const le = nl > p && buf[nl - 1] === 13 ? nl - 1 : nl;
      if (!inSection) {
        const line = dec.decode(buf.subarray(p, le));
        const m = /^###\s*Glossary title:\s*(.*)$/i.exec(line);
        if (m) title = m[1].trim();
        if (/^###\s*Glossary section:/i.test(line)) inSection = true;
      } else if (le === p) flush(); // пустая строка — конец статьи
      else if (!heads.length) {
        for (const h of dec.decode(buf.subarray(p, le)).split('|')) {
          const t = h.replace(/\{[^}]*\}/g, '').replace(/\\(.)/g, '$1').trim();
          if (t) heads.push(t);
        }
      } else {
        if (bodyStart < 0) bodyStart = base + p;
        bodyEnd = base + next;
      }
      p = next;
      if (p >= buf.length) return p;
    }
  };

  await eachChunk(f.stream() as ReadableStream<Uint8Array>, (chunk) => {
    let buf = carry.length ? concat([carry, chunk]) : chunk;
    let base = carryAbs;
    if (first) {
      if (buf.length < 3) { carry = buf; return; }
      first = false;
      if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) throw new Unsupported('GLS в UTF-16');
      if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) { buf = buf.subarray(3); base += 3; }
    }
    const used = scan(buf, base, false);
    carry = buf.slice(used);
    carryAbs = base + used;
    const now = performance.now();
    if (now - last > 150) { last = now; onProgress(carryAbs, f.size); }
  });
  if (carry.length) scan(carry, carryAbs, true);
  flush();
  return { title, headwords, starts: Float64Array.from(starts), ends: Float64Array.from(ends) };
}

class GlsReader implements Reader {
  private dec = new TextDecoder('utf-8');
  title: string;
  constructor(private f: File, private c: GlsCache) { this.title = c.title; }
  get headwords() { return this.c.headwords; }
  bodyId(i: number) { return this.c.starts[i]; }
  private ahead = false;
  private win?: { start: number; data: Uint8Array };
  scan(on: boolean) { this.ahead = on; if (!on) this.win = undefined; }
  private async bytes(a: number, b: number): Promise<Uint8Array> {
    if (!this.ahead) return new Uint8Array(await this.f.slice(a, b).arrayBuffer());
    const w = this.win;
    if (w && a >= w.start && b <= w.start + w.data.length) return w.data.subarray(a - w.start, b - w.start);
    const data = new Uint8Array(await this.f.slice(a, Math.min(this.f.size, a + Math.max(b - a, 8 << 20))).arrayBuffer());
    this.win = { start: a, data };
    return data.subarray(0, b - a);
  }
  async text(i: number): Promise<string> {
    return this.dec.decode(await this.bytes(this.c.starts[i], this.c.ends[i]));
  }
  async read(i: number): Promise<string> {
    const raw = await this.bytes(this.c.starts[i], this.c.ends[i]);
    return this.dec.decode(raw).trim().replace(/\r?\n/g, '<br>');
  }
}

export const gls: Format = {
  id: 'gls',
  async open(src, cached, onProgress) {
    const c = (cached as GlsCache | undefined) ?? (await parse(src.main, onProgress));
    return { reader: new GlsReader(src.main, c), cache: c };
  },
};
