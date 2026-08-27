import { describe, expect, it } from 'vitest'
import { TerrainGrid } from './terrain'

function encode(w: number, h: number, bbox: [number, number, number, number], vals: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(44 + w * h * 2)
  const dv = new DataView(buf)
  dv.setUint8(0, 84) // T
  dv.setUint8(1, 69) // E
  dv.setUint8(2, 82) // R
  dv.setUint8(3, 49) // 1
  dv.setUint32(4, w, true)
  dv.setUint32(8, h, true)
  dv.setFloat64(12, bbox[0], true)
  dv.setFloat64(20, bbox[1], true)
  dv.setFloat64(28, bbox[2], true)
  dv.setFloat64(36, bbox[3], true)
  const arr = new Int16Array(buf, 44)
  arr.set(vals)
  return buf
}

describe('terrain grid', () => {
  it('decodes and samples bilinearly', () => {
    // 2x2 grid: north row = [100, 200], south row = [300, 400]
    const g = TerrainGrid.decode(encode(2, 2, [-116.2, 34.0, -116.1, 34.05], [100, 200, 300, 400]))
    expect(g.w).toBe(2)
    expect(g.elevAt(-116.2, 34.05)).toBeCloseTo(100, 0)
    expect(g.elevAt(-116.1, 34.05)).toBeCloseTo(200, 0)
    expect(g.elevAt(-116.2, 34.0)).toBeCloseTo(300, 0)
    // midpoint: mercator midpoint is very close to lat midpoint at this scale
    expect(g.elevAt(-116.15, 34.025)).toBeCloseTo(250, 0)
    expect(g.range).toEqual([100, 400])
  })

  it('rejects bad magic', () => {
    const buf = encode(2, 2, [-116.2, 34.0, -116.1, 34.05], [1, 2, 3, 4])
    new DataView(buf).setUint8(0, 88)
    expect(() => TerrainGrid.decode(buf)).toThrow()
  })

  it('line of sight blocked by a ridge', () => {
    // 3x3 grid with a tall middle column; bilinear turns it into a ridge
    const vals = [0, 500, 0, 0, 500, 0, 0, 500, 0]
    const g = TerrainGrid.decode(encode(3, 3, [-116.2, 34.0, -116.0, 34.1], vals))
    // short hop near the west edge, above local terrain (max ~150 m here)
    const clear = g.lineOfSight(-116.19, 34.05, 200, -116.17, 34.05, 200)
    expect(clear).toBe(true)
    // crossing the 500 m ridge at 200 m is blocked
    const blocked = g.lineOfSight(-116.19, 34.05, 200, -116.01, 34.05, 200)
    expect(blocked).toBe(false)
  })
})
