/** Ресурсы статей на стороне страницы: blob-ссылки на картинки/звук и подготовка CSS словарей. */
type Fetcher = (dict: number, name: string) => Promise<{ mime: string; data: ArrayBuffer | null }>;

const BS = String.fromCharCode(92);

function joinPath(base: string, rel: string): string {
  if (rel.startsWith('/')) return rel.slice(1);
  const out: string[] = [];
  for (const part of (base ? base + '/' + rel : rel).split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

async function replaceAsync(s: string, re: RegExp, fn: (m: RegExpExecArray) => Promise<string>): Promise<string> {
  const parts: (string | Promise<string>)[] = [];
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(s)); ) {
    parts.push(s.slice(last, m.index), fn(m));
    last = m.index + m[0].length;
  }
  parts.push(s.slice(last));
  return (await Promise.all(parts)).join('');
}

/**
 * Внутри Shadow DOM нет <html>/<body>/:root — правила словаря про них переносим на корень статьи.
 * Правила внутри @media тоже обрабатываются: «заголовок» перед { разбирается только если это не @-правило.
 */
export function scopeCss(css: string): string {
  const html = new RegExp('(^|[\\s,>+~])(html|body)(?![\\w-])', 'gi');
  return css.replace(/([^{}]+)\{/g, (m, sel: string) => {
    if (sel.trim().startsWith('@')) return m;
    return sel.replace(html, '$1.art').replace(/:root/g, '.art') + '{';
  });
}

export class Resources {
  private urls = new Map<string, Promise<string | null>>();
  private css = new Map<string, Promise<string>>();
  private fontStyle?: HTMLStyleElement;
  constructor(private fetcher: Fetcher) {}

  /** blob-ссылка на ресурс словаря (null — такого ресурса нет). */
  url(dict: number, name: string): Promise<string | null> {
    const k = dict + '\0' + name;
    let p = this.urls.get(k);
    if (!p) {
      p = this.fetcher(dict, name).then((r) => (r.data ? URL.createObjectURL(new Blob([r.data], { type: r.mime })) : null), () => null);
      this.urls.set(k, p);
    }
    return p;
  }

  async text(dict: number, name: string): Promise<string | null> {
    const r = await this.fetcher(dict, name).catch(() => null);
    return r?.data ? new TextDecoder('utf-8').decode(r.data) : null;
  }

  /** Таблица стилей словаря по ссылке из статьи: @import раскрыт, url(...) заменены на blob, внешние адреса убраны. */
  stylesheet(dict: number, href: string, depth = 0): Promise<string> {
    const k = dict + '\0' + href + '\0' + depth;
    let p = this.css.get(k);
    if (!p) {
      p = (async () => {
        const text = await this.text(dict, href);
        return text === null ? '' : this.process(dict, text, dirOf(href.split(BS).join('/')), depth);
      })();
      this.css.set(k, p);
    }
    return p;
  }

  /** CSS из тегов <style> внутри статьи. */
  inline(dict: number, css: string): Promise<string> {
    return this.process(dict, css, '', 0);
  }

  private async process(dict: number, css: string, dir: string, depth: number): Promise<string> {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    css = await replaceAsync(css, /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?[^;]*;/g, async (m) =>
      depth < 3 && !/^(https?:)?\/\//i.test(m[2]) ? this.stylesheet(dict, joinPath(dir, m[2]), depth + 1) : '',
    );
    css = await replaceAsync(css, /url\(\s*(['"]?)([^'")]+)\1\s*\)/g, async (m) => {
      const u = m[2].trim();
      if (/^data:/i.test(u)) return m[0];
      if (/^([a-z]+:)?\/\//i.test(u)) return 'url("")'; // внешние адреса не грузим
      const b = await this.url(dict, joinPath(dir, u));
      return b ? `url("${b}")` : 'url("")';
    });
    css = scopeCss(css);
    this.hoistFonts(css);
    return css;
  }

  /** @font-face внутри Shadow DOM работает не во всех браузерах: дублируем правила в документ. */
  private hoistFonts(css: string) {
    const faces = css.match(/@font-face\s*\{[^}]*\}/g);
    if (!faces) return;
    if (!this.fontStyle) {
      this.fontStyle = document.createElement('style');
      document.head.appendChild(this.fontStyle);
    }
    this.fontStyle.textContent += faces.join('\n');
  }
}
