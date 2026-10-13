import { buildSearchRegex, parseTerms, plainFast } from '../core/fold';
import { key } from '../core/normalize';
import type { ArticlePart, DictStatus, FtHit, FtSnippet, Hit, Req, Res, Source } from '../core/protocol';
import { FORMATS } from '../readers/registry';
import { NameIndex, mimeOf, type Resource } from '../readers/resources';
import type { Reader } from '../readers/types';

const post = (m: Res) => (self as unknown as { postMessage(m: Res): void }).postMessage(m);

/* ---------- кэш индексов (IndexedDB) ---------- */
const VERSION = 5; // менять при изменении формата кэша читалок
let dbp: Promise<IDBDatabase> | null = null; // одно соединение на всё время работы
function db(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((ok, no) => {
    const r = indexedDB.open('slovar-index', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('idx');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => { dbp = null; no(r.error); };
  }));
}
async function cacheClear(): Promise<void> {
  try { (await db()).close(); } catch { /* базы ещё не было */ }
  try { (await mdb()).close(); } catch { /* базы ещё не было */ }
  dbp = null;
  mdbp = null;
  for (const name of ['slovar-index', 'slovar-merged']) {
    await new Promise<void>((ok) => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = r.onerror = r.onblocked = () => ok();
    });
  }
}

/*
 * Заголовки словаря (миллионы строк) хранятся в кэше одной длинной строкой: IndexedDB копирует такую строку
 * почти мгновенно, а массив из миллионов отдельных строк — секунды.
 */
const SEP = '\u0001';
type CacheRec = { sig: string; v: number; cache: unknown };
type WithHw = { headwords?: string[]; headwordsJ?: string; hwn?: number };
function packCache(rec: CacheRec): CacheRec {
  const c = rec.cache as WithHw | null;
  if (c && Array.isArray(c.headwords) && c.headwords.length > 1000 && !c.headwords.some((h) => h.includes(SEP))) {
    const { headwords, ...rest } = c;
    return { ...rec, cache: { ...rest, headwordsJ: headwords.join(SEP), hwn: headwords.length } };
  }
  return rec;
}
function unpackCache(rec: CacheRec): { rec: CacheRec; packed: boolean } {
  const c = rec.cache as WithHw | null;
  if (c && typeof c.headwordsJ === 'string') {
    const { headwordsJ, hwn, ...rest } = c;
    const headwords = headwordsJ.split(SEP);
    if (headwords.length === hwn) return { rec: { ...rec, cache: { ...rest, headwords } }, packed: true };
    return { rec: { sig: '', v: -1, cache: undefined }, packed: true }; // повреждённая запись: пересоберём
  }
  return { rec, packed: false };
}

async function cacheGet(id: string): Promise<{ rec: CacheRec; packed: boolean } | undefined> {
  try {
    const d = await db();
    const rec: CacheRec | undefined = await new Promise((ok) => {
      const r = d.transaction('idx').objectStore('idx').get(id);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ok(undefined);
    });
    return rec ? unpackCache(rec) : undefined;
  } catch {
    return undefined;
  }
}
async function cachePut(id: string, val: CacheRec): Promise<void> {
  try {
    const d = await db();
    const rec = packCache(val);
    await new Promise<void>((ok) => {
      const tx = d.transaction('idx', 'readwrite');
      tx.objectStore('idx').put(rec, id);
      tx.oncomplete = () => ok();
      tx.onerror = () => ok();
      tx.onabort = () => ok();
    });
  } catch {
    /* кэш необязателен */
  }
}

