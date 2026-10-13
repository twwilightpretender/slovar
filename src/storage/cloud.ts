import { isWanted, type Entry } from './folder';

/*
 * Словари из облака (Яндекс.Диск и Google Диск, публичная ссылка на папку).
 * Файлы один раз скачиваются в хранилище браузера (OPFS) и дальше читаются как обычные:
 * быстро, без сети, индекс строится так же, как для папки на диске.
 * Серверы Яндекса отдают данные браузеру с любого сайта (CORS: *) и умеют докачку по Range.
 * Google Диск: нужен бесплатный ключ API (Drive API v3), ограниченный по адресу сайта.
 */

const API = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const GAPI = 'https://www.googleapis.com/drive/v3/files';
/** Ключ API Google Drive (публичный, ограничен по адресу сайта в Google Cloud Console). Можно переопределить в настройках облака. */
const GOOGLE_KEY = '';

export interface CloudItem {
  path: string; // относительно папки по ссылке, через /
  size: number;
  md5: string;
  modified: string;
  id?: string; // Google: идентификатор файла
}
export interface Progress {
  done: number; // скачано байт
  total: number; // нужно скачать байт
  file: string;
  fileNo: number;
  files: number;
  note?: string; // что сейчас не получается (повторная попытка), чтобы окно не казалось зависшим
}
interface Manifest {
  link: string;
  name: string;
  items: Record<string, CloudItem & { stored: string }>;
}

export const cloudSupported = () => !!(navigator.storage && 'getDirectory' in navigator.storage && 'createWritable' in FileSystemFileHandle.prototype);

/**
 * Ссылка на папку Яндекс.Диска (disk.yandex.ru/d/XXXX, disk.360.yandex.ru, yadi.sk)
 * или Google Диска (drive.google.com/drive/folders/XXXX) → каноническая форма или null.
 */
