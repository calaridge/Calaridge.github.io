/**
 * service-worker.js
 * Minimal offline shell cache so the app installs as a PWA and opens
 * instantly even on a flaky hospital wifi connection. Does NOT cache
 * any patient data — only the static app shell (HTML/CSS/JS).
 *
 * Note: when launched from within Epic, the SMART launch flow requires
 * network access regardless (to reach Epic's FHIR server), so this
 * mainly benefits the standalone/manual-entry use case.
 */

const CACHE_NAME = 'bc-staging-shell-v1';
const SHELL_FILES = [
  './index.html',
  './launch.html',
  './manifest.json',
  './src/fhir-client.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
});

self.addEventListener('fetch', (event) => {
  // Never cache FHIR API calls or anything outside our own origin —
  // patient data must always be fetched live, never served from cache.
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
