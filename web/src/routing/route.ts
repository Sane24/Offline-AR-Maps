import { LocalFrame, projectOnSegment, bearingDeg, type LonLat } from '../geo/geo'

export type WaypointKind =
  | 'start'
  | 'arrive'
  | 'bear'
  | 'turn'
  | 'switchback'
  | 'peak'
  | 'saddle'
  | 'viewpoint'
  | 'water'
  | 'landmark'
  | 'guidepost'

export interface Waypoint {
  /** index into route coords */
  i: number
  kind: WaypointKind | string
  name?: string
  instruction: string
  dir?: 'left' | 'right'
}

export interface RouteStats {
  lengthM: number
  gainM: number
  lossM: number
  minEle: number
  maxEle: number
  estMin: number
}

export interface RouteData {
  id: string
  region?: string
  name: string
  blurb?: string
  loop?: boolean
  /** [lon, lat, ele][] resampled at ~12 m */
  coords: [number, number, number][]
  /** cumulative distance in meters, same length as coords */
  cum: number[]
  waypoints: Waypoint[]
  stats: RouteStats
  arPatch?: string
}

export interface PreparedRoute extends RouteData {
  frame: LocalFrame
  /** local xy pairs, length 2n */
  xy: Float64Array
  /** remaining climb from each vertex to the end */
  remGain: Float64Array
}

export function prepareRoute(r: RouteData): PreparedRoute {
  const frame = new LocalFrame(r.coords[0][0], r.coords[0][1])
  const n = r.coords.length
  const xy = new Float64Array(n * 2)
  for (let i = 0; i < n; i++) {
    const [x, y] = frame.toXY(r.coords[i][0], r.coords[i][1])
    xy[i * 2] = x
    xy[i * 2 + 1] = y
  }
  const remGain = new Float64Array(n)
  for (let i = n - 2; i >= 0; i--) {
    const d = r.coords[i + 1][2] - r.coords[i][2]
    remGain[i] = remGain[i + 1] + (d > 0 ? d : 0)
  }
  return { ...r, frame, xy, remGain }
}

export interface Snap {
  seg: number
  t: number
  alongM: number
  /** perpendicular distance from position to route, meters */
  offM: number
  lon: number
  lat: number
}

export function snapToRoute(r: PreparedRoute, lon: number, lat: number): Snap {
  const [px, py] = r.frame.toXY(lon, lat)
  const { xy } = r
  const n = r.coords.length
  let best = { d2: Infinity, seg: 0, t: 0, x: 0, y: 0 }
  for (let i = 0; i < n - 1; i++) {
    const pr = projectOnSegment(px, py, xy[i * 2], xy[i * 2 + 1], xy[i * 2 + 2], xy[i * 2 + 3])
    if (pr.d2 < best.d2) best = { d2: pr.d2, seg: i, t: pr.t, x: pr.x, y: pr.y }
  }
  const segLen = r.cum[best.seg + 1] - r.cum[best.seg]
  const alongM = r.cum[best.seg] + segLen * best.t
  const [slon, slat] = r.frame.toLonLat(best.x, best.y)
  return { seg: best.seg, t: best.t, alongM, offM: Math.sqrt(best.d2), lon: slon, lat: slat }
}

export interface AlongPoint {
  lon: number
  lat: number
  ele: number
  bearing: number
  seg: number
}

/** Point at a given distance along the route (clamped). */
export function pointAtAlong(r: RouteData, m: number): AlongPoint {
  const cum = r.cum
  const n = cum.length
  const target = Math.min(Math.max(m, 0), cum[n - 1])
  // binary search for segment
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= target) lo = mid
    else hi = mid
  }
  const segLen = cum[hi] - cum[lo] || 1
  const t = (target - cum[lo]) / segLen
  const a = r.coords[lo]
  const b = r.coords[hi]
  const lon = a[0] + (b[0] - a[0]) * t
  const lat = a[1] + (b[1] - a[1]) * t
  const ele = a[2] + (b[2] - a[2]) * t
  const brg = bearingDeg([a[0], a[1]], [b[0], b[1]])
  return { lon, lat, ele, bearing: brg, seg: lo }
}

export function routeBounds(r: RouteData): { west: number; south: number; east: number; north: number } {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const [lon, lat] of r.coords) {
    if (lon < west) west = lon
    if (lon > east) east = lon
    if (lat < south) south = lat
    if (lat > north) north = lat
  }
  return { west, south, east, north }
}

export function waypointLonLat(r: RouteData, wp: Waypoint): LonLat {
  const c = r.coords[Math.min(wp.i, r.coords.length - 1)]
  return [c[0], c[1]]
}
