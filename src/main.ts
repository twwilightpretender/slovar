import './style.css';
import { key } from './core/normalize';
import type { ArticlePart, DictStatus, FtHit, Hit, Req, Res, Source } from './core/protocol';
import {
  askAccess, canPick, fromDrop, fromFileList, groupSources, hasAccess, loadHandle, pickFolder, saveHandle, walkHandle,
  type Entry,
} from './storage/folder';
import {
  clearCloud, cloudEntries, cloudSupported, googleKey, hasBuiltinGoogleKey, isGoogle, listCloud, normalizeLink, planSync, setGoogleKey, syncCloud,
  type CloudItem,
} from './storage/cloud';
import { assign, guessLang, loadLayout, move, newGroupId, saveLayout } from './ui/layout';
import ART_CSS from './ui/article.css?inline';
import { buildSearchRegex, parseTerms } from './core/fold';
import { adaptColors, esc, prepare } from './ui/render';
import { Resources } from './ui/resources';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const store = {
  get: (k: string, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ok */ } },
};

/* ---------- worker ---------- */
const worker = new Worker(new URL('./worker/engine.worker.ts', import.meta.url), { type: 'module' });
let seq = 0;
const waiting = new Map<number, (r: Res) => void>();
let onDict: (idx: number, s: DictStatus) => void = () => {};
worker.onmessage = (ev: MessageEvent<Res>) => {
  const m = ev.data;
  if (m.t === 'dict') onDict(m.idx, m.status);
  else if (m.t === 'ft') streams.get(m.id)?.(m);
  else {
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  }
};
type NoId<T> = T extends unknown ? Omit<T, 'id'> : never;
function call<T extends Res>(m: NoId<Req>): Promise<T> {
  const id = ++seq;
  return new Promise((ok, no) => {
    waiting.set(id, (r) => (r.t === 'fail' ? no(new Error(r.message)) : ok(r as T)));
    worker.postMessage({ ...m, id });
  });
}

const streams = new Map<number, (m: Extract<Res, { t: 'ft' }>) => void>(); // потоковые ответы текстового поиска
const res = new Resources((dict, name) => call<Extract<Res, { t: 'resource' }>>({ t: 'resource', dict, name }));
let audio: HTMLAudioElement | null = null;
async function playSound(dict: number, name: string) {
  const u = await res.url(dict, name);
  if (!u) return;
  audio?.pause();
  audio = new Audio(u);
  audio.play().catch(() => {});
}

/* ---------- состояние ---------- */
let sources: Source[] = [];
let status: DictStatus[] = [];
let enabled: boolean[] = [];
let ready = false;
let folderName = '';
const off = new Set<string>(JSON.parse(store.get('off', '[]')));
const lay = loadLayout();

const COLORS = ['--d1', '--d2', '--d3', '--d4', '--d5', '--d6', '--d7', '--d8'];
const color = (i: number) => `var(${COLORS[i % COLORS.length]})`;
const FMT: Record<string, string> = { mdx: 'MDict', dsl: 'DSL', stardict: 'StarDict', slob: 'Slob', bgl: 'BGL', gls: 'GLS' };

function dictName(i: number): string {
  const s = status[i];
  const base = sources[i].main.name.replace(/\.(mdx|dsl(\.dz)?|ifo|slob|bgl|gls)$/i, '');
  const raw = s?.s === 'ready' ? s.title : '';
  const t = raw ? (new DOMParser().parseFromString(raw, 'text/html').documentElement.textContent ?? '').trim() : '';
  return t && !/^title\b/i.test(t) && t.length < 60 ? t : base;
}

/* частота использования словарей: открытие карточки, переход из списка, щелчок внутри статьи */
const usage: Record<string, number> = (() => { try { return JSON.parse(store.get('usage', '{}')); } catch { return {}; } })();
let rankOn = store.get('rank') === '1';
const usedInView = new Set<number>(); // в одной показанной статье словарь засчитывается один раз
function useDict(i: number, once = false) {
  if (once) { if (usedInView.has(i)) return; usedInView.add(i); }
  const id = sources[i]?.id;
  if (!id) return;
  usage[id] = (usage[id] ?? 0) + 1;
  store.set('usage', JSON.stringify(usage));
}

/** Словари, участвующие в поиске: отмечены галочкой и входят в выбранную группу. */
const mask = () => enabled.map((on, i) => on && (!lay.scope || lay.of[sources[i].id] === lay.scope));
/** Порядок показа словарей: по группам, внутри группы — как расставил пользователь. */
function displayOrder(): number[] {
  const idx = new Map(sources.map((s, i) => [s.id, i]));
  const out: number[] = [];
  for (const g of lay.groups) {
    const ids = lay.order.filter((id) => lay.of[id] === g.id && idx.has(id));
    if (rankOn) ids.sort((a, b) => (usage[b] ?? 0) - (usage[a] ?? 0)); // сортировка устойчива: при равенстве остаётся ручной порядок
    for (const id of ids) out.push(idx.get(id)!);
  }
  for (let i = 0; i < sources.length; i++) if (!out.includes(i)) out.push(i);
  return out;
}

/* ---------- загрузка словарей ---------- */
async function ingest(entries: Entry[], label: string) {
  lastEntries = entries;
  lastLabel = label;
  folderName = label;
  sources = groupSources(entries);
  status = sources.map(() => ({ s: 'queued' }) as DictStatus);
  enabled = sources.map((s) => !off.has(s.id));
  ready = false;
  q.disabled = true;
  q.placeholder = 'Идёт загрузка словарей…';
  out.innerHTML = '';
  renderDicts();
  if (!sources.length) {
    out.innerHTML = '<div class="empty">В этой папке не нашлось словарей (нужны файлы .mdx, .dsl, .ifo, .slob, .bgl, .gls).</div>';
    welcome();
    return;
  }
  onDict = (i, s) => { status[i] = s; renderDicts(); };
  const r = await call<Extract<Res, { t: 'loaded' }>>({ t: 'load', sources });
  ready = true;
  lastPhases = (walkMs ? `обход папки ${fmtMs(walkMs)}, ` : '') + `открытие словарей/кэшей ${fmtMs(r.phases.readers)}, ` + (r.phases.merged !== undefined
    ? `готовый общий индекс из кэша ${fmtMs(r.phases.merged)}`
    : `нормализация ключей ${fmtMs(r.phases.keys)}, сортировка ${fmtMs(r.phases.sort)} (индекс собран заново и сохранён)`);
  recordLoad(r.ms, r.total);
  assign(lay, sources.map((s, i) => {
    const st = status[i];
    return { id: s.id, lang: guessLang(s.folder + '/' + s.main.name, st.s === 'ready' ? st.lang : undefined) };
  }));
  if (lay.scope && !lay.groups.some((g) => g.id === lay.scope)) lay.scope = '';
  saveLayout(lay);
  const n = status.filter((s) => s.s === 'ready').length;
  $('#status').textContent = `Готово: ${n} из ${sources.length} словарей, ${r.total.toLocaleString('ru')} заголовков, ${(r.ms / 1000).toFixed(1)} с.`;
  q.disabled = false;
  q.placeholder = 'Слово…';
  q.focus();
  welcome();
  renderDicts();
  renderScope();
}

/** Словари, в которых есть статья для показанного слова (подсвечиваются в списке). */
const have = new Set<number>();

