import type { Source } from '../core/protocol';

export interface Entry {
  path: string; // относительно выбранной папки, через /
  file: File;
}

const RES = /\.(css|png|jpe?g|gif|bmp|svg|webp|ico|ttf|otf|woff2?|mp3|wav|ogg|spx|opus)$/i; // ресурсы статей рядом со словарём
const WANTED = new RegExp(/\.(mdx|mdd|dsl|dz|gz|ifo|idx|dict|syn|slob|bgl|gls|zip)$/i.source + '|' + RES.source, 'i');

export const isWanted = (name: string) => WANTED.test(name);

/* ---------- запомненная папка (только Chrome/Edge) ---------- */
function kv(): Promise<IDBDatabase> {
  return new Promise((ok, no) => {
    const r = indexedDB.open('slovar-app', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}
export async function saveHandle(h: FileSystemDirectoryHandle): Promise<void> {
  try {
    const d = await kv();
    d.transaction('kv', 'readwrite').objectStore('kv').put(h, 'dir');
  } catch {
    /* без запоминания папки приложение работает */
  }
}
export async function loadHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    const d = await kv();
    return await new Promise((ok) => {
      const r = d.transaction('kv').objectStore('kv').get('dir');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ok(undefined);
    });
  } catch {
    return undefined;
  }
}

export const canPick = () => 'showDirectoryPicker' in window;

export async function pickFolder(): Promise<FileSystemDirectoryHandle> {
  return (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({
    id: 'slovar',
    mode: 'read',
  });
}

type PermHandle = FileSystemDirectoryHandle & {
  queryPermission(o: object): Promise<PermissionState>;
  requestPermission(o: object): Promise<PermissionState>;
};
export async function hasAccess(h: FileSystemDirectoryHandle): Promise<boolean> {
  return (await (h as PermHandle).queryPermission({ mode: 'read' })) === 'granted';
}
export async function askAccess(h: FileSystemDirectoryHandle): Promise<boolean> {
  return (await (h as PermHandle).requestPermission({ mode: 'read' })) === 'granted';
}

/* ---------- обход ---------- */
export async function walkHandle(dir: FileSystemDirectoryHandle, rel = ''): Promise<Entry[]> {
  const out: Entry[] = [];
  const it = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
  for await (const [name, h] of it) {
    const p = rel ? rel + '/' + name : name;
    if (h.kind === 'directory') out.push(...(await walkHandle(h as FileSystemDirectoryHandle, p)));
    else if (WANTED.test(name)) out.push({ path: p, file: await (h as FileSystemFileHandle).getFile() });
  }
  return out;
}

/** Запасной путь для Safari/Firefox: <input webkitdirectory>. */
export function fromFileList(files: FileList): Entry[] {
  const out: Entry[] = [];
  for (const f of Array.from(files)) {
    const full = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const path = full.includes('/') ? full.slice(full.indexOf('/') + 1) : full; // без имени корня
    if (WANTED.test(f.name)) out.push({ path, file: f });
  }
  return out;
}

/** Перетаскивание папки на страницу. */
export async function fromDrop(dt: DataTransfer): Promise<Entry[]> {
  const out: Entry[] = [];
  type FsEntry = { isFile: boolean; isDirectory: boolean; name: string; file?: (cb: (f: File) => void, e: (x: unknown) => void) => void; createReader?: () => { readEntries(cb: (e: FsEntry[]) => void, err: (x: unknown) => void): void } };
  const visit = async (e: FsEntry, rel: string): Promise<void> => {
    if (e.isFile && WANTED.test(e.name)) {
      const f = await new Promise<File>((ok, no) => e.file!(ok, no));
      out.push({ path: rel + e.name, file: f });
    } else if (e.isDirectory) {
      const rd = e.createReader!();
      for (;;) {
        const batch = await new Promise<FsEntry[]>((ok, no) => rd.readEntries(ok, no));
        if (!batch.length) break;
        for (const c of batch) await visit(c, rel + e.name + '/');
      }
    }
  };
  const roots: FsEntry[] = [];
  for (const it of Array.from(dt.items)) {
    const e = (it as DataTransferItem & { webkitGetAsEntry(): FsEntry | null }).webkitGetAsEntry();
    if (e) roots.push(e);
  }
  // одна перетащенная папка — это корень; несколько — каждая сохраняет своё имя
  if (roots.length === 1 && roots[0].isDirectory) {
    const rd = roots[0].createReader!();
    for (;;) {
      const batch = await new Promise<FsEntry[]>((ok, no) => rd.readEntries(ok, no));
      if (!batch.length) break;
      for (const c of batch) await visit(c, '');
    }
  } else for (const r of roots) await visit(r, '');
  return out;
}

/* ---------- файлы → словари ---------- */
const MAIN: [RegExp, string][] = [
  [/\.mdx$/i, 'mdx'],
  [/\.dsl(\.dz)?$/i, 'dsl'],
  [/\.ifo$/i, 'stardict'],
  [/\.slob$/i, 'slob'],
  [/\.bgl$/i, 'bgl'],
  [/\.gls$/i, 'gls'],
];

export function groupSources(entries: Entry[]): Source[] {
  const byPath = new Map(entries.map((e) => [e.path, e.file]));
  const resEntries = entries.filter((e) => RES.test(e.path));
  /** Ресурсы в папке словаря и её подпапках: ключ — путь внутри папки, в нижнем регистре. */
  const resourcesIn = (folder: string): Record<string, File> => {
    const out: Record<string, File> = {};
    const pre = folder ? folder + '/' : '';
    for (const r of resEntries) if (r.path.startsWith(pre)) out[r.path.slice(pre.length).toLowerCase()] = r.file;
    return out;
  };
  const out: Source[] = [];
  for (const e of entries) {
    const fmt = MAIN.find(([re]) => re.test(e.path));
    if (!fmt) continue;
    if (fmt[1] === 'dsl' && /_abrv\.dsl(\.dz)?$/i.test(e.path)) continue; // словарь сокращений — не отдельный
    const slash = e.path.lastIndexOf('/');
    const base = e.path.replace(/\.[^./]+$/, '');
    const mdd: File[] = [];
    if (fmt[1] === 'mdx') {
      const first = byPath.get(base + '.mdd');
      if (first) mdd.push(first);
      for (let i = 1; byPath.has(`${base}.${i}.mdd`); i++) mdd.push(byPath.get(`${base}.${i}.mdd`)!);
    }
    const aux: Record<string, File> = {};
    if (fmt[1] === 'dsl') { // ресурсы DSL: «слов.dsl.files.zip» (или «слов.dsl.dz.files.zip»)
      const z = byPath.get(e.path + '.files.zip') ?? byPath.get(e.path.replace(/\.dz$/i, '') + '.files.zip');
      if (z) aux['files.zip'] = z;
    }
    if (fmt[1] === 'stardict') {
      for (const sfx of ['idx', 'idx.gz', 'idx.dz', 'dict', 'dict.dz', 'syn', 'syn.dz', 'syn.gz']) {
        const f = byPath.get(base + '.' + sfx);
        if (f) aux[sfx] = f;
      }
    }
    const folder = slash < 0 ? '' : e.path.slice(0, slash);
    out.push({ id: e.path, format: fmt[1], folder, main: e.file, mdd, aux, res: resourcesIn(folder) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id, 'ru'));
}
