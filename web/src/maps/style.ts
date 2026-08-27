import type { StyleSpecification } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import type { RegionData } from '../offline/regions'
import type { RouteData } from '../routing/route'

/**
 * Offline topo style: warm paper base, hillshade, contours, rust trails,
 * blaze-orange route. Every layer is served from the region pack; no remote
 * tiles, no remote fonts (text labels are HTML markers).
 */

export const PAPER = '#ece3cf'
export const ROUTE = '#d6551a'
export const CASING = '#f7f2e2'
export const OFFLINE_EDGE = '#7c8265'

export function routeFC(route: RouteData | null): FeatureCollection {
  if (!route) return { type: 'FeatureCollection', features: [] }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: route.coords.map((c) => [c[0], c[1]]) },
      },
    ],
  }
}

export function waypointFC(route: RouteData | null): FeatureCollection {
  if (!route) return { type: 'FeatureCollection', features: [] }
  return {
    type: 'FeatureCollection',
    features: route.waypoints.map((w) => ({
      type: 'Feature',
      properties: {
        kind: w.kind,
        name: w.kind === 'arrive' || w.kind === 'start' ? route.name : (w.name ?? ''),
        maneuver: ['bear', 'turn', 'switchback'].includes(w.kind) ? 1 : 0,
      },
      geometry: {
        type: 'Point',
        coordinates: [
          route.coords[Math.min(w.i, route.coords.length - 1)][0],
          route.coords[Math.min(w.i, route.coords.length - 1)][1],
        ],
      },
    })),
  }
}

/** Region bbox as a polygon, drawn when the pack is stored on the device. */
export function offlineBoundsFC(region: RegionData | null, downloaded: boolean): FeatureCollection {
  if (!region || !downloaded) return { type: 'FeatureCollection', features: [] }
  const b = region.manifest.bbox
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [b.west, b.south],
              [b.east, b.south],
              [b.east, b.north],
              [b.west, b.north],
              [b.west, b.south],
            ],
          ],
        },
      },
    ],
  }
}

