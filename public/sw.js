const CACHE_NAME = 'solax-dashboard-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/icon.svg'
];

self.addEventListener('install', event => {
  // Forcer l'activation immédiate
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
});

self.addEventListener('activate', event => {
  // Supprimer les anciens caches
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // SSE (EventSource) : ne PAS intercepter, laisser le navigateur gérer nativement
  if (url.pathname === '/api/events') {
    return; // pas de respondWith → le navigateur gère le streaming SSE directement
  }

  // Autres requêtes API REST : passer au réseau sans cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Stratégie "Network First" pour les assets statiques :
  // On essaie le réseau d'abord, et si ça échoue on sert le cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Mettre à jour le cache avec la nouvelle version
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseClone);
        });
        return response;
      })
      .catch(() => {
        // Offline : servir depuis le cache
        return caches.match(event.request);
      })
  );
});
