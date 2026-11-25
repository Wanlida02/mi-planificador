// Service worker: la app se guarda completa en el dispositivo y se abre desde ahí al instante
// (sin esperar a la red). Al publicar una versión nueva se cambia VERSION: se descarga en segundo
// plano y la página se recarga una vez para usarla.
const VERSION = 'v6';
const CACHE = 'planificador-' + VERSION;
const APP = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png',
  'js/main.js', 'js/store.js', 'js/util.js', 'js/feeds.js', 'js/ics.js', 'js/google.js', 'js/programacion.js', 'js/localfile.js'];
const XLSX = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('planificador-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // navegación → index.html guardado; archivos de la app → caché primero
    const key = req.mode === 'navigate' ? 'index.html' : req;
    e.respondWith(caches.open(CACHE).then((c) => c.match(key, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }))));
    return;
  }
  if (url.href === XLSX) { // librería de Excel: se guarda la primera vez que se usa
    e.respondWith(caches.open('planificador-libs').then((c) => c.match(req).then((hit) => hit || fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }))));
  }
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow('./'))));
});
