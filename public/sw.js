// Service worker for Cook With Me — caches the app shell so the PWA
// opens instantly on repeat visits and shows a meaningful offline page
// instead of the browser's "no internet" dinosaur.

const CACHE = 'cook-v1';
const SHELL = [
  '/',
  '/cook',
  '/kitchen',
  '/login',
  '/manifest.json',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {
      // Non-fatal: caching is best-effort. The app still works online.
    }),
  );
  // Activate immediately so the new worker takes over without a reload.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  // Claim all clients so the new worker controls every open tab immediately.
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only handle navigation requests (page loads) — let API calls and static
  // assets go to the network normally. A navigation that fails (offline)
  // falls back to the cached app shell.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match(event.request).then((cached) => cached ?? caches.match('/')),
      ),
    );
  }
  // For everything else, network-first with cache fallback.
  else {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request)),
    );
  }
});