/* ---------- кэш готового общего индекса ---------- */
const MERGED_VERSION = 1; // менять при изменении нормализации ключей (core/normalize.ts) или формата этого кэша
interface Merged { k: string; o: Uint32Array; d: Uint16Array; e: Uint32Array; c: Uint32Array }
let mdbp: Promise<IDBDatabase> | null = null;
function mdb(): Promise<IDBDatabase> {
  return (mdbp ??= new Promise((ok, no) => {
    const r = indexedDB.open('slovar-merged', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('m');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => { mdbp = null; no(r.error); };
  }));
}
const idbGet = <T>(d: IDBDatabase, key: string) =>
  new Promise<T | undefined>((ok) => {
    const r = d.transaction('m').objectStore('m').get(key);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ok(undefined);
  });
async function mergedGet(sig: string): Promise<Merged | null> {
  try {
    const d = await mdb();
    if ((await idbGet<string>(d, 'sig')) !== sig) return null; // словари изменились: индекс устарел
    return (await idbGet<Merged>(d, 'data')) ?? null;
  } catch {
    return null;
  }
}
async function mergedPut(sig: string, data: Merged): Promise<void> {
  try {
    const d = await mdb();
    await new Promise<void>((ok) => {
      const tx = d.transaction('m', 'readwrite');
      tx.objectStore('m').put(data, 'data');
      tx.objectStore('m').put(sig, 'sig'); // в одной транзакции: либо оба, либо ничего
      tx.oncomplete = () => ok();
      tx.onerror = () => ok();
      tx.onabort = () => ok();
    });
  } catch {
    /* кэш необязателен */
  }
}
/** Подпись набора словарей: меняется, если изменился любой файл, число заголовков или состав. */
function mergedSig(): string {
  return MERGED_VERSION + '|' + VERSION + '|' + dicts.map((d) => `${d.src.id}:${d.src.main.size}:${d.src.main.lastModified}:${d.reader ? d.reader.headwords.length : 'x'}`).join('|');
}

/* ---------- состояние ---------- */
interface Loaded {
  src: Source;
  reader: Reader | null;
}
let dicts: Loaded[] = [];
let K: string[] = []; // ключ каждой записи
let D: Uint16Array = new Uint16Array(0); // словарь записи
let E: Uint32Array = new Uint32Array(0); // номер записи в словаре
let order: Uint32Array = new Uint32Array(0); // записи по возрастанию ключа
let C: Uint32Array = new Uint32Array(0); // у формы слова (синоним StarDict) — запись главного заголовка, у остальных — своя

let loadSeq = 0;
async function load(id: number, sources: Source[]) {
  const t0 = performance.now();
  const mine = ++loadSeq;
  dicts = sources.map((src) => ({ src, reader: null }));
  looseIdx.clear();
  articleOrders.clear();
  const st = (idx: number, status: DictStatus) => post({ t: 'dict', idx, status });
  sources.forEach((_, i) => st(i, { s: 'queued' }));

  const repack: { id: string; rec: CacheRec }[] = []; // кэши старого формата (массив строк): перепишем быстрым форматом после загрузки
  const openOne = async (i: number) => {
    const src = sources[i];
    const fmt = FORMATS[src.format];
    if (!fmt) {
      st(i, { s: 'skipped', reason: src.format === 'bgl' ? 'BGL пока не читается — переведите в DSL' : 'формат ' + src.format.toUpperCase() + ' не поддерживается' });
      return;
    }
    const t1 = performance.now();
    try {
      const sig = src.main.size + ':' + src.main.lastModified;
      const hit = await cacheGet(src.id);
      const ok = hit && hit.rec.sig === sig && hit.rec.v === VERSION;
      const cached = ok ? hit.rec.cache : undefined;
      st(i, { s: 'indexing', done: 0, total: 1 });
      let last = 0;
      const { reader, cache } = await fmt.open(src, cached, (d, t) => {
        const now = performance.now();
        if (now - last > 120) {
          last = now;
          st(i, { s: 'indexing', done: d, total: t });
        }
      });
      if (!cached) await cachePut(src.id, { sig, v: VERSION, cache });
      else if (!hit!.packed && reader.headwords.length > 1000) repack.push({ id: src.id, rec: { sig, v: VERSION, cache } });
      dicts[i].reader = reader;
      st(i, {
        s: 'ready',
        count: reader.headwords.length,
        fromCache: !!cached,
        ms: Math.round(performance.now() - t1),
        title: reader.title,
        lang: reader.lang,
      });
    } catch (e) {
      st(i, { s: 'error', reason: e instanceof Error ? e.message : String(e) });
    }
  };
  // несколько словарей открываются одновременно: чтение кэшей и файлов перекрываются
  let nextDict = 0;
  await Promise.all(Array.from({ length: 3 }, async () => { while (nextDict < sources.length) await openOne(nextDict++); }));
  const tReaders = performance.now() - t0;

  // готовый общий индекс: если словари не менялись, нормализация и сортировка миллионов ключей не нужны
  const sig = mergedSig();
  const tm = performance.now();
  const m = await mergedGet(sig);
  let phases: { keys: number; sort: number; merged?: number };
  let fresh = false;
  if (m && m.o.length === m.d.length && m.e.length === m.d.length && m.c.length === m.d.length) {
    K = m.k.split(SEP);
    if (K.length === m.d.length) {
      D = m.d; E = m.e; C = m.c; order = m.o;
      phases = { keys: 0, sort: 0, merged: Math.round(performance.now() - tm) };
    } else { phases = buildIndex(); fresh = true; }
  } else { phases = buildIndex(); fresh = true; }
  post({ t: 'loaded', id, total: K.length, ms: Math.round(performance.now() - t0), phases: { readers: Math.round(tReaders), ...phases } });

  // сохраняем то, что пересчитано, уже после показа результата (один раз)
  setTimeout(async () => {
    if (mine !== loadSeq) return; // тем временем началась новая загрузка
    if (fresh && !K.some((k) => k.includes(SEP))) await mergedPut(sig, { k: K.join(SEP), o: order, d: D, e: E, c: C });
    for (const r of repack) await cachePut(r.id, r.rec);
  }, 50);
}

function buildIndex(): { keys: number; sort: number } {
  const t0 = performance.now();
  const total = dicts.reduce((s, d) => s + (d.reader?.headwords.length ?? 0), 0);
  K = new Array<string>(total);
  D = new Uint16Array(total);
  E = new Uint32Array(total);
  C = new Uint32Array(total);
  let n = 0;
  dicts.forEach((d, di) => {
    const hw = d.reader?.headwords;
    if (!hw) return;
    const canon = d.reader!.canon, base = n;
    for (let i = 0; i < hw.length; i++, n++) {
      K[n] = key(hw[i]);
      D[n] = di;
      E[n] = i;
      C[n] = canon ? base + canon[i] : n;
    }
  });
  const t1 = performance.now();
  order = new Uint32Array(total);
  for (let i = 0; i < total; i++) order[i] = i;
  order.sort((a, b) => (K[a] < K[b] ? -1 : K[a] > K[b] ? 1 : a - b));
  return { keys: Math.round(t1 - t0), sort: Math.round(performance.now() - t1) };
}

/* ---------- поиск ---------- */
function lowerBound(k: string): number {
  let lo = 0,
    hi = order.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (K[order[m]] < k) lo = m + 1;
    else hi = m;
  }
  return lo;
}