function dictRow(i: number): string {
  const s = sources[i], st = status[i];
  let sub = `${FMT[s.format] ?? s.format}${s.folder ? ' · ' + esc(s.folder) : ''}`;
  let bar = '', cls = '';
  if (st.s === 'indexing') bar = `<div class="bar"><i style="width:${Math.round((st.done / Math.max(1, st.total)) * 100)}%"></i></div>`;
  if (st.s === 'queued') sub = 'в очереди';
  if (st.s === 'indexing') sub = 'индексация…';
  if (st.s === 'ready') sub = `${st.count.toLocaleString('ru')} слов · ${FMT[s.format]}${st.fromCache ? ' · из кэша' : ''}`;
  if (st.s === 'skipped') { sub = st.reason; cls = ' skip'; }
  if (st.s === 'error') { sub = `<span class="err">${esc(st.reason)}</span>`; cls = ' skip'; }
  const has = have.has(i) ? ' has' : '';
  const tip = have.size ? (have.has(i) ? 'Перейти к статье в этом словаре' : 'В этом словаре нет статьи для текущего слова') : 'Перетащите, чтобы переставить';
  return `<div class="dict${enabled[i] && !cls ? '' : ' off'}${cls}${has}" draggable="true" data-id="${esc(s.id)}" data-i="${i}" title="${tip}"><span class="dot" style="background:${color(i)}"></span><span class="nm">${esc(dictName(i))}<small>${sub}</small>${bar}</span><label class="sw" title="Включить или выключить словарь"><input type="checkbox" data-i="${i}" ${enabled[i] ? 'checked' : ''}><span></span></label></div>`;
}

function renderDicts() {
  const idx = new Map(sources.map((s, i) => [s.id, i]));
  let html = folderName ? `<div class="folder-name">📁 ${esc(folderName)}</div>` : '';
  const placed = new Set<number>();
  for (const g of lay.groups) {
    const members = lay.order.filter((id) => lay.of[id] === g.id && idx.has(id)).map((id) => idx.get(id)!);
    if (!members.length && g.id.startsWith('auto:')) continue;
    members.forEach((i) => placed.add(i));
    const on = members.filter((i) => enabled[i]).length;
    html += `<div class="ghead" data-g="${g.id}"><span class="caret">${g.collapsed ? '▸' : '▾'}</span><span class="gname" title="Двойной щелчок — переименовать">${esc(g.name)}</span><span class="tag">${on}/${members.length}</span>${members.length ? '' : `<button class="gx" data-del="${g.id}" title="Удалить пустую группу">✕</button>`}</div>`;
    if (!g.collapsed) html += members.map(dictRow).join('');
  }
  html += sources.map((_, i) => i).filter((i) => !placed.has(i)).map(dictRow).join(''); // пока группы не назначены
  if (sources.length && lay.groups.length) html += '<button class="chip addgrp" id="addgrp">＋ Группа</button>';
  const el = $('#dictlist');
  el.innerHTML = html;
  if (have.size) el.setAttribute('data-art', ''); else el.removeAttribute('data-art');
}

function renderScope() {
  const el = $('#scope');
  const have = lay.groups.filter((g) => Object.entries(lay.of).some(([id, gid]) => gid === g.id && sources.some((s) => s.id === id)));
  if (have.length < 2) { el.innerHTML = ''; return; }
  el.innerHTML = 'Искать в:' + [{ id: '', name: 'Всех' }, ...have].map((g) => `<button class="${lay.scope === g.id ? 'on' : ''}" data-scope="${g.id}">${esc(g.name)}</button>`).join('');
}

/* ---------- поиск и подсказки ---------- */
const q = $<HTMLInputElement>('#q'), sug = $('#sug'), out = $('#out');
let cur: Hit[] = [], sel = -1, qSeq = 0;
let recent: string[] = JSON.parse(store.get('recent', '[]'));

const dots = (d: number[]) => d.map((i) => `<i style="background:${color(i)}"></i>`).join('');
function hl(h: string, qs: string): string {
  const kk = key(qs).length;
  let n = 0, i = 0;
  for (; i < h.length && n < kk; i++) if (key(h[i]).length) n++;
  return `<mark>${esc(h.slice(0, i))}</mark>${esc(h.slice(i))}`;
}
let pending: Promise<void> = Promise.resolve(); // последний запущенный поиск; Enter ждёт его
function renderSug(): Promise<void> {
  pending = doSug();
  return pending;
}
async function doSug() {
  if (textMode) { cur = []; sel = -1; sug.classList.remove('open'); return; }
  const v = q.value.trim();
  if (!v || !ready) { cur = []; sel = -1; sug.classList.remove('open'); return; }
  const mine = ++qSeq;
  const r = await call<Extract<Res, { t: 'search' }>>({ t: 'search', q: v, enabled: mask() });
  if (mine !== qSeq) return;
  cur = r.items;
  sel = cur.length ? 0 : -1;
  if (!cur.length) {
    sug.innerHTML = '<div class="hint">Ничего не найдено. Попробуйте без апострофа или дефиса.</div>';
    sug.classList.add('open');
    return;
  }
  const exact = !r.fuzzy || cur.some((i) => i.k === key(v));
  sug.innerHTML =
    (r.fuzzy && !exact ? '<div class="hint">Возможно, вы имели в виду:</div>' : '') +
    cur.map((e, i) => `<div class="row${i === sel ? ' sel' : ''}" data-i="${i}"><span>${e.form ? `${esc(e.h)} <span class="via">← ${esc(e.form)}</span>` : r.fuzzy && !exact ? esc(e.h) : hl(e.h, v)}</span><span class="dots">${dots(e.dicts)}</span></div>`).join('');
  sug.classList.add('open');
}
const markSel = () => [...sug.querySelectorAll('.row')].forEach((r, i) => r.classList.toggle('sel', i === sel));

/* ---------- статья ---------- */
const isDark = () => document.documentElement.dataset.theme === 'dark';
/** Цвета статей без собственного CSS подстраиваются под тему (внутри Shadow DOM карточек). */
function adaptAll() {
  out.querySelectorAll<HTMLElement>('.card .body').forEach((host) => {
    const art = host.shadowRoot?.querySelector('.art:not(.dict)');
    if (art) adaptColors(art, isDark());
  });
}

