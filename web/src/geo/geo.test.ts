import { describe, expect, it } from 'vitest'
import {
  angDiffDeg,
  bearingDeg,
  compass16,
  destPoint,
  haversineM,
  lerpAngleDeg,
  LocalFrame,
  simplifyDP,
  wrap360,
} from './geo'

describe('geo', () => {
  it('haversine on a known pair', () => {
    // ~1 degree latitude ~ 111.19 km
    const d = haversineM([-116, 34], [-116, 35])
    expect(d).toBeGreaterThan(110000)
    expect(d).toBeLessThan(112500)
  })

  it('bearings at cardinal directions', () => {
    expect(bearingDeg([0, 0], [0, 1])).toBeCloseTo(0, 3)
    expect(bearingDeg([0, 0], [1, 0])).toBeCloseTo(90, 3)
    expect(bearingDeg([0, 0], [0, -1])).toBeCloseTo(180, 3)
    expect(bearingDeg([0, 0], [-1, 0])).toBeCloseTo(270, 3)
  })

  it('angle differences take the short way', () => {
    expect(angDiffDeg(350, 10)).toBeCloseTo(20)
    expect(angDiffDeg(10, 350)).toBeCloseTo(-20)
    expect(angDiffDeg(0, 180)).toBeCloseTo(-180)
    expect(wrap360(-90)).toBe(270)
    expect(lerpAngleDeg(350, 10, 0.5)).toBeCloseTo(0)
  })

  it('destPoint is consistent with haversine and bearing', () => {
    const from: [number, number] = [-116.13, 34.0]
    const to = destPoint(from, 47, 850)
    expect(haversineM(from, to)).toBeCloseTo(850, 0)
    expect(bearingDeg(from, to)).toBeCloseTo(47, 1)
  })

  it('LocalFrame round trips and measures meters', () => {
    const f = new LocalFrame(-116.13, 34.0)
    const [x, y] = f.toXY(-116.12, 34.01)
    expect(x).toBeGreaterThan(800) // ~923 m east
    expect(y).toBeCloseTo(1105.7, 0)
    const [lon, lat] = f.toLonLat(x, y)
    expect(lon).toBeCloseTo(-116.12, 9)
    expect(lat).toBeCloseTo(34.01, 9)
  })

  it('simplifyDP keeps corners and drops collinear points', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 0.01 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]
    const out = simplifyDP(pts, 1)
    expect(out.length).toBe(3)
    expect(out[1]).toEqual({ x: 10, y: 0 })
  })

  it('compass16 names', () => {
    expect(compass16(0)).toBe('N')
    expect(compass16(44)).toBe('NE')
    expect(compass16(225)).toBe('SW')
    expect(compass16(348.75)).toBe('N')
  })
})