const rowA = new Int32Array(80),
  rowB = new Int32Array(80);
/** Расстояние Левенштейна с отсечкой; результат > max значит «слишком далеко». */
function lev(a: string, b: string, max: number): number {
  const la = a.length,
    lb = b.length;
  if (Math.abs(la - lb) > max || lb > 78) return max + 1;
  let prev = rowA,
    cur = rowB;
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let best = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1));
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[lb];
}

function headword(o: number): string {
  return dicts[D[o]].reader!.headwords[E[o]];
}

/** Записи с общим префиксом ключа; одинаковые заголовки (без учёта регистра) склеиваются. */
function collect(prefix: string, enabled: boolean[], limit: number): Hit[] {
  const byH = new Map<string, Hit>();
  let seen = 0;
  for (let p = lowerBound(prefix); p < order.length && seen < 1500; p++) {
    const o = order[p];
    if (!K[o].startsWith(prefix)) break;
    if (!enabled[D[o]]) continue;
    const c = C[o];
    // форма слова (êtes → être) в списках не показывается, но при точном вводе ведёт на главное слово
    if (c !== o && (K[o] !== prefix || K[c] === K[o])) continue;
    seen++;
    const h = headword(c),
      lk = h.toLowerCase(),
      form = c !== o ? headword(o) : undefined;
    const hit = byH.get(lk);
    if (hit) {
      if (!hit.dicts.includes(D[o])) hit.dicts.push(D[o]);
      if (form && !hit.form && hit.k !== prefix) { hit.form = form; hit.mk = K[o]; }
    } else if (byH.size < limit) byH.set(lk, { h, k: K[c], dicts: [D[o]], form, mk: K[o] });
  }
  return [...byH.values()];
}

