// Служба кэширования: хранит только сам сайт (код, стили, значки), словари не трогает.
// Страница (index.html): сначала сеть, при её отсутствии кэш, так что новая версия
// подхватывается при ближайшем открытии. Файлы в assets/ имеют хэш в имени и не меняются.
const CACHE = 'slovar-shell-v3';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // главная страница кэшируется под ключом './', остальные (справка) под своим адресом
    const isHome = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(isHome ? './' : req, copy));
          return res;
        })
        .catch(() => caches.match(isHome ? './' : req).then((r) => r || Response.error())),
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    }),
  );
});
