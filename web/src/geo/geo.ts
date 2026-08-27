/**
 * Geodesy helpers. Distances in meters, angles in degrees unless noted.
 * Headings are compass bearings: 0 = north, clockwise positive.
 */

export type LonLat = [number, number]

export interface Pose {
  lon: number
  lat: number
  ele: number
  /** compass heading in degrees, 0 = north, clockwise */
  heading: number
  /** camera pitch in degrees, 0 = level, positive looking up */
  pitch: number
  /** horizontal accuracy in meters */
  accuracy: number
  speedMps: number
  ts: number
}

export const EARTH_R = 6371000
const D2R = Math.PI / 180
const R2D = 180 / Math.PI

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const wrap360 = (deg: number) => ((deg % 360) + 360) % 360

/** Signed smallest rotation from `from` to `to`, in [-180, 180). */
export const angDiffDeg = (from: number, to: number) => ((to - from + 540) % 360) - 180

/** Interpolate compass angles along the shortest arc. */
export const lerpAngleDeg = (a: number, b: number, t: number) => wrap360(a + angDiffDeg(a, b) * t)

export function haversineM(a: LonLat, b: LonLat): number {
  const p1 = a[1] * D2R
  const p2 = b[1] * D2R
  const dp = p2 - p1
  const dl = (b[0] - a[0]) * D2R
  const s = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.sqrt(s))
}

export function bearingDeg(a: LonLat, b: LonLat): number {
  const p1 = a[1] * D2R
  const p2 = b[1] * D2R
  const dl = (b[0] - a[0]) * D2R
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return wrap360(Math.atan2(y, x) * R2D)
}

export function destPoint(a: LonLat, brgDeg: number, distM: number): LonLat {
  const br = brgDeg * D2R
  const d = distM / EARTH_R
  const p1 = a[1] * D2R
  const l1 = a[0] * D2R
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br))
  const l2 =
    l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2))
  return [wrap360(l2 * R2D + 180) - 180, p2 * R2D]
}

/**
 * Flat local frame around a reference point. Good to well under 0.1% error
 * at region scale (tens of km). x = meters east, y = meters north.
 */
export class LocalFrame {
  readonly kx: number
  readonly ky: number
  constructor(
    readonly lon0: number,
    readonly lat0: number,
  ) {
    this.kx = 111320 * Math.cos(lat0 * D2R)
    this.ky = 110574
  }
  toXY(lon: number, lat: number): [number, number] {
    return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky]
  }
  toLonLat(x: number, y: number): LonLat {
    return [this.lon0 + x / this.kx, this.lat0 + y / this.ky]
  }
}

export interface XY {
  x: number
  y: number
}

/** Project p onto segment ab. Returns clamped t and squared distance. */
export function projectOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { t: number; x: number; y: number; d2: number } {
  const dx = bx - ax
  const dy = by - ay
  const seg2 = dx * dx + dy * dy
  let t = 0
  if (seg2 > 0) t = clamp(((px - ax) * dx + (py - ay) * dy) / seg2, 0, 1)
  const x = ax + t * dx
  const y = ay + t * dy
  const ex = px - x
  const ey = py - y
  return { t, x, y, d2: ex * ex + ey * ey }
}

/** Douglas-Peucker simplification on planar points (units = tol units). */
export function simplifyDP<T extends XY>(pts: T[], tol: number): T[] {
  if (pts.length < 3) return pts.slice()
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack: Array<[number, number]> = [[0, pts.length - 1]]
  const tol2 = tol * tol
  while (stack.length) {
    const [i0, i1] = stack.pop()!
    let dmax = -1
    let imax = -1
    for (let i = i0 + 1; i < i1; i++) {
      const pr = projectOnSegment(pts[i].x, pts[i].y, pts[i0].x, pts[i0].y, pts[i1].x, pts[i1].y)
      if (pr.d2 > dmax) {
        dmax = pr.d2
        imax = i
      }
    }
    if (dmax > tol2 && imax > 0) {
      keep[imax] = 1
      stack.push([i0, imax], [imax, i1])
    }
  }
  const out: T[] = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i])
  return out
}

/** 16-wind compass name for a bearing. */
export function compass16(deg: number): string {
  const names = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
  ]
  return names[Math.round(wrap360(deg) / 22.5) % 16]
}
