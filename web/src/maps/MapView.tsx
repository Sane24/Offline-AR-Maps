import { useEffect, useRef } from 'react'
import maplibregl, { Map as MLMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature, Point } from 'geojson'
import { useStore } from '../app/store'
import { fmtBytes } from '../ui/format'
import OfflinePanel from '../offline/OfflinePanel'
import { buildStyle, offlineBoundsFC, routeFC, userArrowImage, waypointFC } from './style'

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  const boundsMarkerRef = useRef<maplibregl.Marker | null>(null)
  const region = useStore((s) => s.region)
  const activeRouteId = useStore((s) => s.activeRouteId)
  const regionReady = useStore((s) => {
    const id = s.region?.manifest.id
    return id ? s.regionUI[id]?.state === 'ready' : false
  })
  const routeToPoint = useStore((s) => s.routeToPoint)

  // create map
  useEffect(() => {
    const el = containerRef.current
    if (!el || !region) return
    const route = activeRouteId ? (region.routes[activeRouteId] ?? null) : null
    const map = new maplibregl.Map({
      container: el,
      style: buildStyle(region, route),
      bounds: [
        [region.manifest.bbox.west, region.manifest.bbox.south],
        [region.manifest.bbox.east, region.manifest.bbox.north],
      ],
      fitBoundsOptions: { padding: 40 },
      attributionControl: { compact: true, customAttribution: region.manifest.attribution },
      maxZoom: 17,
      minZoom: 9,
    })
    mapRef.current = map
    // dev aid: repaint manually while the tab is occluded (rAF suppressed),
    // so automated captures see live map state
    let devPump: ReturnType<typeof setInterval> | undefined
    let devRaf = 0
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__map = map
      let lastRaf = performance.now()
      const mark = () => {
        lastRaf = performance.now()
        devRaf = requestAnimationFrame(mark)
      }
      devRaf = requestAnimationFrame(mark)
      devPump = setInterval(() => {
        if (performance.now() - lastRaf > 250) {
          try {
            ;(map as unknown as { _render: (t: number) => void })._render(performance.now())
          } catch {
            /* mid-teardown */
          }
        }
      }, 40)
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right')
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right')

    map.on('styleimagemissing', (e) => {
      if (e.id === 'user-arrow' && !map.hasImage('user-arrow')) {
        map.addImage('user-arrow', userArrowImage())
      }
    })
    map.on('load', () => {
      if (!map.hasImage('user-arrow')) map.addImage('user-arrow', userArrowImage())
      // named POI labels as HTML markers (offline: no glyph server needed)
      const seen = new Set<string>()
      for (const f of region.pois.features) {
        const props = (f.properties ?? {}) as { name?: string; kind?: string }
        if (!props.name || seen.has(props.name)) continue
        if (!['peak', 'landmark', 'viewpoint', 'camp', 'rock', 'guidepost'].includes(props.kind ?? '')) continue
        seen.add(props.name)
        const pt = f as Feature<Point>
        const div = document.createElement('div')
        div.textContent = props.name
        div.style.cssText =
          'font:600 11px Barlow,-apple-system,system-ui,sans-serif;color:#4a3c25;text-shadow:0 0 3px #f0e9d8,0 0 3px #f0e9d8;pointer-events:none;transform:translateY(-12px);white-space:nowrap;'
        const mk = new maplibregl.Marker({ element: div, anchor: 'bottom' })
          .setLngLat(pt.geometry.coordinates as [number, number])
          .addTo(map)
        markersRef.current.push(mk)
      }
    })

    map.on('click', (e) => {
      routeToPoint([e.lngLat.lng, e.lngLat.lat])
    })

    // live user + offroute overlays
    const timer = setInterval(() => {
      if (!map.isStyleLoaded()) return
      const st = useStore.getState()
      const p = st.pose
      const zoom = map.getZoom()
      const mPerPx =
        (156543.03392 * Math.cos((p.lat * Math.PI) / 180)) / Math.pow(2, zoom)
      const user = map.getSource('user') as maplibregl.GeoJSONSource | undefined
      user?.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { heading: p.heading, accPx: Math.min(60, p.accuracy / Math.max(0.01, mPerPx)) },
            geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          },
        ],
      })
      const off = map.getSource('offroute') as maplibregl.GeoJSONSource | undefined
      const o = st.nav?.phase === 'offroute' ? st.nav.offRoute : null
      off?.setData({
        type: 'FeatureCollection',
        features: o
          ? [
              {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'LineString',
                  coordinates: [
                    [p.lon, p.lat],
                    [o.lon, o.lat],
                  ],
                },
              },
            ]
          : [],
      })
    }, 350)

    return () => {
      clearInterval(timer)
      if (devPump) clearInterval(devPump)
      if (devRaf) cancelAnimationFrame(devRaf)
      markersRef.current.forEach((m) => m.remove())
      markersRef.current = []
      boundsMarkerRef.current?.remove()
      boundsMarkerRef.current = null
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region])

  // downloaded-region boundary + label
  useEffect(() => {
    const map = mapRef.current
    if (!map || !region) return
    const apply = () => {
      const src = map.getSource('offline-bounds') as maplibregl.GeoJSONSource | undefined
      src?.setData(offlineBoundsFC(region, regionReady))
      boundsMarkerRef.current?.remove()
      boundsMarkerRef.current = null
      if (regionReady) {
        const div = document.createElement('div')
        div.textContent = `SAVED OFFLINE · ${fmtBytes(region.manifest.bytes)}`
        div.style.cssText =
          "font:600 10px 'Barlow Condensed',-apple-system,system-ui,sans-serif;letter-spacing:0.12em;color:#5c614c;background:rgba(240,233,216,0.85);padding:3px 7px;border:1px solid rgba(92,97,76,0.4);border-radius:4px;pointer-events:none;white-space:nowrap;"
        boundsMarkerRef.current = new maplibregl.Marker({ element: div, anchor: 'top-left', offset: [6, 6] })
          .setLngLat([region.manifest.bbox.west, region.manifest.bbox.north])
          .addTo(map)
      }
    }
    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [region, regionReady])

  // route changes: update sources + fit
  useEffect(() => {
    const map = mapRef.current
    if (!map || !region) return
    const route = activeRouteId ? (region.routes[activeRouteId] ?? null) : null
    const apply = () => {
      const rs = map.getSource('route') as maplibregl.GeoJSONSource | undefined
      rs?.setData(routeFC(route))
      const ws = map.getSource('waypoints') as maplibregl.GeoJSONSource | undefined
      ws?.setData(waypointFC(route))
      if (route) {
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const [x, y] of route.coords) {
          minX = Math.min(minX, x)
          maxX = Math.max(maxX, x)
          minY = Math.min(minY, y)
          maxY = Math.max(maxY, y)
        }
        const wide = window.innerWidth > 760
        map.fitBounds(
          [
            [minX, minY],
            [maxX, maxY],
          ],
          {
            padding: wide
              ? { top: 100, right: 60, bottom: 60, left: 390 }
              : { top: 100, right: 40, bottom: 320, left: 40 },
            duration: 700,
            maxZoom: 15,
          },
        )
      }
    }
    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [region, activeRouteId])

  if (!region) {
    return (
      <div className="map-root">
        <div className="boot-error">
          <div className="panel-box">No region loaded yet. Go online once to fetch the demo region.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="map-root">
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <div className="map-tip">Tap a trail to route there — routing runs on this device</div>
      <OfflinePanel />
    </div>
  )
}