/** Все заголовки с ровно этим ключом. */
function hitsForKey(kk: string, enabled: boolean[]): Hit[] {
  const byH = new Map<string, Hit>();
  for (let p = lowerBound(kk); p < order.length && K[order[p]] === kk; p++) {
    const o = order[p];
    if (!enabled[D[o]]) continue;
    const c = C[o];
    if (c !== o && K[c] === kk) continue; // «форма» того же слова — лишнее повторение
    const h = headword(c),
      lk = h.toLowerCase(),
      form = c !== o ? headword(o) : undefined;
    const hit = byH.get(lk);
    if (hit) {
      if (!hit.dicts.includes(D[o])) hit.dicts.push(D[o]);
    } else byH.set(lk, { h, k: K[c], dicts: [D[o]], form, mk: kk });
  }
  return [...byH.values()];
}

/** У найденных по форме слова (être ← êtes) в точках показываем все словари, где есть главное слово. */
function withAllDicts(items: Hit[], enabled: boolean[]): Hit[] {
  for (const it of items) {
    if (!it.form) continue;
    const real = hitsForKey(it.k, enabled).find((x) => x.h.toLowerCase() === it.h.toLowerCase());
    if (real) for (const d of real.dicts) if (!it.dicts.includes(d)) it.dicts.push(d);
  }
  return items;
}

const rich = (h: string) => /[^\x00-\x7f]/.test(h);
const shout = (h: string) => h === h.toUpperCase() && h !== h.toLowerCase();
/**
 * Варианты, набранные ЗАГЛАВНЫМИ («EPANOUIR», «CONTREPIED»), — то же слово, что «épanouir», «contre-pied»:
 * склеиваем их с обычным вариантом. Обычные слова с одним ключом (affaire/affairé, côte/côté) остаются разными.
 */
function mergeVariants(hits: Hit[]): Hit[] {
  const groups = new Map<string, Hit[]>();
  for (const h of hits) {
    const g = groups.get(h.k);
    if (g) g.push(h); else groups.set(h.k, [h]);
  }
  const out: Hit[] = [];
  for (const g of groups.values()) {
    const base = g.filter((h) => !shout(h.h));
    if (!base.length || base.length === g.length) { out.push(...g); continue; }
    const target = base.find((h) => rich(h.h)) ?? base[0];
    for (const h of g) if (shout(h.h)) for (const d of h.dicts) if (!target.dicts.includes(d)) target.dicts.push(d);
    out.push(...base);
  }
  return out;
}

/** Чем в большем числе словарей есть слово, тем оно вероятнее; необходимое добавление букв и опечатки штрафуются. */
function score(base: number, pop: number): number {
  return base - 0.3 * Math.min(pop, 5);
}

/** MDX хранит формы слов как записи «@@@LINK=главное слово»: при точном вводе разворачиваем их, как синонимы StarDict. */
async function addRedirects(items: Hit[], used: string, enabled: boolean[]) {
  let reads = 0;
  for (let p = lowerBound(used); p < order.length && K[order[p]] === used && reads < 24; p++) {
    const o = order[p], di = D[o];
    if (!enabled[di] || dicts[di].src.format !== 'mdx') continue;
    reads++;
    let html: string;
    try { html = await dicts[di].reader!.read(E[o]); } catch { continue; }
    const m = /^@@@LINK=(.+)/.exec(html.trim());
    if (!m) continue;
    const target = m[1].trim(), tk = key(target);
    if (!tk || tk === used) continue;
    const lk = target.toLowerCase();
    const hit = items.find((x) => x.h.toLowerCase() === lk);
    if (hit) { if (!hit.dicts.includes(di)) hit.dicts.push(di); if (!hit.form && hit.k !== used) { hit.form = headword(o); hit.mk = used; } }
    else items.push({ h: target, k: tk, dicts: [di], form: headword(o), mk: used });
  }
}

