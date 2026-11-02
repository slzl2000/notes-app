'use strict';

// Bump the version only when you want to change the app; otherwise it never updates itself.
const CACHE = 'notes-v2';
const T = 'vendor/tinymce/';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  T + 'tinymce.min.js', T + 'themes/silver/theme.min.js', T + 'models/dom/model.min.js', T + 'icons/default/icons.min.js',
  T + 'plugins/lists/plugin.min.js', T + 'plugins/table/plugin.min.js', T + 'plugins/link/plugin.min.js', T + 'plugins/autolink/plugin.min.js',
  T + 'skins/ui/oxide/skin.min.css', T + 'skins/ui/oxide/content.min.css', T + 'skins/ui/oxide-dark/skin.min.css', T + 'skins/ui/oxide-dark/content.min.css',
  T + 'skins/content/default/content.min.css', T + 'skins/content/dark/content.min.css', T + 'langs/ko_KR.js',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
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
