import { openBytes, type Bytes } from './bytes';
import { Unsupported, type Format, type Reader } from './types';

interface SdCache {
  title: string;
  type: string; // sametypesequence ('' если у каждой части свой префикс)
  headwords: string[];
  offs: Float64Array;
  sizes: Uint32Array;
  canon: Uint32Array; // у синонима — номер главной статьи, у остальных — свой номер
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function readAll(b: Bytes): Promise<Uint8Array> {
  return b.read(0, b.size);
}

async function parse(main: File, aux: Record<string, File>): Promise<SdCache> {
  const ifo = await main.text();
  const get = (k: string) => new RegExp('^' + k + '=(.*)$', 'm').exec(ifo)?.[1].trim() ?? '';
  const idxFile = aux['idx'] ?? aux['idx.gz'] ?? aux['idx.dz'];
  if (!idxFile) throw new Unsupported('нет файла .idx рядом с .ifo');
  const wide = get('idxoffsetbits') === '64';
  const idx = await readAll(await openBytes(idxFile));
  const dv = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
  const td = new TextDecoder('utf-8');
  const headwords: string[] = [];
  const offs: number[] = [];
  const sizes: number[] = [];
  const canon: number[] = [];
  for (let p = 0; p < idx.length; ) {
    let e = p;
    while (e < idx.length && idx[e] !== 0) e++;
    headwords.push(td.decode(idx.subarray(p, e)));
    p = e + 1;
    if (wide) { offs.push(dv.getUint32(p) * 4294967296 + dv.getUint32(p + 4)); p += 8; }
    else { offs.push(dv.getUint32(p)); p += 4; }
    sizes.push(dv.getUint32(p));
    canon.push(headwords.length - 1);
    p += 4;
  }
  const n = headwords.length;
  const synFile = aux['syn'] ?? aux['syn.dz'] ?? aux['syn.gz'];
  if (synFile) { // синонимы: слово → номер статьи в .idx
    const syn = await readAll(await openBytes(synFile));
    const sv = new DataView(syn.buffer, syn.byteOffset, syn.byteLength);
    for (let p = 0; p < syn.length; ) {
      let e = p;
      while (e < syn.length && syn[e] !== 0) e++;
      const w = td.decode(syn.subarray(p, e));
      p = e + 1;
      const k = sv.getUint32(p);
      p += 4;
      if (k < n) { headwords.push(w); offs.push(offs[k]); sizes.push(sizes[k]); canon.push(k); }
    }
  }
  return { title: get('bookname'), type: get('sametypesequence'), headwords, offs: Float64Array.from(offs), sizes: Uint32Array.from(sizes), canon: Uint32Array.from(canon) };
}

/** Грубое превращение XDXF в HTML: смысл сохраняем, редкие теги просто убираем. */
function xdxf(x: string): string {
  return x
    .replace(/<k>[\s\S]*?<\/k>/g, '')
    .replace(/<ex>/g, '<span class="ex">').replace(/<\/ex>/g, '</span>')
    .replace(/<abr>/g, '<i class="p">').replace(/<\/abr>/g, '</i>')
    .replace(/<tr>/g, '<span class="tr">[').replace(/<\/tr>/g, ']</span>')
    .replace(/<dtrn>/g, '<span class="trn">').replace(/<\/dtrn>/g, '</span>')
    .replace(/<co>/g, '<span class="com">').replace(/<\/co>/g, '</span>')
    .replace(/<kref>/g, '<a class="ref">').replace(/<\/kref>/g, '</a>')
    .replace(/<c c="([^"]*)">/g, '<span style="color:$1">').replace(/<\/c>/g, '</span>')
    .replace(/<def[^>]*>/g, '<div class="m m1">').replace(/<\/def>/g, '</div>')
    .replace(/<\/?(ar|xdxf|sr|pos|gr|categ|mrkd|rref|iref|etm|nu|opt|su)[^>]*>/g, '')
    .replace(/\n/g, '<br>');
}

function part(type: string, data: Uint8Array, td: TextDecoder): string {
  const s = td.decode(data);
  switch (type) {
    case 'h': case 'g': return s;
    case 'x': return xdxf(s);
    case 'm': case 'l': case 't': case 'y': case 'w': case 'k': return esc(s).replace(/\n/g, '<br>');
    default: return ''; // r, W, P, X — ресурсы
  }
}

class SdReader implements Reader {
  private td = new TextDecoder('utf-8');
  title: string;
  constructor(private dict: Bytes, private c: SdCache, fallback: string) { this.title = c.title || fallback; }
  get headwords() { return this.c.headwords; }
  get canon() { return this.c.canon; }
  bodyId(i: number) { return this.c.offs[i]; }
  scan(on: boolean) { this.dict.readAhead?.(on); }

  async read(i: number): Promise<string> {
    const off = this.c.offs[i], len = this.c.sizes[i];
    const data = await this.dict.read(off, off + len);
    const seq = this.c.type;
    if (seq.length === 1) return part(seq, data, this.td);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out: string[] = [];
    let p = 0, k = 0;
    while (p < data.length) {
      let t: string;
      if (seq) { t = seq[k++]; if (!t) break; } else { t = String.fromCharCode(data[p++]); }
      const last = seq ? k === seq.length : false;
      let end: number;
      if (t >= 'A' && t <= 'Z') { // с длиной
        if (last) end = data.length; else { const l = dv.getUint32(p); p += 4; end = p + l; }
      } else if (last) end = data.length;
      else { end = p; while (end < data.length && data[end] !== 0) end++; }
      out.push(part(t.toLowerCase() === t ? t : t.toLowerCase(), data.subarray(p, end), this.td));
      p = end + (t >= 'A' && t <= 'Z' ? 0 : 1);
    }
    return out.join('<br>');
  }
}

export const stardict: Format = {
  id: 'stardict',
  async open(src, cached) {
    const dictFile = src.aux['dict'] ?? src.aux['dict.dz'];
    if (!dictFile) throw new Unsupported('нет файла .dict рядом с .ifo');
    const c = (cached as SdCache | undefined) ?? (await parse(src.main, src.aux));
    return { reader: new SdReader(await openBytes(dictFile), c, ''), cache: c };
  },
};
