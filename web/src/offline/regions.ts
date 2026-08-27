/**
 * Offline region packs.
 * Bytes live in the Cache Storage API under one cache per region
 * ("region:<id>"); a small registry in localStorage tracks what is
 * downloaded. Loading is cache-first, so downloaded regions work with the
 * network fully off; un-downloaded regions stream when online.
 */
import type { FeatureCollection } from 'geojson'
import { haversineM, type LonLat } from '../geo/geo'
import type { RouteData, RouteStats } from '../routing/route'
import { TerrainGrid } from '../terrain/terrain'

export interface CatalogRegion {
  id: string
  name: string
  blurb: string
  center: LonLat
  bbox: { south: number; west: number; north: number; east: number }
  bytes: number
  routes: { id: string; name: string; km: number }[]
}

export interface Catalog {
  regions: CatalogRegion[]
}

export interface RouteMeta {
  id: string
  name: string
  blurb: string
  file: string
  arPatch: string
  stats: RouteStats
  start: LonLat
  bytes: number
}

export interface RegionManifest {
  id: string
  name: string
  blurb: string
  version: number
  bbox: { south: number; west: number; north: number; east: number }
  center: LonLat
  attribution: string
  files: Record<string, { path: string; bytes: number } & Record<string, unknown>>
  routes: RouteMeta[]
  bytes: number
}

export interface RegionData {
  manifest: RegionManifest
  trails: FeatureCollection
  pois: FeatureCollection
  contours: FeatureCollection
  terrain: TerrainGrid
  hillshadeUrl: string
  routes: Record<string, RouteData>
  patches: Record<string, TerrainGrid>
}

const REG_KEY = 'trailsight.regions.v1'
const DATA = 'data'

export function regionUrl(id: string, path = '') {
  return `${DATA}/regions/${id}/${path}`
}

type Registry = Record<string, { version: number; bytes: number; at: number }>

export function readRegistry(): Registry {
  try {
    return JSON.parse(localStorage.getItem(REG_KEY) ?? '{}') as Registry
  } catch {
    return {}
  }
}

function writeRegistry(reg: Registry) {
  localStorage.setItem(REG_KEY, JSON.stringify(reg))
}

export function isDownloaded(id: string): boolean {
  return id in readRegistry()
}

/** cache first (offline authority), network fallback */
async function cacheFirst(url: string): Promise<Response> {
  if ('caches' in self) {
    const hit = await caches.match(url, { ignoreSearch: true })
    if (hit) return hit
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`)
  return res
}

/** network first (freshness), cache fallback */
async function networkFirst(url: string): Promise<Response> {
  try {
    const res = await fetch(url, { cache: 'no-cache' })
    if (res.ok) return res
    throw new Error(String(res.status))
  } catch (err) {
    if ('caches' in self) {
      const hit = await caches.match(url, { ignoreSearch: true })
      if (hit) return hit
    }
    throw err
  }
}

export async function fetchCatalog(): Promise<Catalog> {
  const res = await networkFirst(`${DATA}/catalog.json`)
  return (await res.json()) as Catalog
}

export async function fetchManifest(id: string): Promise<RegionManifest> {
  const res = await cacheFirst(regionUrl(id, 'manifest.json'))
  return (await res.json()) as RegionManifest
}

function manifestFileList(m: RegionManifest): { path: string; bytes: number }[] {
  const files: { path: string; bytes: number }[] = [{ path: 'manifest.json', bytes: 2048 }]
  for (const f of Object.values(m.files)) files.push({ path: f.path, bytes: f.bytes })
  for (const r of m.routes) {
    files.push({ path: r.file, bytes: r.bytes })
    const patch = m.files[`patch:${r.id}`]
    if (!patch) files.push({ path: r.arPatch, bytes: 0 })
  }
  return files
}

export async function downloadRegion(
  id: string,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const manifest = await fetchManifest(id)
  const files = manifestFileList(manifest)
  // patch bytes live in route metadata
  for (const f of files) {
    if (f.bytes === 0) {
      const r = manifest.routes.find((rt) => rt.arPatch === f.path)
      const pm = r && (r as unknown as { patchMeta?: { bytes?: number } }).patchMeta
      f.bytes = pm?.bytes ?? 250000
    }
  }
  const total = files.reduce((s, f) => s + f.bytes, 0)
  const cache = await caches.open(`region:${id}`)
  let done = 0
  onProgress(0, total)
  for (const f of files) {
    const url = regionUrl(id, f.path)
    const res = await fetch(url, { cache: 'no-cache' })
    if (!res.ok) throw new Error(`download failed: ${f.path} (${res.status})`)
    if (res.body && 'getReader' in res.body) {
      const reader = res.body.getReader()
      const chunks: BlobPart[] = []
      for (;;) {
        const { value, done: eof } = await reader.read()
        if (eof) break
        if (value) {
          chunks.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer)
          done += value.byteLength
          onProgress(Math.min(done, total), total)
        }
      }
      const blob = new Blob(chunks)
      await cache.put(
        url,
        new Response(blob, {
          headers: {
            'Content-Type': res.headers.get('Content-Type') ?? 'application/octet-stream',
            'Content-Length': String(blob.size),
          },
        }),
      )
    } else {
      await cache.put(url, res.clone())
      done += f.bytes
      onProgress(Math.min(done, total), total)
    }
  }
  const reg = readRegistry()
  reg[id] = { version: manifest.version, bytes: total, at: Date.now() }
  writeRegistry(reg)
  onProgress(total, total)
}

export async function deleteRegion(id: string): Promise<void> {
  await caches.delete(`region:${id}`)
  const reg = readRegistry()
  delete reg[id]
  writeRegistry(reg)
}

export async function loadRegion(id: string): Promise<RegionData> {
  const manifest = await fetchManifest(id)
  const get = (path: string) => cacheFirst(regionUrl(id, path))

  const [trails, pois, contours] = await Promise.all([
    get(manifest.files.trails.path).then((r) => r.json() as Promise<FeatureCollection>),
    get(manifest.files.pois.path).then((r) => r.json() as Promise<FeatureCollection>),
    get(manifest.files.contours.path).then((r) => r.json() as Promise<FeatureCollection>),
  ])
  const terrainBuf = await get(manifest.files.terrain.path).then((r) => r.arrayBuffer())
  const terrain = TerrainGrid.decode(terrainBuf)
  const hillshadeBlob = await get(manifest.files.hillshade.path).then((r) => r.blob())
  const hillshadeUrl = URL.createObjectURL(hillshadeBlob)

  const routes: Record<string, RouteData> = {}
  const patches: Record<string, TerrainGrid> = {}
  for (const rm of manifest.routes) {
    routes[rm.id] = (await get(rm.file).then((r) => r.json())) as RouteData
    try {
      const buf = await get(rm.arPatch).then((r) => r.arrayBuffer())
      patches[rm.id] = TerrainGrid.decode(buf)
    } catch {
      patches[rm.id] = terrain
    }
  }
  return { manifest, trails, pois, contours, terrain, hillshadeUrl, routes, patches }
}

export function nearestRegion(
  catalog: Catalog,
  here: LonLat,
): { region: CatalogRegion; distKm: number } | null {
  let best: { region: CatalogRegion; distKm: number } | null = null
  for (const r of catalog.regions) {
    const d = haversineM(here, r.center) / 1000
    if (!best || d < best.distKm) best = { region: r, distKm: d }
  }
  return best
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const est = await navigator.storage.estimate()
  return { usage: est.usage ?? 0, quota: est.quota ?? 0 }
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('sw register failed', err)
    })
  })
}
