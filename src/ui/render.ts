export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const SOUND = /\.(wav|mp3|ogg|oga|flac|aac|m4a|spx|opus)$/i;
const RESFILE = /\.(css|png|jpe?g|gif|bmp|svg|webp|ico|ttf|otf|woff2?|js)$/i;

export interface Prepared {
  body: string; // очищенный HTML; ресурсы помечены data-res / data-snd, ссылки на статьи — data-w
  links: string[]; // таблицы стилей, на которые ссылается статья
  styles: string[]; // содержимое её <style>
}

/**
 * Очистка и подготовка HTML из словаря. Скрипты, формы и внешние адреса убираются; ссылки entry:// и
 * относительные становятся переходами по словарю; картинки и звук запрашиваются у словаря по имени.
 */
export function prepare(html: string): Prepared {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const links: string[] = [];
  const styles: string[] = [];
  doc.querySelectorAll('link').forEach((l) => {
    const rel = (l.getAttribute('rel') ?? '').toLowerCase();
    const href = l.getAttribute('href');
    if (href && rel.includes('stylesheet') && !rel.includes('alternate')) links.push(href);
  });
  doc.querySelectorAll('style').forEach((s) => { if (s.textContent) styles.push(s.textContent); });
  doc.querySelectorAll('script,style,link,meta,base,iframe,object,embed,form,title,noscript,audio,video,source').forEach((e) => e.remove());

  doc.querySelectorAll('font[color]').forEach((f) => ((f as HTMLElement).style.color = f.getAttribute('color')!));
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase(), v = a.value.trim();
      if (n.startsWith('on')) el.removeAttribute(a.name);
      else if (n === 'src') {
        el.removeAttribute(a.name);
        if (/^data:image\//i.test(v)) el.setAttribute('src', v);
        else if (!/^([a-z][a-z0-9+.-]*:)?\/\//i.test(v) && el.tagName === 'IMG') el.setAttribute('data-res', v); // внешние адреса не грузим
      } else if (n === 'srcset' || n === 'poster') el.removeAttribute(a.name);
      else if (n === 'style') {
        if (/url\(|expression|@import/i.test(v)) el.removeAttribute(a.name);
      } else if (n === 'href') {
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v)?.[1]?.toLowerCase();
        const entry = /^(entry|bword):\/*(.*)$/i.exec(v);
        const snd = /^(sound|snd):\/*(.*)$/i.exec(v);
        if (entry) {
          el.setAttribute('data-w', decodeSafe(entry[2].replace(/#.*$/, '')));
          el.removeAttribute('href');
        } else if (snd) {
          el.setAttribute('data-snd', decodeSafe(snd[2]));
          el.removeAttribute('href');
        } else if (scheme === 'http' || scheme === 'https') {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        } else if (scheme || v.startsWith('//') || v.startsWith('#') || !v) {
          if (scheme) el.removeAttribute('href'); // javascript:, file:, data: и т. п.
        } else { // относительная ссылка: звук, ресурс или другая статья
          const clean = v.replace(/#.*$/, '');
          el.removeAttribute('href');
          if (SOUND.test(clean)) el.setAttribute('data-snd', decodeSafe(clean));
          else if (!RESFILE.test(clean) && clean) el.setAttribute('data-w', decodeSafe(clean));
        }
      }
    }
  });
  doc.querySelectorAll('a.ref:not([data-w])').forEach((a) => a.setAttribute('data-w', (a.textContent ?? '').trim())); // ссылки DSL: адрес = текст
  doc.querySelectorAll('img:not([src]):not([data-res])').forEach((e) => e.remove());
  return { body: doc.body.innerHTML, links, styles };
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Цвета без CSS словаря (DSL и др.) подстраиваем под тёмную тему (светлота не ниже 68%). */
export function adaptColors(root: ParentNode, dark: boolean) {
  const probe = document.createElement('span');
  document.body.appendChild(probe);
  root.querySelectorAll<HTMLElement>('[style*="color"]').forEach((el) => {
    if (!el.dataset.c) el.dataset.c = el.style.color;
    if (!dark) { el.style.color = el.dataset.c; return; }
    probe.style.color = el.dataset.c;
    const m = getComputedStyle(probe).color.match(/\d+/g);
    if (!m) return;
    const [r, g, b] = m.map(Number).map((x) => x / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let L = (mx + mn) / 2, h = 0;
    const s = mx === mn ? 0 : L > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
    if (mx !== mn) {
      const d = mx - mn;
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    L = Math.max(L, 0.68);
    el.style.color = `hsl(${h} ${Math.round(s * 100)}% ${Math.round(L * 100)}%)`;
  });
  probe.remove();
}
