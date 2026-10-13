/** Группы словарей и их порядок. Хранится в localStorage; ключ словаря — путь его файла. */
export interface Group {
  id: string;
  name: string;
  collapsed?: boolean;
}
export interface Layout {
  groups: Group[];
  of: Record<string, string>; // словарь → группа
  order: string[]; // порядок словарей (общий)
  scope: string; // '' — все группы, иначе id группы
}

const KEY = 'layout';
const LANG_NAMES: Record<string, string> = {
  fr: 'Французский', de: 'Немецкий', la: 'Латынь', en: 'Английский', ru: 'Русский', other: 'Прочие',
};
const LANG_ORDER = ['fr', 'la', 'de', 'en', 'ru', 'other'];

export function loadLayout(): Layout {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && Array.isArray(v.groups)) return { scope: '', order: [], of: {}, ...v };
  } catch { /* первый запуск */ }
  return { groups: [], of: {}, order: [], scope: '' };
}
export function saveLayout(l: Layout) {
  try { localStorage.setItem(KEY, JSON.stringify(l)); } catch { /* ok */ }
}

const LANG_WORDS: Record<string, string> = {
  fr: 'fr|fra|fre|french|francais|français|franz|französisch|franzosisch',
  de: 'de|deu|ger|german|deutsch',
  la: 'la|lat|latin|latein',
  en: 'en|eng|english|englisch',
  ru: 'ru|rus|russian|russisch',
};
const WORD2LANG = new Map<string, string>();
for (const [l, ws] of Object.entries(LANG_WORDS)) for (const w of ws.split('|')) WORD2LANG.set(w, l);
const ALL = [...WORD2LANG.keys()].sort((a, b) => b.length - a.length).join('|');
const PAIR = new RegExp(`(?<![a-zа-яё])(${ALL})[-_](?:${ALL})(?![a-zа-яё])`, 'i');
const RU_PREFIX: [RegExp, string][] = [
  [/(?<![а-я])фр[а-я]*-/, 'fr'], [/(?<![а-я])нем[а-я]*-/, 'de'], [/(?<![а-я])лат[а-я]*-/, 'la'],
  [/(?<![а-я])англ[а-я]*-/, 'en'], [/(?<![а-я])рус[а-я]*-/, 'ru'],
];
const NAMES: [RegExp, string][] = [
  [/simpson|lewis|redmond|poliachev|дворецк|тананушко|латин|latin|(?<![a-z])lat(?![a-z])|(?<![а-я])лат(?![а-я])/i, 'la'],
  [/grandrobert|robert|littr|trezor|трезор|tlf|nicot|alainrey|dico_af|larousse|лярус|académie|academie|гран робер|истор.* робер/i, 'fr'],
  [/grimm|dwds|kluge|duden|german/i, 'de'],
  [/oxford|оксфорд|webster|вебстер|merriam|cambridge|кэмбридж|camen|pons/i, 'en'],
];

/** Язык заголовков словаря: сначала то, что сообщил сам словарь, затем догадка по имени файла и папки. */
export function guessLang(path: string, declared?: string): string {
  const d = (declared ?? '').toLowerCase();
  for (const [w, l] of WORD2LANG) if (d && (d === w || d.startsWith(w + ' ') || d.startsWith(w + '-'))) return l;
  const m = PAIR.exec(path);
  if (m) return WORD2LANG.get(m[1].toLowerCase()) ?? 'other';
  const low = path.toLowerCase();
  for (const [re, l] of RU_PREFIX) if (re.test(low)) return l;
  for (const [re, l] of NAMES) if (re.test(path)) return l;
  return 'other';
}

/** Новые словари получают группу по языку, остальные остаются там, куда их положил пользователь. */
export function assign(l: Layout, items: { id: string; lang: string }[]) {
  const have = new Set(l.order);
  for (const it of items) {
    if (!l.of[it.id] || !l.groups.some((g) => g.id === l.of[it.id])) {
      const gid = 'auto:' + it.lang;
      if (!l.groups.some((g) => g.id === gid)) insertAutoGroup(l, { id: gid, name: LANG_NAMES[it.lang] ?? it.lang });
      l.of[it.id] = gid;
    }
    if (!have.has(it.id)) { l.order.push(it.id); have.add(it.id); }
  }
}

const autoRank = (id: string) => { const i = LANG_ORDER.indexOf(id.replace('auto:', '')); return i >= 0 ? i : 100; };
/** Новая группа языка встаёт на привычное место среди автоматических; порядок, который расставил пользователь, не трогаем. */
function insertAutoGroup(l: Layout, g: Group) {
  const r = autoRank(g.id);
  let after = -1;
  l.groups.forEach((x, i) => { if (x.id.startsWith('auto:') && autoRank(x.id) <= r) after = i; });
  if (after >= 0) { l.groups.splice(after + 1, 0, g); return; }
  const firstBigger = l.groups.findIndex((x) => x.id.startsWith('auto:') && autoRank(x.id) > r);
  if (firstBigger >= 0) l.groups.splice(firstBigger, 0, g); else l.groups.push(g);
}

/** Переносит группу `id` перед группой `target` (или после неё, если after). */
export function moveGroup(l: Layout, id: string, target: string, after: boolean) {
  if (id === target) return;
  const g = l.groups.find((x) => x.id === id);
  if (!g || !l.groups.some((x) => x.id === target)) return;
  l.groups = l.groups.filter((x) => x.id !== id);
  const at = l.groups.findIndex((x) => x.id === target);
  l.groups.splice(after ? at + 1 : at, 0, g);
}

/** Сдвигает группу на соседнее место среди показанных групп (`visible` — их id по порядку). */
export function shiftGroup(l: Layout, id: string, delta: -1 | 1, visible: string[]) {
  const i = visible.indexOf(id);
  const neighbour = visible[i + delta];
  if (i >= 0 && neighbour) moveGroup(l, id, neighbour, delta > 0);
}

/** Переносит словарь `id` в группу `gid` перед словарём `before` (или в конец группы). */
export function move(l: Layout, id: string, gid: string, before: string | null) {
  l.order = l.order.filter((x) => x !== id);
  l.of[id] = gid;
  const at = before ? l.order.indexOf(before) : -1;
  if (at >= 0) l.order.splice(at, 0, id);
  else l.order.push(id);
}

export function newGroupId(): string {
  return 'g' + Date.now().toString(36);
}