let shownWord = '';
async function show(h: string) {
  shownWord = h;
  cancelFt();
  clearHighlights();
  q.value = ''; // слово найдено — строка поиска готова к следующему вводу (само слово видно в заголовке статьи)
  cur = [];
  sel = -1;
  qSeq++; // запоздавший ответ прежнего поиска не должен снова открыть список
  sug.classList.remove('open');
  recent = [h, ...recent.filter((x) => x !== h)].slice(0, 8);
  store.set('recent', JSON.stringify(recent));
  renderRecent();
  let parts: ArticlePart[] = [];
  try { parts = (await call<Extract<Res, { t: 'article' }>>({ t: 'article', h, enabled: mask() })).parts; }
  catch (e) { out.innerHTML = `<div class="empty">Не удалось прочитать статью: ${esc(String(e))}</div>`; return; }
  usedInView.clear();
  const pos = new Map(displayOrder().map((d, n) => [d, n]));
  parts.sort((a, b) => pos.get(a.dict)! - pos.get(b.dict)!);

  // у каждой статьи — своя таблица стилей словаря (из MDD, ZIP, Slob или файла рядом)
  const built = await Promise.all(parts.map(async (p) => {
    const css: string[] = [];
    const seen = new Set<string>();
    const bodies: string[] = [];
    for (const x of p.entries) {
      const pr = prepare(x.html);
      for (const href of pr.links) if (!seen.has(href)) { seen.add(href); const c = await res.stylesheet(p.dict, href); if (c) css.push(c); }
      for (const st of pr.styles) { const c = await res.inline(p.dict, st); if (c) css.push(c); }
      bodies.push(`<div class="entry">${pr.body}</div>`);
    }
    return { dict: p.dict, css, styled: css.length > 0, html: bodies.join('') };
  }));

  const cards = built.map((p) => `<section class="card"><header><span class="dot" style="background:${color(p.dict)}"></span><b>${esc(dictName(p.dict))}</b><small>${esc(sources[p.dict].folder)}</small><svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></header><div class="body" data-dict="${p.dict}"></div></section>`).join('');
  out.innerHTML = `<div class="result"><h1>${esc(h)}</h1><p class="sub">${parts.length ? `Найдено в словарях: ${parts.length}` : 'В выбранных словарях такого слова нет.'}</p>${cards}</div>`;
  out.querySelectorAll<HTMLElement>('.card .body').forEach((host, i) => {
    const p = built[i];
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${ART_CSS}</style>${p.css.map((c) => `<style>${c}</style>`).join('')}<div class="art${p.styled ? ' dict' : ''}">${p.html}</div>`;
    host.classList.toggle('styled', p.styled);
    root.querySelectorAll<HTMLImageElement>('img[data-res]').forEach(async (img) => {
      img.addEventListener('load', () => { if ((img.naturalWidth <= 48 && img.naturalHeight <= 48) || (img.naturalHeight <= 24 && img.naturalWidth <= 160)) img.classList.add('glyph'); }); // значки транскрипции
      const u = await res.url(p.dict, img.dataset.res!);
      if (u) img.src = u; else img.style.display = 'none';
    });
  });
  adaptAll();
  have.clear();
  built.forEach((p) => have.add(p.dict));
  renderDicts();
  window.scrollTo({ top: 0 });
}
function renderRecent() {
  $('#recent').innerHTML = recent.length ? 'Недавнее:' + recent.map((w) => `<button data-w="${esc(w)}">${esc(w)}</button>`).join('') : '';
}

/* ---------- стартовые экраны ---------- */
function welcome() {
  if (have.size) { have.clear(); renderDicts(); }
  out.innerHTML = `<div class="welcome"><h2>Начните вводить слово</h2>Диакритика, дефисы и апострофы не мешают. Опечатки исправляются сами. Поиск по тексту статей (по русскому переводу, по фразам): кнопка «Слова» справа в строке поиска или Shift+Enter.
  <div class="tips"><button data-q="epanouir"><b>epanouir</b>найдёт «épanouir»</button><button data-q="contrepied"><b>contrepied</b>найдёт «contre-pied»</button><button data-q="surcrolt"><b>surcrolt</b>опечатка → «surcroît»</button><button data-q="s'epanouir"><b>s'epanouir</b>найдёт «s'épanouir»</button></div></div>`;
}

async function start() {
  q.placeholder = 'Сначала выберите папку со словарями';
  const cl = store.get(CLOUD_KEY);
  if (store.get('src') === 'cloud' && cl && cloudSupported()) { await openCloud(cl); return; }
  const h = await loadHandle();
  if (h) {
    if (await hasAccess(h)) { await openHandle(h); return; }
    out.innerHTML = `<div class="drop"><h2>С возвращением</h2><p>Прошлая папка: <b>${esc(h.name)}</b></p><p>Браузер просит подтвердить доступ — файлы остаются на вашем компьютере.</p>
      <button class="btn" id="resume">Продолжить с этой папкой</button><button class="btn alt" id="other">Выбрать другую</button></div>`;
    $('#resume').onclick = async () => { if (await askAccess(h)) await openHandle(h); };
    $('#other').onclick = pick;
    return;
  }
  dropScreen();
}

function dropScreen() {
  out.innerHTML = `<div class="drop" id="drop"><h2>Подключите папку со словарями</h2>
    <p>Словари не загружаются на сайт: страница читает их прямо с вашего компьютера.</p>
    ${canPick() ? '<button class="btn" id="pick">Выбрать папку…</button>' : ''}
    <button class="btn ${canPick() ? 'alt' : ''}" id="pick2">${canPick() ? 'Другой способ' : 'Выбрать папку…'}</button>
    <p>Или перетащите папку со словарями сюда.</p>
    <p><button class="btn alt" id="cloudbtn" style="margin-top:6px">☁ Подключить из облака по ссылке</button></p>
    ${canPick() ? '' : '<p>Этот браузер не умеет запоминать папку: придётся выбирать её при каждом запуске. В Chrome и Edge этого не нужно.</p>'}
    ${import.meta.env.DEV ? `<div class="devbox">Разработка: <input id="devf" value="${esc(new URLSearchParams(location.search).get('dev') ?? 'GrandRobert')}" size="30"> <button class="btn alt" id="dev" style="margin:0">Загрузить из F:\\словари</button></div>` : ''}
  </div>`;
  const pk = document.getElementById('pick');
  if (pk) pk.onclick = pick;
  $('#cloudbtn').onclick = () => cloudScreen();
  $('#pick2').onclick = () => $<HTMLInputElement>('#fallback').click();
  if (import.meta.env.DEV) {
    $('#dev').onclick = () => devLoad($<HTMLInputElement>('#devf').value);
    if (new URLSearchParams(location.search).has('dev')) devLoad($<HTMLInputElement>('#devf').value);
  }
}

async function pick() {
  try {
    const h = await pickFolder();
    store.set('src', 'dir');
    await saveHandle(h);
    await openHandle(h);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') out.insertAdjacentHTML('afterbegin', `<div class="empty">${esc(String(e))}</div>`);
  }
}
async function openHandle(h: FileSystemDirectoryHandle) {
  q.placeholder = 'Читаю список файлов…';
  const t = performance.now();
  const entries = await walkHandle(h);
  walkMs = performance.now() - t;
  await ingest(entries, h.name);
  walkMs = 0;
}
let walkMs = 0; // сколько заняло чтение списка файлов папки (показывается в диагностике)

/** Только в разработке: берёт файлы с dev-сервера, чтобы не вызывать окно выбора папки. */
async function devLoad(filter: string) {
  const list: { p: string; size: number; mtime: number }[] = await (await fetch('/__dicts/list')).json();
  const want = filter.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const pick = list.filter((x) => (!want.length || want.some((w) => x.p.toLowerCase().includes(w))));
  const entries: Entry[] = [];
  for (const x of pick) {
    const blob = await (await fetch('/__dicts/file?p=' + encodeURIComponent(x.p))).blob();
    entries.push({ path: x.p, file: new File([blob], x.p.split('/').pop()!, { lastModified: x.mtime }) });
  }
  await ingest(entries, 'dev: ' + (filter || 'всё'));
}

/* ---------- словари из облака ---------- */
const CLOUD_KEY = 'cloudlink';
const mb = (n: number) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' МБ';
let cloudAbort: AbortController | null = null;

function cloudScreen(msg = '', busy = false) {
  const saved = store.get(CLOUD_KEY);
  out.innerHTML = `<div class="drop cloud"><h2>Словари из облака</h2>
    <p>Вставьте ссылку на папку Яндекс.Диска или Google Диска (доступ «по ссылке»). Нужные файлы скачаются один раз в память этого браузера, дальше словари работают быстро и без интернета.</p>
    <input id="clink" class="linkin" placeholder="https://disk.yandex.ru/d/…  или  https://drive.google.com/drive/folders/…" value="${esc(saved)}" spellcheck="false" ${busy ? 'disabled' : ''}>
    ${hasBuiltinGoogleKey ? '' : `<details class="gk" ${googleKey() ? '' : 'open'}><summary>Ключ для Google Диска</summary><input id="gkey" class="linkin" placeholder="ключ Google API (только для ссылок Google)" value="${esc(googleKey())}" spellcheck="false" ${busy ? 'disabled' : ''}></details>`}
    <div><button class="btn" id="cgo" ${busy ? 'disabled' : ''}>Подключить</button><button class="btn alt" id="cback">${busy ? 'Отмена' : 'Назад'}</button></div>
    ${msg ? `<p class="cerr">${esc(msg)}</p>` : ''}
    <div id="cprog"></div>
    ${saved && !busy ? '<p><button class="btn alt" id="cclear" style="margin-top:22px">Удалить скачанное из браузера</button></p>' : ''}
  </div>`;
  $('#cback').onclick = () => { if (busy) cloudAbort?.abort(); else if (ready) welcome(); else dropScreen(); };
  const go = document.getElementById('cgo');
  if (go) go.onclick = () => {
    const link = normalizeLink($<HTMLInputElement>('#clink').value);
    if (!link) { cloudScreen('Это не похоже на ссылку на папку Яндекс.Диска (disk.yandex.ru/d/…) или Google Диска (drive.google.com/drive/folders/…).'); return; }
    const gk = document.getElementById('gkey') as HTMLInputElement | null;
    if (gk && gk.value.trim()) setGoogleKey(gk.value);
    if (isGoogle(link) && !googleKey()) { cloudScreen('Для Google Диска нужен ключ API: раскройте «Ключ для Google Диска» и вставьте его.'); return; }
    openCloud(link);
  };
  const cc = document.getElementById('cclear');
  if (cc) cc.onclick = async () => {
    if (!confirm('Удалить скачанные словари из памяти браузера? Их можно будет скачать снова по ссылке.')) return;
    await clearCloud(saved);
    store.set(CLOUD_KEY, '');
    store.set('src', 'dir');
    location.reload();
  };
}

/** Синхронизирует облачную папку с хранилищем браузера и загружает словари. */
let cloudGen = 0; // номер запуска: устаревший запуск (экран уже сменился) тихо заканчивается
async function openCloud(link: string) {
  if (!cloudSupported()) { cloudScreen('Облако работает в Chrome и Edge: нужна запись в хранилище браузера.'); return; }
  store.set(CLOUD_KEY, link);
  store.set('src', 'cloud');
  cloudAbort?.abort(); // прежний запуск (если был) прекращаем
  const gen = ++cloudGen;
  const stale = () => gen !== cloudGen;
  cloudAbort = new AbortController();
  const signal = cloudAbort.signal;
  cloudScreen('', true);
  const prog = $('#cprog');
  prog.innerHTML = '<p>Получаю список файлов…</p>';
  q.placeholder = 'Подключаю облако…';
  const fromCache = async (why: string) => {
    const have = await cloudEntries(link);
    if (!have) return false;
    await ingest(have.entries, '☁ ' + have.name);
    if (why) $('#status').textContent = why + ' ' + $('#status').textContent;
    return true;
  };
  let remote: { name: string; items: CloudItem[] };
  try {
    remote = await listCloud(link, signal);
  } catch (e) {
    if (stale()) return;
    if (await fromCache('Нет связи с облаком, использую скачанное.')) return;
    cloudScreen(signal.aborted ? '' : (e as Error).message || String(e));
    return;
  }
  if (stale()) return;
  if (!remote.items.length) { cloudScreen('В этой папке не нашлось словарей (нужны файлы .mdx, .dsl, .ifo, .slob, .gls).'); return; }
  const plan = await planSync(link, remote);
  if (stale()) return;
  let failed: { path: string; message: string }[] = [];
  if (plan.todo.length || plan.gone.length) {
    const est = await navigator.storage.estimate?.();
    if (est?.quota && est.usage !== undefined && est.quota - est.usage < plan.bytes * 1.1) {
      cloudScreen(`Не хватает места в браузере: нужно ${mb(plan.bytes)}, свободно ${mb(Math.max(0, est.quota - est.usage))}.`);
      return;
    }
    prog.innerHTML = `<p>Нужно скачать: ${plan.todo.length} файл(ов), ${mb(plan.bytes)}</p><div class="bar"><i id="cbar"></i></div><p id="ctxt" class="cfile">Подключаюсь к облаку…</p>`;
    try {
      failed = await syncCloud(link, remote, (p) => {
        const bar = document.getElementById('cbar'), tx = document.getElementById('ctxt');
        if (stale() || !bar || !tx) return; // экран уже сменился
        bar.style.width = (p.total ? Math.min(100, (p.done / p.total) * 100) : 100).toFixed(1) + '%';
        tx.textContent = `${mb(p.done)} из ${mb(p.total)} · готово файлов: ${p.fileNo} из ${p.files} · ${p.file.slice(p.file.lastIndexOf('/') + 1)}` + (p.note ? `
⚠ ${p.note}` : '');
      }, signal);
    } catch (e) {
      if (stale()) return;
      if (signal.aborted) { if (await fromCache('Обновление отменено.')) return; cloudScreen(); return; }
      cloudScreen('Ошибка при скачивании: ' + ((e as Error).message || String(e)));
      return;
    }
  }
  if (stale()) return;
  const have = await cloudEntries(link);
  if (stale()) return;
  if (!have) {
    cloudScreen(failed.length ? 'Не удалось скачать ни одного файла: ' + failed.map((f) => f.path).join(', ') : 'Не удалось прочитать скачанные файлы.');
    return;
  }
  await ingest(have.entries, '☁ ' + have.name);
  if (failed.length) {
    const names = failed.map((f) => f.path.slice(f.path.lastIndexOf('/') + 1));
    $('#status').textContent = `⚠ Не скачано (${failed.length}): ${names.join(', ')}. Облако не отдало файл. Повторите через «☁ Облако». ` + $('#status').textContent;
  }
}

/* ---------- поиск по тексту статей ---------- */
let textMode = false;
let ftAll = store.get('ftall') === '1'; // «все слова» вместо «фразы»
let ftTerms: string[] = [];
let ftId = 0;
let ftSnapshot = '';
let ftQuery = '';

function setMode(on: boolean) {
  textMode = on;
  const b = $('#mode');
  b.textContent = on ? 'Текст' : 'Слова';
  b.classList.toggle('on', on);
  $('#modeAll').hidden = !on;
  q.placeholder = on ? 'Текст статей… Enter — искать' : 'Слово…';
  sug.classList.remove('open');
  q.focus({ preventScroll: true });
}
function cancelFt() {
  if (!ftId) return;
  worker.postMessage({ t: 'ftcancel', id: ftId });
  streams.delete(ftId);
  ftId = 0;
}
const plural = (n: number, a: string, b: string, c: string) => {
  const m = n % 100, d = n % 10;
  return m >= 11 && m <= 14 ? c : d === 1 ? a : d >= 2 && d <= 4 ? b : c;
};
const num = (n: number) => n.toLocaleString('ru');

function hitHtml(h: FtHit): string {
  const sn = h.sn.map((s) => `<div class="ftsn">${s.l ? '…' : ''}${s.segs.map(([t, hl]) => (hl ? `<mark>${esc(t)}</mark>` : esc(t))).join('')}${s.r ? '…' : ''}</div>`).join('');
  return `<div class="fthit" data-ft="${h.dict}" data-h="${esc(h.h)}"><b class="fth">${esc(h.h)}</b>${sn}</div>`;
}

function startTextSearch(raw: string) {
  if (!ready) return;
  const text = raw.trim();
  cancelFt();
  sug.classList.remove('open');
  ftQuery = text;
  clearHighlights();
  ftTerms = parseTerms(text, ftAll);
  if (have.size) { have.clear(); renderDicts(); }
  if (!ftTerms.some((t) => buildSearchRegex(t))) { out.innerHTML = '<div class="empty">Введите хотя бы одно слово из двух и более символов.</div>'; return; }
  const mk = mask();
  const order = displayOrder().filter((i) => mk[i] && status[i]?.s === 'ready');
  if (!order.length) { out.innerHTML = '<div class="empty">Нет включённых словарей для поиска. Включите словари или выберите группу.</div>'; return; }
  const id = ++seq;
  ftId = id;
  out.innerHTML = `<div class="result ft"><h1>Поиск по тексту</h1><p class="sub">${ftAll && ftTerms.length > 1 ? 'все слова: ' + ftTerms.map((t) => '«' + esc(t) + '»').join(' + ') : '«' + esc(text) + '»'} в ${order.length} ${plural(order.length, 'словаре', 'словарях', 'словарях')} · регистр, диакритика, дефисы и апострофы не важны</p><div class="ftprog" id="ftprog"></div><div id="ftres"></div></div>`;
  const prog = $('#ftprog'), resEl = $('#ftres');
  const bodies = new Map<number, HTMLElement>();
  const counts = new Map<number, number>();
  let total = 0;
  const t0 = performance.now();
  prog.innerHTML = 'Начинаю…';
  streams.set(id, (m) => {
    for (const h of m.hits) {
      let body = bodies.get(h.dict);
      if (!body) {
        const sec = document.createElement('section');
        sec.className = 'card';
        sec.innerHTML = `<header><span class="dot" style="background:${color(h.dict)}"></span><b>${esc(dictName(h.dict))}</b><small class="ftn"></small><svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></header><div class="ftlist"></div>`;
        resEl.appendChild(sec);
        body = sec.querySelector<HTMLElement>('.ftlist')!;
        bodies.set(h.dict, body);
      }
      body.insertAdjacentHTML('beforeend', hitHtml(h));
      const c = (counts.get(h.dict) ?? 0) + 1;
      counts.set(h.dict, c);
      body.closest('.card')!.querySelector('.ftn')!.textContent = String(c);
      total++;
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (m.finished) {
      streams.delete(id);
      if (ftId === id) ftId = 0;
      prog.innerHTML = `${m.stopped ? 'Остановлено' : 'Готово'} за ${secs} с: просмотрено ${num(m.scanned)} ${plural(m.scanned, 'статья', 'статьи', 'статей')}, найдено ${num(total)}${m.capped ? `. Показаны первые ${num(total)}: уточните фразу или выберите группу словарей` : ''}.`;
      if (!total) resEl.innerHTML = '<div class="empty">Ничего не найдено. Проверьте написание или поищите по части фразы; поиск идёт только в включённых словарях выбранной группы.</div>';
    } else {
      const pct = Math.round(((m.dictNo + m.done / Math.max(1, m.total)) / Math.max(1, m.dictCount)) * 100);
      prog.innerHTML = `<div class="ftline">Просматриваю «${esc(dictName(m.dict))}» (${m.dictNo + 1} из ${m.dictCount}) · найдено ${num(total)} · ${secs} с <button class="chip" id="ftstop">Остановить</button></div><div class="bar"><i style="width:${pct}%"></i></div>`;
    }
  });
  worker.postMessage({ t: 'ftsearch', id, q: text, all: ftAll, enabled: mk, order });
}

async function openFromHit(dict: number, h: string) {
  cancelFt();
  const y = window.scrollY;
  ftSnapshot = out.innerHTML;
  await show(h);
  const back = document.createElement('a');
  back.className = 'backlink';
  back.dataset.back = String(y);
  back.textContent = `← К результатам поиска «${ftQuery}»`;
  out.querySelector('.result')?.prepend(back);
  const first = highlightTerms(dict);
  if (first) { // прокрутить к первому найденному месту в этом словаре
    const card = first.startContainer.parentElement?.getRootNode() instanceof ShadowRoot ? ((first.startContainer.getRootNode() as ShadowRoot).host.closest('.card') as HTMLElement | null) : null;
    card?.classList.remove('closed');
    window.scrollTo({ top: Math.max(0, first.getBoundingClientRect().top + window.scrollY - 190) });
  } else jumpToDict(dict);
}

/* подсветка найденного прямо в открытой статье (CSS Custom Highlight API) */
function clearHighlights() {
  (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete('ft');
}
function rangesIn(root: Element, res: RegExp[]): Range[] {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: { n: Text; start: number }[] = [];
  let text = '', lastBlock: Element | null = null;
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
    const blk = n.parentElement?.closest('div,p,li,tr,td,th,h1,h2,h3,h4,h5,h6,dt,dd,table,ul,ol') ?? root;
    if (lastBlock && blk !== lastBlock) text += ' '; // как при поиске: между блоками пробел
    lastBlock = blk;
    nodes.push({ n, start: text.length });
    text += n.data;
  }
  const at = (pos: number) => { // узел, в котором лежит символ с номером pos
    let lo = 0, hi = nodes.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (nodes[m].start <= pos) lo = m; else hi = m - 1; }
    return nodes[lo];
  };
  const out: Range[] = [];
  for (const re of res) {
    for (const m of text.matchAll(re)) {
      if (!m[0] || out.length >= 600) continue;
      const a = at(m.index), z = at(m.index + m[0].length - 1);
      const r = new Range();
      r.setStart(a.n, m.index - a.start);
      r.setEnd(z.n, Math.min(z.n.length, m.index + m[0].length - z.start));
      out.push(r);
    }
  }
  return out.sort((x, y) => x.compareBoundaryPoints(Range.START_TO_START, y));
}
/** Подсвечивает части запроса во всех карточках; возвращает первое совпадение в карточке словаря dict. */
function highlightTerms(dict: number): Range | null {
  const api = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!api || !H) return null;
  const res = ftTerms.map((t) => buildSearchRegex(t, 'giu')).filter((r): r is RegExp => !!r);
  const all: Range[] = [];
  let first: Range | null = null;
  out.querySelectorAll<HTMLElement>('.card .body').forEach((host) => {
    const art = host.shadowRoot?.querySelector('.art');
    if (!art) return;
    const rs = rangesIn(art, res);
    all.push(...rs);
    if (!first && +host.dataset.dict! === dict && rs.length) first = rs[0];
  });
  api.set('ft', new H(...all));
  return first;
}

document.addEventListener('click', (e) => {
  const t = (e.composedPath()[0] ?? e.target) as HTMLElement;
  const hit = t.closest?.<HTMLElement>('.fthit');
  if (hit) { openFromHit(+hit.dataset.ft!, hit.dataset.h!); return; }
  if (t.closest?.('#ftstop')) { cancelFt(); $('#ftprog').textContent = 'Остановлено.'; return; }
  const bk = t.closest?.<HTMLElement>('[data-back]');
  if (bk) { clearHighlights(); out.innerHTML = ftSnapshot; have.clear(); renderDicts(); window.scrollTo({ top: +bk.dataset.back! }); }
});
$('#mode').onclick = () => setMode(!textMode);
function setAll(on: boolean) {
  ftAll = on;
  store.set('ftall', on ? '1' : '');
  $('#modeAll').textContent = on ? 'Все слова' : 'Фраза';
  $('#modeAll').classList.toggle('on', on);
}
$('#modeAll').onclick = () => { setAll(!ftAll); q.focus({ preventScroll: true }); };
setAll(ftAll);

/* ---------- диагностика ---------- */
interface LoadRec { at: string; ms: number; total: number; dicts: number; built: number; cached: number; cold: boolean }
const history: LoadRec[] = JSON.parse(store.get('loads', '[]'));
let lastEntries: Entry[] = [];
let lastLabel = '';
let lastLoad: LoadRec | null = null;
let nextIsCold = false;

let lastPhases = '';
function recordLoad(ms: number, total: number) {
  const ready = status.filter((s): s is Extract<DictStatus, { s: 'ready' }> => s.s === 'ready');
  const cached = ready.filter((s) => s.fromCache).length;
  lastLoad = { at: new Date().toLocaleString('ru'), ms, total, dicts: ready.length, built: ready.length - cached, cached, cold: nextIsCold };
  nextIsCold = false;
  history.unshift(lastLoad);
  history.length = Math.min(history.length, 8);
  store.set('loads', JSON.stringify(history));
}

const fmtMs = (ms: number) => (ms >= 1000 ? (ms / 1000).toFixed(1) + ' с' : ms + ' мс');

async function report(): Promise<string> {
  const ready = status.map((s, i) => [s, i] as const).filter(([s]) => s.s === 'ready') as [Extract<DictStatus, { s: 'ready' }>, number][];
  const bad = status.map((s, i) => [s, i] as const).filter(([s]) => s.s === 'skipped' || s.s === 'error');
  const st = await call<Extract<Res, { t: 'stats' }>>({ t: 'stats' }).catch(() => null);
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  let storage = 'недоступно';
  try { const e = await navigator.storage.estimate(); storage = `занято ${Math.round((e.usage ?? 0) / 1e6)} МБ из ${Math.round((e.quota ?? 0) / 1e9)} ГБ (кэш индекса и данные сайта)`; } catch { /* нет API */ }
  const slow = [...ready].filter(([s]) => !s.fromCache).sort((a, b) => b[0].ms - a[0].ms).slice(0, 5);
  const L: string[] = [];
  L.push(`Папка: ${folderName || '—'}`);
  L.push(`Словарей найдено: ${sources.length}; открыто: ${ready.length}; не открыто: ${bad.length}`);
  L.push(`Заголовков в общем индексе: ${(st?.entries ?? 0).toLocaleString('ru')}`);
  if (lastLoad) L.push(`Последняя загрузка: ${fmtMs(lastLoad.ms)} (${lastLoad.cold ? 'после сброса кэша' : lastLoad.built ? 'часть словарей читалась заново' : 'всё из кэша'}); из кэша: ${lastLoad.cached}, построено заново: ${lastLoad.built}`);
  if (lastPhases) L.push(`Из чего сложилось: ${lastPhases}`);
  if (slow.length) L.push(`Дольше всего строились: ${slow.map(([s, i]) => `${dictName(i)} — ${fmtMs(s.ms)}`).join('; ')}`);
  L.push(`Память (JS): страница ~${mem ? Math.round(mem.usedJSHeapSize / 1e6) : '?'} МБ${st && st.heapMB >= 0 ? `, обработчик поиска ~${st.heapMB} МБ` : ''}. Полный расход вкладки смотрите в диспетчере задач Chrome (Shift+Esc), строка с этой вкладкой.`);
  L.push(`Хранилище: ${storage}`);
  if (bad.length) {
    L.push('', 'Не открылись:');
    for (const [s, i] of bad) L.push(`  • ${sources[i].main.name}: ${s.s === 'skipped' || s.s === 'error' ? s.reason : ''}`);
  }
  if (history.length) {
    L.push('', 'История загрузок:');
    for (const h of history) L.push(`  • ${h.at}: ${fmtMs(h.ms)}, ${h.total.toLocaleString('ru')} заголовков, из кэша ${h.cached}/построено ${h.built}${h.cold ? ' (после сброса кэша)' : ''}`);
  }
  L.push('', `Браузер: ${navigator.userAgent}`);
  return L.join('\n');
}

async function showDiag() {
  if (!sources.length) { out.innerHTML = '<div class="empty">Сначала подключите папку со словарями.</div>'; return; }
  const text = await report();
  out.innerHTML = `<div class="result"><h1>Диагностика</h1><p class="sub">Для проверки на всей библиотеке: нажмите «Сбросить кэш…», дождитесь строки «Готово» и скопируйте отчёт.</p>
    <section class="card"><div class="body" style="padding:18px 22px"><pre class="diag">${esc(text)}</pre>
    <button class="btn alt" id="dcopy" style="margin:12px 8px 0 0">Скопировать отчёт</button><button class="btn alt" id="dcold" style="margin:12px 0 0">Сбросить кэш индекса и перечитать</button></div></section></div>`;
  $('#dcopy').onclick = async () => { try { await navigator.clipboard.writeText(text); $('#dcopy').textContent = 'Скопировано'; } catch { /* нет доступа к буферу */ } };
  $('#dcold').onclick = async () => {
    $('#dcold').textContent = 'Перечитываю…';
    nextIsCold = true;
    await call({ t: 'clear' });
    await ingest(lastEntries, lastLabel);
    await showDiag();
  };
}

/* ---------- события ---------- */
q.addEventListener('input', renderSug);
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (textMode || e.shiftKey)) { e.preventDefault(); startTextSearch(q.value); return; }
  if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, cur.length - 1); markSel(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); markSel(); e.preventDefault(); }
  else if (e.key === 'Enter') {
    pending.then(() => { if (cur[sel]) show(cur[sel].h); else if (q.value.trim()) show(q.value.trim()); });
  }
  else if (e.key === 'Escape') sug.classList.remove('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== q && !q.disabled) { e.preventDefault(); q.focus(); q.select(); }
});
/* курсор сам возвращается в строку поиска: не надо листать наверх */
const focusSearch = () => { if (!q.disabled && document.activeElement !== q) q.focus({ preventScroll: true }); };
const INTERACTIVE = 'a,button,input,textarea,select,label,summary,[data-w],[data-snd],[data-scope],[data-del],[data-back],.fthit,.mode,#modeAll,#dictlist .dict,.ghead,.card>header,.sw,.btn,.chip,#resizer,.mrz,.sug,.tips,.recent button';
document.addEventListener('click', (e) => {
  if ((e as PointerEvent).pointerType === 'touch') return; // на сенсорном экране не вызываем клавиатуру
  if (window.getSelection()?.toString()) return; // человек выделяет текст
  const t = (e.composedPath()[0] ?? e.target) as Element;
  if (t.closest?.(INTERACTIVE)) return;
  focusSearch();
});
document.addEventListener('keydown', (e) => { // начал печатать, не глядя, куда сфокусирован курсор
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || e.key === ' ' || e.key === '/') return;
  const a = document.activeElement as HTMLElement | null;
  if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
  focusSearch();
});

sug.addEventListener('mousedown', (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>('.row');
  if (r) { e.preventDefault(); show(cur[+r.dataset.i!].h); }
});
q.addEventListener('focus', () => { if (q.value.trim()) renderSug(); });
q.addEventListener('blur', () => setTimeout(() => sug.classList.remove('open'), 120));
document.addEventListener('click', (e) => {
  const t = (e.composedPath()[0] ?? e.target) as HTMLElement; // клики внутри Shadow DOM карточек
  const inHost = (t.getRootNode() as ShadowRoot).host as HTMLElement | undefined;
  if (inHost?.dataset?.dict !== undefined && !window.getSelection()?.toString()) useDict(+inHost.dataset.dict, true); // щелчок внутри статьи словаря
  const sn = t.closest?.<HTMLElement>('[data-snd]');
  if (sn) {
    const dict = +((sn.getRootNode() as ShadowRoot).host as HTMLElement | undefined)?.dataset.dict!;
    if (!Number.isNaN(dict)) { e.preventDefault(); playSound(dict, sn.dataset.snd!); }
    return;
  }
  const w = t.closest?.<HTMLElement>('[data-w]');
  if (w) { e.preventDefault(); if (ready) show(w.dataset.w!); return; }
  const tq = t.closest?.<HTMLElement>('[data-q]');
  if (tq) { q.value = tq.dataset.q!; q.focus(); renderSug(); return; }
  const h = t.closest?.('.card>header');
  if (h) {
    const card = h.parentElement!;
    card.classList.toggle('closed');
    const d = (card.querySelector('.body') as HTMLElement | null)?.dataset.dict;
    if (!card.classList.contains('closed') && d !== undefined) useDict(+d, true); // раскрыл карточку = интересуется этим словарём
  }
});
$('#dictlist').addEventListener('change', (e) => {
  const i = +(e.target as HTMLInputElement).dataset.i!;
  enabled[i] = (e.target as HTMLInputElement).checked;
  if (enabled[i]) off.delete(sources[i].id); else off.add(sources[i].id);
  store.set('off', JSON.stringify([...off]));
  renderDicts();
  if (q.value.trim()) renderSug();
});

/* ---------- группы: сворачивание, переименование, перетаскивание ---------- */
const dl = $('#dictlist');
const saveRender = () => { saveLayout(lay); renderDicts(); renderScope(); };
/** Переход к статье слова в выбранном словаре (как в GoldenDict). */
function jumpToDict(i: number) {
  const host = out.querySelector<HTMLElement>(`.card .body[data-dict="${i}"]`);
  const card = host?.closest<HTMLElement>('.card');
  if (!card) return;
  useDict(i, true);
  card.classList.remove('closed');
  window.scrollTo({ top: Math.max(0, card.getBoundingClientRect().top + window.scrollY - 14) });
  card.classList.remove('flash');
  void card.offsetWidth; // перезапуск анимации
  card.classList.add('flash');
}

dl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const row = t.closest<HTMLElement>('.dict');
  if (row && !t.closest('.sw')) { if (have.has(+row.dataset.i!)) jumpToDict(+row.dataset.i!); return; }
  const del = t.closest<HTMLElement>('[data-del]');
  if (del) { lay.groups = lay.groups.filter((g) => g.id !== del.dataset.del); if (lay.scope === del.dataset.del) lay.scope = ''; saveRender(); return; }
  if (t.closest('#addgrp')) {
    const name = prompt('Название новой группы')?.trim();
    if (name) { lay.groups.push({ id: newGroupId(), name }); saveRender(); }
    return;
  }
  const gh = t.closest<HTMLElement>('.ghead');
  if (gh) { const g = lay.groups.find((x) => x.id === gh.dataset.g); if (g) { g.collapsed = !g.collapsed; saveRender(); } }
});
dl.addEventListener('dblclick', (e) => {
  const gh = (e.target as HTMLElement).closest<HTMLElement>('.ghead');
  const g = gh && lay.groups.find((x) => x.id === gh.dataset.g);
  if (!g) return;
  const name = prompt('Название группы', g.name)?.trim();
  if (name) g.name = name;
  saveRender();
});
let dragId = '';
dl.addEventListener('dragstart', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.dict');
  if (!row) return;
  dragId = row.dataset.id!;
  e.dataTransfer!.effectAllowed = 'move';
  e.dataTransfer!.setData('text/plain', dragId);
  row.classList.add('dragging');
});
dl.addEventListener('dragend', () => { dragId = ''; dl.querySelectorAll('.dragging,.dragover').forEach((x) => x.classList.remove('dragging', 'dragover')); });
dl.addEventListener('dragover', (e) => {
  if (!dragId) return;
  const t = (e.target as HTMLElement).closest<HTMLElement>('.dict,.ghead');
  if (!t) return;
  e.preventDefault();
  dl.querySelectorAll('.dragover').forEach((x) => x !== t && x.classList.remove('dragover'));
  t.classList.add('dragover');
});
dl.addEventListener('drop', (e) => {
  if (!dragId) return;
  const t = (e.target as HTMLElement).closest<HTMLElement>('.dict,.ghead');
  if (!t) return;
  e.preventDefault();
  if (t.classList.contains('ghead')) move(lay, dragId, t.dataset.g!, null);
  else if (t.dataset.id !== dragId) move(lay, dragId, lay.of[t.dataset.id!], t.dataset.id!);
  dragId = '';
  saveRender();
});
document.addEventListener('click', (e) => {
  const sc = (e.target as HTMLElement).closest<HTMLElement>('[data-scope]');
  if (!sc) return;
  lay.scope = sc.dataset.scope!;
  saveLayout(lay);
  renderScope();
  if (q.value.trim()) renderSug();
});

/* ---------- запасной выбор папки и перетаскивание папки ---------- */
document.body.insertAdjacentHTML('beforeend', '<input type="file" id="fallback" webkitdirectory multiple hidden>');
$<HTMLInputElement>('#fallback').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files;
  if (f?.length) store.set('src', 'dir');
  if (f?.length) await ingest(fromFileList(f), (f[0] as File & { webkitRelativePath: string }).webkitRelativePath.split('/')[0]);
});
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); document.getElementById('drop')?.classList.add('over'); });
addEventListener('dragleave', () => document.getElementById('drop')?.classList.remove('over'));
addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return; // перетаскивание словарей внутри списка — не загрузка папки
  e.preventDefault();
  const entries = await fromDrop(e.dataTransfer!);
  store.set('src', 'dir');
  await ingest(entries, 'перетащенная папка');
});
$('#diag').onclick = showDiag;
$('#folder').onclick = () => { if (canPick()) pick(); else dropScreen(); };
$('#cloud').onclick = () => cloudScreen();

/* ---------- ширина боковой панели ---------- */
const SIDE = { min: 220, max: 640, def: 270 };
const clampSide = (w: number) => Math.round(Math.max(SIDE.min, Math.min(Math.min(SIDE.max, window.innerWidth * 0.6), w)));
function setSide(w: number, save = true) {
  w = clampSide(w);
  document.documentElement.style.setProperty('--side-w', w + 'px');
  $('#resizer').setAttribute('aria-valuenow', String(w));
  if (save) store.set('sidew', String(w));
}
setSide(+store.get('sidew', String(SIDE.def)) || SIDE.def, false);
addEventListener('resize', () => setSide(+store.get('sidew', String(SIDE.def)) || SIDE.def, false));
{
  const rz = $('#resizer');
  const cur = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--side-w'), 10) || SIDE.def;
  rz.addEventListener('pointerdown', (e) => {
    rz.setPointerCapture(e.pointerId);
    rz.classList.add('drag');
    document.body.classList.add('resizing');
    e.preventDefault();
  });
  rz.addEventListener('pointermove', (e) => { if (rz.hasPointerCapture(e.pointerId)) setSide(e.clientX, false); });
  const stop = (e: PointerEvent) => {
    if (!rz.hasPointerCapture(e.pointerId)) return;
    rz.releasePointerCapture(e.pointerId);
    rz.classList.remove('drag');
    document.body.classList.remove('resizing');
    setSide(cur()); // сохранить
  };
  rz.addEventListener('pointerup', stop);
  rz.addEventListener('pointercancel', stop);
  rz.addEventListener('dblclick', () => setSide(SIDE.def));
  rz.addEventListener('keydown', (e) => { // с клавиатуры: стрелки, Home — сброс
    if (e.key === 'ArrowLeft') { setSide(cur() - 16); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { setSide(cur() + 16); e.preventDefault(); }
    else if (e.key === 'Home') { setSide(SIDE.def); e.preventDefault(); }
  });
}

/* ---------- ширина области с текстом ---------- */
const MAIN = { min: 520, def: 1000 };
const mainEl = document.querySelector('main') as HTMLElement;
let mainW = MAIN.def;
const cellW = () => window.innerWidth <= 820 ? window.innerWidth : window.innerWidth - (parseInt(getComputedStyle(document.documentElement).getPropertyValue('--side-w'), 10) || SIDE.def);
const clampMain = (w: number) => Math.round(Math.max(MAIN.min, Math.min(Math.max(MAIN.min, cellW()), w)));
function placeMainHandles() {
  const r = mainEl.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(mainEl).paddingLeft) || 0;
  $('#mrzL').style.left = r.left + pad - 4.5 + 'px';
  $('#mrzR').style.left = r.right - pad - 4.5 + 'px';
  for (const h of [$('#mrzL'), $('#mrzR')]) h.setAttribute('aria-valuenow', String(mainW));
}
function setMain(w: number, save = true) {
  mainW = clampMain(w);
  document.documentElement.style.setProperty('--main-w', mainW + 'px');
  if (save) store.set('mainw', String(mainW));
  placeMainHandles();
}
setMain(+store.get('mainw', String(MAIN.def)) || MAIN.def, false);
addEventListener('resize', () => setMain(+store.get('mainw', String(MAIN.def)) || MAIN.def, false));
new ResizeObserver(placeMainHandles).observe(mainEl);
for (const rz of [$('#mrzL'), $('#mrzR')]) {
  const dir = +(rz.dataset.side as string); // −1 левая ручка, +1 правая
  let center = 0;
  rz.addEventListener('pointerdown', (e) => {
    const r = mainEl.getBoundingClientRect();
    center = (r.left + r.right) / 2;
    rz.setPointerCapture(e.pointerId);
    rz.classList.add('drag');
    document.body.classList.add('resizing');
    e.preventDefault();
  });
  rz.addEventListener('pointermove', (e) => {
    if (!rz.hasPointerCapture(e.pointerId)) return;
    const pad = parseFloat(getComputedStyle(mainEl).paddingLeft) || 0;
    setMain(2 * Math.abs(e.clientX - center) + 2 * pad, false);
  });
  const stop = (e: PointerEvent) => {
    if (!rz.hasPointerCapture(e.pointerId)) return;
    rz.releasePointerCapture(e.pointerId);
    rz.classList.remove('drag');
    document.body.classList.remove('resizing');
    setMain(mainW); // сохранить
  };
  rz.addEventListener('pointerup', stop);
  rz.addEventListener('pointercancel', stop);
  rz.addEventListener('dblclick', () => setMain(MAIN.def));
  rz.addEventListener('keydown', (e) => { // стрелки в сторону от текста расширяют, к тексту сужают; Home — сброс
    if (e.key === 'ArrowLeft') { setMain(mainW - dir * 32); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { setMain(mainW + dir * 32); e.preventDefault(); }
    else if (e.key === 'Home') { setMain(MAIN.def); e.preventDefault(); }
  });
}

/* ---------- тема, вид, размер шрифта ---------- */
/** Верхняя планка окна установленного приложения (и адресная строка на телефоне) красится в цвет фона текущей темы. */
function syncChrome() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (bg) document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', bg);
}
function setTheme(t: string) {
  document.documentElement.dataset.theme = t;
  store.set('theme', t);
  syncChrome();
  adaptAll();
}
$('#theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
function setStyle(soft: boolean) {
  if (soft) document.documentElement.dataset.style = 'soft'; else delete document.documentElement.dataset.style;
  $('#style').textContent = '▦ Вид: ' + (soft ? 'мягче' : 'обычный');
  store.set('style', soft ? 'soft' : '');
  syncChrome();
}
$('#style').onclick = () => setStyle(document.documentElement.dataset.style !== 'soft');
setStyle(store.get('style') === 'soft');
let fs = +store.get('fs', '19');
function setFs(v: number) { fs = Math.max(14, Math.min(34, v)); document.documentElement.style.setProperty('--fs', fs + 'px'); store.set('fs', String(fs)); }
$('#fsm').onclick = () => setFs(fs - 2);
$('#fsp').onclick = () => setFs(fs + 2);
setFs(fs);

/* ---------- окно настроек ---------- */
const settings = $<HTMLDialogElement>('#settings');
function usageNote() {
  const n = Object.values(usage).reduce((s, v) => s + v, 0);
  $('#usagenote').textContent = n ? `Учтено обращений: ${n}` : 'Пока пусто. Считаются раскрытия карточек, переходы из списка слева и щелчки внутри статей.';
}
/** Перестраивает открытую статью, чтобы новый порядок карточек был виден сразу. */
function reshow() { if (shownWord && out.querySelector('.result')) void show(shownWord); }
$('#settingsbtn').onclick = () => {
  usageNote();
  $<HTMLInputElement>('#rank').checked = rankOn;
  settings.showModal();
};
$('#setclose').onclick = () => settings.close();
settings.addEventListener('click', (e) => { if (e.target === settings) settings.close(); }); // щелчок по затемнённому фону
for (const id of ['#folder', '#cloud', '#diag']) $(id).addEventListener('click', () => settings.close()); // они открывают свои экраны
$('#rank').addEventListener('change', (e) => {
  rankOn = (e.target as HTMLInputElement).checked;
  store.set('rank', rankOn ? '1' : '');
  reshow();
});
$('#resetusage').onclick = () => {
  for (const k of Object.keys(usage)) delete usage[k];
  store.set('usage', '{}');
  usageNote();
  if (rankOn) reshow();
};
$('#resetsizes').onclick = () => { setSide(SIDE.def); setMain(MAIN.def); };

// служба кэширования только в собранной версии (в разработке мешает перезагрузке)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

renderRecent();
start();
(window as unknown as { __dbg: object }).__dbg = { show, call, get state() { return { sources, status, enabled, ready }; } };
