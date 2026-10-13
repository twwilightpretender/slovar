/** Поиск словарей, которые, вероятно, являются одним и тем же словарём (в разных форматах или версиях). */
export interface DupInfo {
  id: string;
  name: string; // название из самого словаря
  count: number; // число заголовков
}

const normName = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const tokens = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 2));

/**
 * Правила (любое из них объединяет два словаря):
 *  1. одинаковое название;
 *  2. одинаковое число заголовков (от 500);
 *  3. название одного входит в название другого (от 8 знаков), и число заголовков различается не более чем на 2,5%;
 *  4. названия на 60% состоят из одних и тех же слов, и число заголовков различается не более чем на 1%.
 * Результат только предлагается пользователю: решает он.
 */
export function groupDuplicates<T extends DupInfo>(items: T[]): T[][] {
  const parent = items.map((_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };

  const seen = new Map<string, number>();
  items.forEach((x, k) => {
    for (const key of [`n:${normName(x.name)}`, x.count >= 500 ? `c:${x.count}` : '']) {
      if (!key) continue;
      const prev = seen.get(key);
      if (prev === undefined) seen.set(key, k); else union(k, prev);
    }
  });

  const norm = items.map((x) => normName(x.name));
  const tok = items.map((x) => tokens(x.name));
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      if (find(a) === find(b)) continue;
      const hi = Math.max(items[a].count, items[b].count);
      const diff = hi ? Math.abs(items[a].count - items[b].count) / hi : 1;
      const [sh, lg] = norm[a].length <= norm[b].length ? [norm[a], norm[b]] : [norm[b], norm[a]];
      if (sh.length >= 8 && lg.includes(sh) && diff <= 0.025) { union(a, b); continue; }
      const ta = tok[a], tb = tok[b];
      if (ta.size && tb.size && diff <= 0.01 && Math.min(items[a].count, items[b].count) >= 500) {
        let common = 0;
        for (const t of ta) if (tb.has(t)) common++;
        if (common / Math.min(ta.size, tb.size) >= 0.6) union(a, b);
      }
    }
  }

  const groups = new Map<number, T[]>();
  items.forEach((x, k) => { const r = find(k); (groups.get(r) ?? groups.set(r, []).get(r)!).push(x); });
  return [...groups.values()].filter((g) => g.length > 1);
}