export function normalizeLink(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (/^(disk(\.360)?\.yandex\.[a-z.]+|yadi\.sk)$/i.test(u.hostname)) {
    const m = u.pathname.match(/^\/([di])\/([\w-]+)/);
    return m ? `https://${u.hostname}/${m[1]}/${m[2]}` : null;
  }
  if (/^(drive|docs)\.google\.com$/i.test(u.hostname)) {
    const m = u.pathname.match(/\/folders\/([\w-]+)/) ?? ('?' + u.searchParams.toString()).match(/[?&]id=([\w-]+)/);
    return m ? `https://drive.google.com/drive/folders/${m[1]}` : null;
  }
  return null;
}
export const isGoogle = (link: string) => link.includes('drive.google.com');
const linkId = (link: string) => isGoogle(link) ? 'g_' + link.replace(/^.*\/folders\//, '') : link.replace(/^.*\/([di])\/([\w-]+).*$/, '$1_$2');

/* ---------- ключ Google ---------- */
export const googleKey = (): string => {
  try { return localStorage.getItem('gkey') || GOOGLE_KEY; } catch { return GOOGLE_KEY; }
};
export const setGoogleKey = (k: string) => { try { localStorage.setItem('gkey', k.trim()); } catch { /* ok */ } };
export const hasBuiltinGoogleKey = !!GOOGLE_KEY;

/* ---------- список файлов ---------- */
async function apiJson(url: string, signal?: AbortSignal): Promise<any> {
  const r = await fetch(url, { signal, referrerPolicy: 'no-referrer' }); // Яндекс отвечает 403 на запросы с Referer сайта github.io
  if (r.status === 404) throw new Error('Ссылка не найдена. Проверьте, что доступ по ссылке включён.');
  if (r.status === 429) throw new Error('Яндекс.Диск просит подождать (слишком много запросов). Повторите через минуту.');
  if (!r.ok) throw new Error('Яндекс.Диск ответил ошибкой ' + r.status);
  return r.json();
}

async function gJson(url: string, signal?: AbortSignal): Promise<any> {
  const r = await fetch(url, { signal, referrerPolicy: 'no-referrer' });
  if (r.ok) return r.json();
  let reason = '';
  try { reason = (await r.json())?.error?.errors?.[0]?.reason ?? ''; } catch { /* без тела */ }
  if (r.status === 404) throw new Error('Папка не найдена или у неё закрыт доступ по ссылке («Все, у кого есть ссылка» → «Читатель»).');
  if (r.status === 400 && /keyInvalid/i.test(reason)) throw new Error('Ключ Google API не подходит. Проверьте, что он скопирован целиком.');
  if (r.status === 403 && /referer|ipRefererBlocked/i.test(reason)) throw new Error('Ключ Google API не разрешён для этого адреса сайта (настройте ограничения по сайтам).');
  if (r.status === 403 && /accessNotConfigured|SERVICE_DISABLED/i.test(reason)) throw new Error('В проекте Google Cloud не включён Google Drive API.');
  if (r.status === 403 && /rateLimit|quota/i.test(reason)) throw new Error('Google просит подождать (лимит запросов). Повторите позже.');
  throw new Error(`Google Диск ответил ошибкой ${r.status}${reason ? ' (' + reason + ')' : ''}`);
}

async function listGoogle(link: string, signal?: AbortSignal): Promise<{ name: string; items: CloudItem[] }> {
  const key = googleKey();
  if (!key) throw new Error('Для Google Диска нужен ключ API (см. настройки облака).');
  const rootId = link.replace(/^.*\/folders\//, '');
  const root = await gJson(`${GAPI}/${rootId}?fields=name,mimeType&supportsAllDrives=true&key=${encodeURIComponent(key)}`, signal);
  const items: CloudItem[] = [];
  const walk = async (id: string, rel: string): Promise<void> => {
    for (let token = ''; ; ) {
      const q = new URLSearchParams({
        q: `'${id}' in parents and trashed=false`,
        fields: 'nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime)',
        pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', key,
      });
      if (token) q.set('pageToken', token);
      const d = await gJson(`${GAPI}?${q}`, signal);
      for (const f of d.files ?? []) {
        const p = rel ? rel + '/' + f.name : f.name;
        if (f.mimeType === 'application/vnd.google-apps.folder') await walk(f.id, p);
        else if (isWanted(f.name)) items.push({ path: p, size: Number(f.size ?? 0), md5: f.md5Checksum ?? '', modified: f.modifiedTime ?? '', id: f.id });
      }
      token = d.nextPageToken ?? '';
      if (!token) break;
    }
  };
  if (root.mimeType !== 'application/vnd.google-apps.folder') throw new Error('Ссылка ведёт не на папку. Вставьте ссылку на папку со словарями.');
  await walk(rootId, '');
  return { name: root.name ?? '', items };
}

/** Все нужные файлы папки (рекурсивно); название папки. */
export async function listCloud(link: string, signal?: AbortSignal): Promise<{ name: string; items: CloudItem[] }> {
  if (isGoogle(link)) return listGoogle(link, signal);
  const items: CloudItem[] = [];
  let rootName = '';
  const walk = async (path: string | null, rel: string): Promise<void> => {
    for (let offset = 0; ; ) {
      const q = new URLSearchParams({ public_key: link, limit: '200', offset: String(offset) });
      if (path) q.set('path', path);
      const d = await apiJson(`${API}?${q}`, signal);
      if (!path) rootName = d.name || '';
      if (d.type === 'file') { // ссылка на один файл
        if (isWanted(d.name)) items.push({ path: d.name, size: d.size, md5: d.md5 ?? '', modified: d.modified ?? '' });
        return;
      }
      const list: any[] = d._embedded?.items ?? [];
      for (const it of list) {
        const p = rel ? rel + '/' + it.name : it.name;
        if (it.type === 'dir') await walk(it.path, p);
        else if (isWanted(it.name)) items.push({ path: p, size: it.size, md5: it.md5 ?? '', modified: it.modified ?? '' });
      }
      const total: number = d._embedded?.total ?? list.length;
      offset += list.length;
      if (!list.length || offset >= total) break;
    }
  };
  await walk(null, '');
  return { name: rootName, items };
}

/* ---------- хранилище (OPFS) ---------- */
async function dirFor(link: string, create = true): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const cloud = await root.getDirectoryHandle('cloud', { create });
  return cloud.getDirectoryHandle(linkId(link), { create });
}
async function readManifest(dir: FileSystemDirectoryHandle): Promise<Manifest | null> {
  try {
    const f = await (await dir.getFileHandle('manifest.json')).getFile();
    return JSON.parse(await f.text());
  } catch {
    return null;
  }
}
async function writeManifest(dir: FileSystemDirectoryHandle, m: Manifest): Promise<void> {
  const w = await (await dir.getFileHandle('manifest.json', { create: true })).createWritable();
  await w.write(JSON.stringify(m));
  await w.close();
}
function storedName(path: string, n: number): string {
  let h = 2166136261; // FNV-1a: короткие имена файлов вместо длинных кириллических путей
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 16777619);
  return 'f' + (h >>> 0).toString(16) + '_' + n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function downloadHref(link: string, item: CloudItem, signal?: AbortSignal): Promise<string> {
  if (isGoogle(link)) return `${GAPI}/${item.id}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(googleKey())}`;
  const q = new URLSearchParams({ public_key: link, path: '/' + item.path });
  return (await apiJson(`${API}/download?${q}`, signal)).href;
}

/** Скачивает файл в OPFS потоком; при обрыве докачивает с места остановки (Range). */
async function fetchToFile(
  link: string, item: CloudItem, dir: FileSystemDirectoryHandle, stored: string,
  onBytes: (n: number) => void, onNote: (msg: string) => void, signal?: AbortSignal,
): Promise<void> {
  const w = await (await dir.getFileHandle(stored, { create: true })).createWritable();
  let written = 0;
  const STALL = 20000;// столько ждём байтов, потом считаем соединение зависшим (Яндекс иногда «подвешивает» поток)
  try {
    for (let attempt = 0; ; attempt++) {
      // отдельная отмена на попытку: зависшее соединение обрываем и докачиваем с места остановки
      const att = new AbortController();
      const onOuter = () => att.abort();
      signal?.addEventListener('abort', onOuter, { once: true });
      let timer = setTimeout(() => att.abort(), STALL);
      const bump = () => { clearTimeout(timer); timer = setTimeout(() => att.abort(), STALL); };
      try {
        const href = await downloadHref(link, item, att.signal);
        bump();
        // без Referer: Яндекс отдаёт 403 (а браузер показывает это как ошибку CORS), если запрос идёт с адреса github.io
        const res = await fetch(href, written ? { headers: { Range: `bytes=${written}-` }, signal: att.signal, referrerPolicy: 'no-referrer' } : { signal: att.signal, referrerPolicy: 'no-referrer' });
        bump();
        if (written && res.status !== 206) { // сервер не умеет докачку: начинаем файл заново
          await w.truncate(0);
          await w.seek(0);
          onBytes(-written);
          written = 0;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const reader = res.body!.getReader();
        let buf: Uint8Array[] = [], bufLen = 0;
        const flush = async () => {
          if (!bufLen) return;
          await w.write(new Blob(buf as BlobPart[]));
          written += bufLen;
          onBytes(bufLen);
          buf = []; bufLen = 0;
        };
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bump();
            buf.push(value); bufLen += value.length;
            if (bufLen >= 4 << 20) await flush();
          }
        } finally {
          await flush(); // сохранить то, что успели получить, даже если поток оборвался
        }
        if (item.size && written < item.size) throw new Error('поток оборвался раньше конца файла');
        break;
      } catch (e) {
        if (signal?.aborted) throw e;
        if (attempt >= 4) throw e;
        onNote(`${item.path.slice(item.path.lastIndexOf('/') + 1)}: ${att.signal.aborted ? 'нет ответа' : (e as Error).message || 'ошибка сети'}, повтор ${attempt + 1} из 4`);
        await sleep(1500 * Math.min(attempt + 1, 4));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onOuter);
      }
    }
    if (item.size && written !== item.size) throw new Error(`размер файла не совпал (${written} из ${item.size})`);
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* уже закрыт */ }
    throw e;
  }
}

