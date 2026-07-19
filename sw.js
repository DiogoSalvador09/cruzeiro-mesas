// Service worker — guarda a "casca" da app para abrir instantâneo.
// Os dados vêm sempre do Firebase (nunca são apanhados por esta cache).
const CACHE = 'cruzeiro-v4';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'store.js', 'firebase-config.js', 'manifest.webmanifest', 'assets/icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // firebase/gstatic passam direto
  if (url.pathname.endsWith('version.json')) return; // verificação de versão: sempre da rede
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match('index.html'))),
  );
});