async function search(q: string, enabled: boolean[]): Promise<{ items: Hit[]; fuzzy: boolean }> {
  const k = key(q);
  if (!k) return { items: [], fuzzy: false };
  // l'opportunité → opportunité: сразу, если апостроф был; без апострофа («lopportunite») — только если иначе ничего не нашлось
  const ap = /^\s*(qu|[ldsjmtnc])['’‘`]/i.exec(q);
  const elided = ap ? k.slice(ap[1].length) : k.replace(/^(l|d|s|j|m|t|n|c|qu)(?=[a-z]{3})/, '');
  let items = mergeVariants(collect(k, enabled, 200));
  let used = k;
  if (!items.length && ap && elided !== k) {
    items = mergeVariants(collect(elided, enabled, 200));
    used = elided;
  }
  const viaForm = (i: Hit, u: string) => i.form !== undefined && i.mk === u;
  await addRedirects(items, used, enabled);
  withAllDicts(items, enabled);
  const exact = items.some((i) => i.k === used || viaForm(i, used));
  const prefOf = (i: Hit, u: string) =>
    i.k === u ? -10 : viaForm(i, u) ? -9 - 0.05 * Math.min(i.dicts.length, 8) : score(0.2 + 0.1 * Math.min(i.k.length - u.length, 6), i.dicts.length);
  const pref = (i: Hit) => prefOf(i, used);
  if (exact || k.length < 4) {
    items.sort((a, b) => pref(a) - pref(b));
    return { items: items.slice(0, 8), fuzzy: false };
  }

  // опечатки: все ключи на ту же первую букву (в отсортированном порядке они идут подряд)
  const max = k.length > 7 ? 2 : 1;
  const near: { kk: string; d: number; cp: number }[] = [];
  let prev = '';
  for (let p = lowerBound(k[0]); p < order.length; p++) {
    const o = order[p],
      kk = K[o];
    if (kk[0] !== k[0]) break;
    if (kk === prev || !enabled[D[o]]) continue;
    const d = lev(k, kk, max);
    if (d <= max) {
      let cp = 0;
      while (cp < k.length && k[cp] === kk[cp]) cp++;
      near.push({ kk, d, cp });
      prev = kk;
    }
  }
  near.sort((a, b) => a.d - b.d || b.cp - a.cp);
  const have = new Set(items.map((i) => i.k));
  const fuzzyHits: { hit: Hit; sc: number }[] = [];
  const raw: Hit[] = [];
  for (const n of near.slice(0, 80)) if (!have.has(n.kk)) raw.push(...hitsForKey(n.kk, enabled));
  const nearOf = new Map(near.map((n) => [n.kk, n]));
  for (const hit of mergeVariants(raw)) {
    const n = nearOf.get(hit.mk ?? hit.k)!;
    // общее начало с запросом — признак того, что слово то самое (опечатка чаще в конце)
    fuzzyHits.push({ hit, sc: score(n.d, hit.dicts.length) - 0.08 * n.cp + 0.02 * Math.abs(hit.k.length - k.length) });
  }

  if (!items.length && !fuzzyHits.length && !ap && elided !== k) {
    const e = mergeVariants(collect(elided, enabled, 200));
    if (e.length) return { items: e.sort((a, b) => prefOf(a, elided) - prefOf(b, elided)).slice(0, 8), fuzzy: false };
  }
  const ranked = [
    ...items.map((hit) => ({ hit, sc: pref(hit) })),
    ...fuzzyHits,
  ].sort((a, b) => a.sc - b.sc).slice(0, 8);
  const seen = new Set<string>();
  const out = ranked.filter((r) => !seen.has(r.hit.h.toLowerCase()) && !!seen.add(r.hit.h.toLowerCase())).map((r) => r.hit);
  return { items: withAllDicts(out, enabled), fuzzy: out.some((i) => !i.k.startsWith(used) && !viaForm(i, used)) };
}

/* ---------- статья ---------- */
async function readEntry(di: number, ei: number, depth = 0): Promise<string> {
  const html = await dicts[di].reader!.read(ei);
  const m = /^@@@LINK=(.+)/.exec(html.trim());
  if (m && depth < 5) {
    const name = m[1].trim(),
      target = key(name);
    let any = -1;
    for (let p = lowerBound(target); p < order.length && K[order[p]] === target; p++) {
      const o = order[p];
      if (D[o] !== di) continue;
      if (headword(o) === name) return readEntry(di, E[o], depth + 1);
      if (any < 0) any = E[o];
    }
    if (any >= 0) return readEntry(di, any, depth + 1);
  }
  return html;
}

async function article(h: string, enabled: boolean[]): Promise<ArticlePart[]> {
  const k = key(h),
    want = h.toLowerCase();
  const perDict = new Map<number, number[]>();
  for (let p = lowerBound(k); p < order.length && K[order[p]] === k; p++) {
    const o = order[p];
    if (!enabled[D[o]]) continue;
    const l = perDict.get(D[o]) ?? [];
    l.push(o);
    perDict.set(D[o], l);
  }
  return Promise.all(
    [...perDict.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(async ([di, os]): Promise<ArticlePart> => {
        try {
          return await readPart(di, os, want);
        } catch (e) { // один неисправный словарь (файл удалён или изменился) не должен ронять остальные карточки
          const msg = (e instanceof Error ? e.message : String(e)).replace(/[<>&]/g, '');
          return { dict: di, entries: [{ h, html: '<p><i>Не удалось прочитать статью из этого словаря: ' + msg + '. Возможно, файл изменился или был перемещён: подключите папку заново.</i></p>' }] };
        }
      }),
  );
}

async function readPart(di: number, os: number[], want: string): Promise<ArticlePart> {
  const exact = os.filter((o) => headword(o).toLowerCase() === want);
  const use = (exact.length ? exact : os).slice(0, 8);
  const all = await Promise.all(use.map(async (o) => ({ h: headword(o), html: await readEntry(di, E[o]) })));
  // несколько заголовков/синонимов могут вести на одну и ту же статью
  const seen = new Set<string>();
  const entries = all.filter((e) => !seen.has(e.html) && !!seen.add(e.html));
  return { dict: di, entries };
}

/* ---------- ресурсы статей ---------- */
const looseIdx = new Map<number, NameIndex<File>>();
/** Ресурс словаря: сначала внутри его контейнера (MDD, ZIP, Slob), затем файлы рядом с ним. */
async function resource(di: number, name: string): Promise<Resource | null> {
  const d = dicts[di];
  if (!d?.reader) return null;
  const inside = await d.reader.resource?.(name);
  if (inside) return inside;
  let idx = looseIdx.get(di);
  if (!idx) {
    idx = new NameIndex<File>();
    for (const [path, f] of Object.entries(d.src.res)) idx.add(path, f);
    looseIdx.set(di, idx);
  }
  const f = idx.get(name);
  return f ? { mime: mimeOf(f.name), data: new Uint8Array(await f.arrayBuffer()) } : null;
}
/* ---------- поиск по тексту статей ---------- */
const cancelled = new Set<number>();
const articleOrders = new Map<number, Uint32Array>();

/** По одной записи на статью, в порядке расположения в файле (так читать быстрее всего). */
function articleOrder(di: number): Uint32Array {
  let a = articleOrders.get(di);
  if (a) return a;
  const r = dicts[di].reader!;
  const n = r.headwords.length;
  if (!r.bodyId) a = Uint32Array.from({ length: n }, (_, i) => i);
  else {
    const first = new Map<number, number>();
    for (let i = 0; i < n; i++) { const b = r.bodyId(i); if (!first.has(b)) first.set(b, i); }
    a = Uint32Array.from([...first.entries()].sort((x, y) => x[0] - y[0]).map((e) => e[1]));
  }
  articleOrders.set(di, a);
  return a;
}

const squeeze = (s: string) => s.replace(/\s+/g, ' ');
/** До двух фрагментов вокруг первой части запроса; в каждом подсвечены все части. */
function snippets(text: string, res: RegExp[]): FtSnippet[] {
  const any = new RegExp(res.map((r) => `(?:${r.source})`).join('|'), 'giu');
  const g = new RegExp(res[0].source, 'giu');
  const out: FtSnippet[] = [];
  for (let m = g.exec(text); m && out.length < 2; m = g.exec(text)) {
    const a = Math.max(0, m.index - 70), b = Math.min(text.length, m.index + m[0].length + 90);
    const win = text.slice(a, b);
    const segs: [string, 0 | 1][] = [];
    let at = 0;
    any.lastIndex = 0;
    for (let x = any.exec(win); x; x = any.exec(win)) {
      if (!x[0]) { any.lastIndex++; continue; }
      if (x.index > at) segs.push([squeeze(win.slice(at, x.index)), 0]);
      segs.push([squeeze(x[0]), 1]);
      at = x.index + x[0].length;
    }
    if (at < win.length) segs.push([squeeze(win.slice(at)), 0]);
    out.push({ segs, l: a > 0, r: b < text.length });
    g.lastIndex = m.index + m[0].length + 40;
  }
  return out.length ? out : [{ segs: [[squeeze(text.slice(0, 160)), 0]], l: false, r: text.length > 160 }];
}

const HIT_CAP = 300;
async function ftsearch(id: number, q: string, all: boolean, enabled: boolean[], order_: number[]) {
  // части запроса; сначала самые длинные: они реже встречаются, и проверка отсекает статью раньше
  const res = parseTerms(q, all).map((t) => buildSearchRegex(t)).filter((r): r is RegExp => !!r).sort((x, y) => y.source.length - x.source.length);
  const re = res.length ? res : null;
  const list = order_.filter((di) => enabled[di] && dicts[di]?.reader);
  let scanned = 0, found = 0;
  const send = (m: Omit<Extract<Res, { t: 'ft' }>, 't' | 'id' | 'dictCount'>) => post({ t: 'ft', id, dictCount: list.length, ...m });
  if (!re) { send({ hits: [], dict: -1, dictNo: 0, done: 0, total: 0, scanned: 0, finished: true }); return; }
  let batch: FtHit[] = [];
  let last = performance.now();
  try {
    for (let d = 0; d < list.length; d++) {
      const di = list[d], r = dicts[di].reader!;
      const ids = articleOrder(di);
      r.scan?.(true); // читать файл крупными кусками
      try {
        for (let k = 0; k < ids.length; k++) {
          if (cancelled.delete(id)) { send({ hits: batch, dict: di, dictNo: d, done: k, total: ids.length, scanned, finished: true, stopped: true }); return; }
          const i = ids[k];
          let text: string;
          try { text = r.text ? await r.text(i) : plainFast(await r.read(i)); } catch { continue; }
          scanned++;
          if (re.every((x) => x.test(text))) {
            batch.push({ dict: di, i, h: r.headwords[i], sn: snippets(text, re) });
            if (++found >= HIT_CAP) { send({ hits: batch, dict: di, dictNo: d, done: k, total: ids.length, scanned, finished: true, capped: true }); return; }
          }
          const now = performance.now();
          if (now - last > 180) { // отдать накопленное и дать воркеру принять «остановить»
            last = now;
            send({ hits: batch, dict: di, dictNo: d, done: k + 1, total: ids.length, scanned });
            batch = [];
            await new Promise((ok) => setTimeout(ok));
          }
        }
      } finally { r.scan?.(false); }
    }
    send({ hits: batch, dict: -1, dictNo: list.length, done: 0, total: 0, scanned, finished: true });
  } catch (e) {
    send({ hits: batch, dict: -1, dictNo: 0, done: 0, total: 0, scanned, finished: true, stopped: true });
  }
}

function stats() {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return { heapMB: mem ? Math.round(mem.usedJSHeapSize / 1e6) : -1, entries: K.length, dicts: dicts.filter((d) => d.reader).length };
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const m = ev.data;
  try {
    if (m.t === 'load') await load(m.id, m.sources);
    else if (m.t === 'search') post({ t: 'search', id: m.id, ...(await search(m.q, m.enabled)) });
    else if (m.t === 'article') post({ t: 'article', id: m.id, parts: await article(m.h, m.enabled) });
    else if (m.t === 'stats') post({ t: 'stats', id: m.id, ...stats() });
    else if (m.t === 'ftsearch') await ftsearch(m.id, m.q, m.all, m.enabled, m.order);
    else if (m.t === 'ftcancel') cancelled.add(m.id);
    else if (m.t === 'clear') { await cacheClear(); post({ t: 'cleared', id: m.id }); }
    else if (m.t === 'resource') {
      const r = await resource(m.dict, m.name);
      const data = r ? (r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) as ArrayBuffer) : null;
      (self as unknown as { postMessage(m: Res, t: Transferable[]): void }).postMessage({ t: 'resource', id: m.id, mime: r?.mime ?? '', data }, data ? [data] : []);
    }
  } catch (e) {
    post({ t: 'fail', id: m.id, message: e instanceof Error ? e.message : String(e) });
  }
};