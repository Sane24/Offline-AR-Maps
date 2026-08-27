/* TrailSight service worker: offline-first app shell.
 * The precache list is injected at build time by the sw-precache Vite plugin.
 * Region packs are cached separately by the in-app download manager under
 * "region:<id>" caches; caches.match() below searches those too.
 */
const VERSION = 'v1'
const SHELL = `trailsight-shell-${VERSION}`
const PRECACHE = "__PRECACHE_MANIFEST__"

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL)
      const list = Array.isArray(PRECACHE) ? PRECACHE : []
      await cache.addAll(list)
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((n) => n.startsWith('trailsight-shell-') && n !== SHELL)
          .map((n) => caches.delete(n)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return

  // SPA navigations: serve the cached shell, fall back to network
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cached = await caches.match('./index.html', { ignoreSearch: true })
        if (cached) return cached
        return fetch(req)
      })(),
    )
    return
  }

  // everything else: cache-first across all caches (shell + region packs),
  // then network with a shell-cache refresh for same-origin static assets
  event.respondWith(
    (async () => {
      const cached = await caches.match(req, { ignoreSearch: true })
      if (cached) return cached
      const res = await fetch(req)
      return res
    })(),
  )
})
