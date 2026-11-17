// 1041GR Daily Report — service worker: keeps the app itself on the phone so it opens without signal.
// Bump VERSION whenever any site file changes, so phones pick up the new version.
const VERSION = 'gr1041-v1.3.4';
const SHELL = ['./', 'index.html', 'app.js', 'app.css', 'supabase.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'logo.png', 'logo-white.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // Supabase calls go straight to the network
  if (req.mode === 'navigate') {
    // app page: try the network briefly, fall back to the stored copy
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3500);
        const res = await fetch(req, { signal: ctl.signal }); clearTimeout(t);
        if (res.ok) cache.put('index.html', res.clone());
        return res;
      } catch {
        return (await cache.match('index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
});
