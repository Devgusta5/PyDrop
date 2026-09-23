/**
 * PyDrop service worker — app shell only.
 *
 * SECURITY: this worker must never cache transferred data or API traffic.
 * File bytes never travel over HTTP at all (they go peer-to-peer over the WebRTC
 * DataChannel, which a service worker cannot intercept), and every same-origin
 * API path is explicitly excluded below. What is cached is exactly the static
 * shell needed to open the app: HTML, JS, CSS and icons.
 *
 * Strategy:
 *   navigation  -> network-first, cache fallback  (never serve a stale build)
 *   static asset -> cache-first                    (hashed filenames, safe)
 *   everything else -> untouched
 */

const VERSION = 'pydrop-shell-v2'
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/pydrop-icon-192.png', '/pydrop-icon-512.png']

/** Paths that must always hit the network. Room state is never stale-servable. */
const NEVER_CACHE = ['/rooms', '/health', '/stats']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      // A missing optional asset must not fail the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((path) => cache.add(path))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      // Hashed asset filenames change every build, so yesterday's entries are
      // dead weight that can also resurrect an old shell. Keep only the HTML.
      .then(() => caches.open(VERSION))
      .then((cache) =>
        cache.keys().then((requests) =>
          Promise.all(
            requests
              .filter((request) => /\/assets\//.test(new URL(request.url).pathname))
              .map((request) => cache.delete(request)),
          ),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Cross-origin (the API on Render, Google Fonts) is left entirely alone.
  if (url.origin !== self.location.origin) return

  // Signaling and room endpoints: never cached, never intercepted.
  if (NEVER_CACHE.some((path) => url.pathname.startsWith(path))) return

  // Navigations: network first so a deploy is picked up immediately; fall back to
  // the cached shell only when the network genuinely fails.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Only a genuine 200 is worth keeping: caching an error page would
          // pin the app to that error for every later offline load.
          if (response.ok) {
            const copy = response.clone()
            caches.open(VERSION).then((cache) => cache.put('/index.html', copy))
          }
          return response
        })
        .catch(() => caches.match('/index.html').then((cached) => cached ?? Response.error())),
    )
    return
  }

  // Build assets are content-hashed, so cache-first is safe and fast.
  if (/\.(?:js|css|woff2?|png|svg|webp|ico)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone()
              caches.open(VERSION).then((cache) => cache.put(request, copy))
            }
            return response
          }),
      ),
    )
  }
})
