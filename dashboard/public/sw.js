// Log Cannon Service Worker
const CACHE_NAME = 'log-cannon-v1';
const STATIC_CACHE = 'log-cannon-static-v1';

// Static assets to cache on install
const STATIC_ASSETS = [
  '/logo.svg',
  '/logo-icon.svg',
  '/icons/icon.svg',
  '/manifest.json',
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== STATIC_CACHE)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// Fetch event - network first for API, cache first for static
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip API calls - always network first (logs are real-time)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => {
        return new Response(
          JSON.stringify({ error: 'Offline', message: 'Network unavailable' }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      })
    );
    return;
  }

  // Static assets - cache first
  if (STATIC_ASSETS.some((asset) => url.pathname === asset)) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then((response) => {
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(STATIC_CACHE).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        });
      })
    );
    return;
  }

  // Navigation requests - network first with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => {
        return caches.match('/') || new Response(
          `<!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Log Cannon - Offline</title>
            <style>
              * { margin: 0; padding: 0; box-sizing: border-box; }
              body {
                font-family: 'JetBrains Mono', monospace;
                background: #0A0A0B;
                color: #F9FAFB;
                min-height: 100vh;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                padding: 2rem;
                text-align: center;
              }
              .icon { font-size: 4rem; margin-bottom: 1.5rem; }
              h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #FF4D2A; }
              p { color: #9CA3AF; margin-bottom: 2rem; }
              button {
                background: #FF4D2A;
                color: white;
                border: none;
                padding: 0.75rem 1.5rem;
                border-radius: 0.5rem;
                font-family: inherit;
                font-size: 1rem;
                cursor: pointer;
              }
              button:hover { background: #FF6B47; }
            </style>
          </head>
          <body>
            <div class="icon">📡</div>
            <h1>You're Offline</h1>
            <p>Log Cannon requires a network connection to fetch logs.</p>
            <button onclick="location.reload()">Retry Connection</button>
          </body>
          </html>`,
          {
            headers: { 'Content-Type': 'text/html' },
          }
        );
      })
    );
    return;
  }

  // Default - network first
  event.respondWith(
    fetch(request)
      .then((response) => {
        return response;
      })
      .catch(() => {
        return caches.match(request);
      })
  );
});
