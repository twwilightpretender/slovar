/** Описание словаря, найденного в папке пользователя. */
export interface Source {
  id: string; // относительный путь основного файла
  format: string; // 'mdx' | 'dsl' | 'stardict' | 'slob' | 'bgl' | 'gls'
  folder: string; // папка внутри выбранной (для подписи)
  main: File;
  mdd: File[]; // ресурсы MDict
  aux: Record<string, File>; // соседние файлы по суффиксу (StarDict: idx, dict.dz, syn …; DSL: files.zip)
  res: Record<string, File>; // файлы-ресурсы рядом со словарём (css, картинки, звук) по пути относительно его папки, в нижнем регистре
}

export type DictStatus =
  | { s: 'queued' }
  | { s: 'indexing'; done: number; total: number }
  | { s: 'ready'; count: number; fromCache: boolean; ms: number; title: string; lang?: string }
  | { s: 'skipped'; reason: string }
  | { s: 'error'; reason: string };

export interface Hit {
  h: string; // заголовок как в словаре
  k: string; // ключ поиска
  dicts: number[]; // индексы словарей (в порядке load)
  form?: string; // найдено по этой форме слова (êtes → être): заголовок h — её исходная форма
  mk?: string; // ключ, по которому найдено (служебное)
}

/** Фрагмент статьи: куски текста, у найденных h = 1; l/r — обрезано слева/справа. */
export interface FtSnippet { segs: [string, 0 | 1][]; l: boolean; r: boolean }
export interface FtHit {
  dict: number;
  i: number; // номер статьи в словаре
  h: string; // заголовок
  sn: FtSnippet[]; // фрагменты с найденным
}

export interface ArticlePart {
  dict: number;
  entries: { h: string; html: string }[];
}

export type Req =
  | { t: 'load'; id: number; sources: Source[] }
  | { t: 'search'; id: number; q: string; enabled: boolean[] }
  | { t: 'article'; id: number; h: string; enabled: boolean[] }
  | { t: 'resource'; id: number; dict: number; name: string }
  | { t: 'stats'; id: number }
  | { t: 'clear'; id: number }
  | { t: 'ftsearch'; id: number; q: string; all: boolean; enabled: boolean[]; order: number[] }
  | { t: 'ftcancel'; id: number };

export type Res =
  | { t: 'dict'; idx: number; status: DictStatus }
  | { t: 'loaded'; id: number; total: number; ms: number; phases: { readers: number; keys: number; sort: number; merged?: number } }
  | { t: 'search'; id: number; items: Hit[]; fuzzy: boolean }
  | { t: 'article'; id: number; parts: ArticlePart[] }
  | { t: 'resource'; id: number; mime: string; data: ArrayBuffer | null }
  | { t: 'stats'; id: number; heapMB: number; entries: number; dicts: number }
  | { t: 'cleared'; id: number }
  | { t: 'ft'; id: number; hits: FtHit[]; dict: number; dictNo: number; dictCount: number; done: number; total: number; scanned: number; finished?: boolean; stopped?: boolean; capped?: boolean }
  | { t: 'fail'; id: number; message: string };
