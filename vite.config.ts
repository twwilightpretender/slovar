import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Только для разработки: отдаёт папку со словарями браузеру, чтобы проверять
// весь конвейер без нативного окна выбора папки. В сборку не попадает.
const ROOT = process.env.DICT_ROOT ?? 'F:/словари';
const EXT = /\.(mdx|mdd|dsl|dz|gz|ifo|idx|dict|syn|slob|bgl|gls|zip|css|png|jpe?g|gif|bmp|svg|webp|ico|ttf|otf|woff2?|mp3|wav|ogg|spx|opus)$/i;

function walk(dir: string, rel = ''): { p: string; size: number; mtime: number }[] {
  const out: { p: string; size: number; mtime: number }[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else if (EXT.test(e.name)) {
      const st = fs.statSync(path.join(dir, r));
      out.push({ p: r, size: st.size, mtime: Math.floor(st.mtimeMs) });
    }
  }
  return out;
}

function devDicts(): Plugin {
  return {
    name: 'dev-dicts',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dicts', (req, res) => {
        const u = new URL(req.url ?? '/', 'http://x');
        if (u.pathname === '/list') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(walk(ROOT)));
          return;
        }
        if (u.pathname === '/file') {
          const full = path.resolve(ROOT, u.searchParams.get('p') ?? '');
          if (!full.startsWith(path.resolve(ROOT)) || !fs.existsSync(full)) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader('content-length', fs.statSync(full).size);
          fs.createReadStream(full).pipe(res);
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    },
  };
}

export default defineConfig({
  base: './', // сайт живёт в подпапке (имя.github.io/slovar/), абсолютные пути не годятся
  plugins: [devDicts()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
