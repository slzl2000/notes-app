'use strict';

// Bump the version only when you want to change the app; otherwise it never updates itself.
const CACHE = 'notes-v54';
const T = 'vendor/tinymce/';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'vault.js', 'todo.js', 'manifest.webmanifest', 'icon-v3-180.png', 'icon-v3-192.png', 'icon-v3-512.png',
  T + 'tinymce.min.js', T + 'themes/silver/theme.min.js', T + 'models/dom/model.min.js', T + 'icons/default/icons.min.js',
  T + 'plugins/lists/plugin.min.js', T + 'plugins/table/plugin.min.js', T + 'plugins/link/plugin.min.js', T + 'plugins/autolink/plugin.min.js',
  T + 'skins/ui/oxide/skin.min.css', T + 'skins/ui/oxide/content.min.css', T + 'skins/ui/oxide-dark/skin.min.css', T + 'skins/ui/oxide-dark/content.min.css',
  T + 'skins/content/default/content.min.css', T + 'skins/content/dark/content.min.css', T + 'langs/ko_KR.js',
];

const STAMPED = ['index.html', 'style.css', 'app.js', 'vault.js', 'todo.js'];

self.addEventListener('install', event => {
  // Skip the browser and CDN caches, or a new version can be stored with last version's files.
  const fresh = FILES.map(file => new Request(`${file}?v=${CACHE}`, { cache: 'reload' }));
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(fresh);
    // Right after a release the server can still hand out the old files. Each of these carries
    // its version; if any does not match, nothing is kept and the browser tries again later.
    for (const file of STAMPED) {
      const hit = await cache.match(`${file}?v=${CACHE}`);
      if (!hit || !(await hit.text()).includes(CACHE)) {
        await caches.delete(CACHE);
        throw new Error(`${file} is not ${CACHE} yet`);
      }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/mock/')) return;
  event.respondWith(caches.match(event.request, { ignoreSearch: true }).then(hit => hit || fetch(event.request)));
});
