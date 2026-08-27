/**
 * Digital elevation model: int16 grid in a mercator-aligned bbox.
 * Binary layout (little endian): "TER1", uint32 w, uint32 h,
 * float64 west, south, east, north, then w*h int16 meters, row 0 = north.
 */

const D2R = Math.PI / 180
const mercY = (latDeg: number) => {
  const r = latDeg * D2R
  return Math.log(Math.tan(r) + 1 / Math.cos(r))
}

export class TerrainGrid {
  readonly yN: number
  readonly yS: number
  private minMax: [number, number] | null = null

  constructor(
    readonly w: number,
    readonly h: number,
    readonly west: number,
    readonly south: number,
    readonly east: number,
    readonly north: number,
    readonly data: Int16Array,
  ) {
    this.yN = mercY(north)
    this.yS = mercY(south)
  }

  static decode(buf: ArrayBuffer): TerrainGrid {
    const dv = new DataView(buf)
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
    if (magic !== 'TER1') throw new Error('bad terrain file')
    const w = dv.getUint32(4, true)
    const h = dv.getUint32(8, true)
    const west = dv.getFloat64(12, true)
    const south = dv.getFloat64(20, true)
    const east = dv.getFloat64(28, true)
    const north = dv.getFloat64(36, true)
    const data = new Int16Array(buf.slice(44))
    if (data.length !== w * h) throw new Error('terrain size mismatch')
    return new TerrainGrid(w, h, west, south, east, north, data)
  }

  contains(lon: number, lat: number): boolean {
    return lon >= this.west && lon <= this.east && lat >= this.south && lat <= this.north
  }

  /** Bilinear elevation in meters. Clamps outside the bbox. */
  elevAt(lon: number, lat: number): number {
    const { w, h, data } = this
    let fx = ((lon - this.west) / (this.east - this.west)) * (w - 1)
    let fy = ((this.yN - mercY(lat)) / (this.yN - this.yS)) * (h - 1)
    fx = Math.min(Math.max(fx, 0), w - 1.001)
    fy = Math.min(Math.max(fy, 0), h - 1.001)
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const dx = fx - x0
    const dy = fy - y0
    const i = y0 * w + x0
    return (
      data[i] * (1 - dx) * (1 - dy) +
      data[i + 1] * dx * (1 - dy) +
      data[i + w] * (1 - dx) * dy +
      data[i + w + 1] * dx * dy
    )
  }

  get range(): [number, number] {
    if (!this.minMax) {
      let lo = Infinity
      let hi = -Infinity
      for (let i = 0; i < this.data.length; i++) {
        const v = this.data[i]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      this.minMax = [lo, hi]
    }
    return this.minMax
  }

  /**
   * Approximate line-of-sight between two points, each ele meters ASL.
   * Samples the terrain between them; blocked if terrain rises above the
   * sight line by more than `slack` meters at any sample.
   */
  lineOfSight(
    aLon: number,
    aLat: number,
    aEle: number,
    bLon: number,
    bLat: number,
    bEle: number,
    steps = 14,
    slack = 3,
  ): boolean {
    for (let s = 1; s < steps; s++) {
      const t = s / steps
      const lon = aLon + (bLon - aLon) * t
      const lat = aLat + (bLat - aLat) * t
      const sight = aEle + (bEle - aEle) * t
      if (this.elevAt(lon, lat) > sight + slack) return false
    }
    return true
  }
}