/** Что нужно скачать/удалить, чтобы локальная копия совпала с облаком. */
export async function planSync(link: string, remote: { name: string; items: CloudItem[] }) {
  const dir = await dirFor(link);
  const m = await readManifest(dir);
  const have = m?.items ?? {};
  const same = (a: CloudItem, b?: CloudItem) => !!b && a.size === b.size && a.md5 === b.md5 && a.modified === b.modified;
  const todo = remote.items.filter((it) => !same(it, have[it.path]));
  const gone = Object.keys(have).filter((p) => !remote.items.some((it) => it.path === p));
  return { todo, gone, bytes: todo.reduce((s, it) => s + it.size, 0), manifest: m };
}

/** Приводит локальную копию в соответствие с облаком. Манифест обновляется после каждого файла. */
export async function syncCloud(
  link: string, remote: { name: string; items: CloudItem[] }, onProgress: (p: Progress) => void, signal?: AbortSignal,
): Promise<{ path: string; message: string }[]> {
  const dir = await dirFor(link);
  const plan = await planSync(link, remote);
  const m: Manifest = plan.manifest ?? { link, name: remote.name, items: {} };
  m.name = remote.name;
  for (const p of plan.gone) {
    try { await dir.removeEntry(m.items[p].stored); } catch { /* уже нет */ }
    delete m.items[p];
  }
  const queue = [...plan.todo].sort((a, b) => b.size - a.size); // крупные первыми
  let done = 0, fileNo = 0;
  const total = plan.bytes;
  const files = queue.length;
  let last = 0;
  let note = '';
  const report = (file: string, force = false) => {
    const now = performance.now();
    if (force || now - last > 120) { last = now; onProgress({ done, total, file, fileNo, files, note }); }
  };
  await navigator.storage.persist?.().catch(() => false); // просим не вытеснять скачанное
  const failed: { path: string; message: string }[] = [];
  const worker = async () => {
    while (queue.length) {
      const it = queue.shift()!;
      const prev = m.items[it.path];
      const stored = storedName(it.path, (prev ? parseInt(prev.stored.split('_')[1], 10) + 1 : 0));
      try {
        await fetchToFile(link, it, dir, stored, (n) => { done += n; note = ''; report(it.path); }, (msg) => { note = msg; report(it.path, true); }, signal);
      } catch (e) {
        if (signal?.aborted) throw e;
        // один недоступный файл не должен останавливать остальные
        failed.push({ path: it.path, message: (e as Error).message || String(e) });
        try { await dir.removeEntry(stored); } catch { /* недописанный файл уже убран */ }
        continue;
      }
      if (prev) try { await dir.removeEntry(prev.stored); } catch { /* старой копии уже нет */ }
      m.items[it.path] = { ...it, stored };
      fileNo++;
      await writeManifest(dir, m);
      report(it.path, true);
    }
  };
  await Promise.all([worker(), worker()]);
  await writeManifest(dir, m);
  return failed;
}

/** Скачанные файлы как записи для загрузки словарей. null — ничего не скачано. */
export async function cloudEntries(link: string): Promise<{ name: string; entries: Entry[] } | null> {
  let dir: FileSystemDirectoryHandle;
  try { dir = await dirFor(link, false); } catch { return null; }
  const m = await readManifest(dir);
  if (!m) return null;
  const entries: Entry[] = [];
  for (const [path, it] of Object.entries(m.items)) {
    try {
      const f = await (await dir.getFileHandle(it.stored)).getFile();
      const mt = Date.parse(it.modified) || f.lastModified;
      entries.push({ path, file: new File([f], path.slice(path.lastIndexOf('/') + 1), { lastModified: mt }) });
    } catch { /* файл пропал — пересинхронизация его скачает */ }
  }
  return entries.length ? { name: m.name, entries } : null;
}

export async function cloudSizeOnDisk(link: string): Promise<number> {
  const c = await cloudEntries(link);
  return c ? c.entries.reduce((s, e) => s + e.file.size, 0) : 0;
}

export async function clearCloud(link: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try { await (await root.getDirectoryHandle('cloud')).removeEntry(linkId(link), { recursive: true }); } catch { /* нечего удалять */ }
}