export function buildStyle(region: RegionData, route: RouteData | null): StyleSpecification {
  const hs = region.manifest.files.hillshade as unknown as {
    west: number
    south: number
    east: number
    north: number
  }
  return {
    version: 8,
    sources: {
      hillshade: {
        type: 'image',
        url: region.hillshadeUrl,
        coordinates: [
          [hs.west, hs.north],
          [hs.east, hs.north],
          [hs.east, hs.south],
          [hs.west, hs.south],
        ],
      },
      contours: { type: 'geojson', data: region.contours },
      trails: { type: 'geojson', data: region.trails },
      pois: { type: 'geojson', data: region.pois },
      route: { type: 'geojson', data: routeFC(route) },
      waypoints: { type: 'geojson', data: waypointFC(route) },
      'offline-bounds': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      user: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      offroute: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': PAPER } },
      {
        id: 'hillshade',
        type: 'raster',
        source: 'hillshade',
        paint: { 'raster-opacity': 0.62, 'raster-fade-duration': 0 },
      },
      {
        id: 'contour-minor',
        type: 'line',
        source: 'contours',
        filter: ['==', ['get', 'major'], 0],
        paint: { 'line-color': '#b9a888', 'line-width': 0.5, 'line-opacity': 0.75 },
      },
      {
        id: 'contour-major',
        type: 'line',
        source: 'contours',
        filter: ['==', ['get', 'major'], 1],
        paint: { 'line-color': '#a3906c', 'line-width': 1.1, 'line-opacity': 0.85 },
      },
      {
        id: 'offline-fill',
        type: 'fill',
        source: 'offline-bounds',
        paint: { 'fill-color': OFFLINE_EDGE, 'fill-opacity': 0.035 },
      },
      {
        id: 'offline-line',
        type: 'line',
        source: 'offline-bounds',
        paint: {
          'line-color': OFFLINE_EDGE,
          'line-width': 1.4,
          'line-dasharray': [3, 2],
          'line-opacity': 0.85,
        },
      },
      {
        id: 'roads',
        type: 'line',
        source: 'trails',
        filter: ['==', ['get', 'kind'], 'road'],
        paint: { 'line-color': '#8d8577', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 15, 3.5] },
      },
      {
        id: 'tracks',
        type: 'line',
        source: 'trails',
        filter: ['==', ['get', 'kind'], 'track'],
        paint: {
          'line-color': '#7d6a4f',
          'line-width': 1.4,
          'line-dasharray': [4, 2],
        },
      },
      {
        id: 'trails',
        type: 'line',
        source: 'trails',
        filter: ['in', ['get', 'kind'], ['literal', ['trail', 'steps']]],
        paint: {
          'line-color': '#9c5a35',
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 15, 2.2],
          'line-dasharray': [3, 1.6],
        },
      },
      {
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': CASING,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 5, 15, 9],
          'line-opacity': 0.9,
        },
      },
      {
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ROUTE,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2.6, 15, 4.5],
        },
      },
      {
        id: 'wp-maneuver',
        type: 'circle',
        source: 'waypoints',
        filter: ['==', ['get', 'maneuver'], 1],
        paint: {
          'circle-radius': 3.2,
          'circle-color': CASING,
          'circle-stroke-color': ROUTE,
          'circle-stroke-width': 1.6,
        },
      },
      {
        id: 'wp-start',
        type: 'circle',
        source: 'waypoints',
        filter: ['==', ['get', 'kind'], 'start'],
        paint: {
          'circle-radius': 5,
          'circle-color': CASING,
          'circle-stroke-color': '#3a3527',
          'circle-stroke-width': 2,
        },
      },
      {
        id: 'wp-arrive',
        type: 'circle',
        source: 'waypoints',
        filter: ['==', ['get', 'kind'], 'arrive'],
        paint: {
          'circle-radius': 5.5,
          'circle-color': '#5c7046',
          'circle-stroke-color': CASING,
          'circle-stroke-width': 2,
        },
      },
      {
        id: 'wp-poi',
        type: 'circle',
        source: 'waypoints',
        filter: ['all', ['==', ['get', 'maneuver'], 0], ['!', ['in', ['get', 'kind'], ['literal', ['start', 'arrive']]]]],
        paint: {
          'circle-radius': 4.2,
          'circle-color': ROUTE,
          'circle-stroke-color': CASING,
          'circle-stroke-width': 1.6,
        },
      },
      {
        id: 'pois',
        type: 'circle',
        source: 'pois',
        minzoom: 11.2,
        paint: {
          'circle-radius': ['match', ['get', 'kind'], 'peak', 4.4, 'parking', 4, 3],
          'circle-color': [
            'match',
            ['get', 'kind'],
            'peak',
            '#7a4b21',
            'water',
            '#4a7d9c',
            'parking',
            '#5c6474',
            'camp',
            '#4c6e46',
            '#8a6d3f',
          ],
          'circle-stroke-color': '#f5efdf',
          'circle-stroke-width': 1.4,
          'circle-opacity': 0.92,
        },
      },
      {
        id: 'offroute-line',
        type: 'line',
        source: 'offroute',
        paint: { 'line-color': '#c23b22', 'line-width': 2.5, 'line-dasharray': [2, 1.6] },
      },
      {
        id: 'user-acc',
        type: 'circle',
        source: 'user',
        paint: {
          'circle-radius': ['get', 'accPx'],
          'circle-color': 'rgba(58, 53, 39, 0.1)',
          'circle-stroke-color': 'rgba(58, 53, 39, 0.35)',
          'circle-stroke-width': 1,
        },
      },
      {
        id: 'user-dot',
        type: 'symbol',
        source: 'user',
        layout: {
          'icon-image': 'user-arrow',
          'icon-size': 0.55,
          'icon-rotate': ['get', 'heading'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
        },
      },
    ],
  }
}

/** Charcoal position arrow with a paper outline, drawn once as ImageData. */
export function userArrowImage(): ImageData {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const g = c.getContext('2d')!
  g.translate(32, 32)
  g.beginPath()
  g.moveTo(0, -22)
  g.lineTo(15, 16)
  g.lineTo(0, 8)
  g.lineTo(-15, 16)
  g.closePath()
  g.fillStyle = '#33301f'
  g.strokeStyle = '#f7f2e2'
  g.lineWidth = 5
  g.lineJoin = 'round'
  g.stroke()
  g.fill()
  return g.getImageData(0, 0, 64, 64)
}
