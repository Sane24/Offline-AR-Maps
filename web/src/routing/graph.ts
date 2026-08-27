/**
 * Offline routing over the region's trail network.
 * Ways are split at shared junction coordinates into edges; Dijkstra runs
 * between virtual points snapped onto the nearest edges. Fully on-device.
 */
import type { Feature, FeatureCollection, LineString } from 'geojson'
import {
  LocalFrame,
  bearingDeg,
  angDiffDeg,
  haversineM,
  projectOnSegment,
  simplifyDP,
  type LonLat,
} from '../geo/geo'
import type { RouteData, Waypoint } from './route'
import type { TerrainGrid } from '../terrain/terrain'

export interface GEdge {
  id: number
  a: string
  b: string
  coords: LonLat[]
  lenM: number
  kind: string
  name?: string
}

export interface TrailGraph {
  nodes: Map<string, { lon: number; lat: number; edges: number[] }>
  edges: GEdge[]
}

const keyOf = (lon: number, lat: number) => `${lon.toFixed(5)},${lat.toFixed(5)}`

export function buildGraph(fc: FeatureCollection): TrailGraph {
  const lines = fc.features.filter(
    (f): f is Feature<LineString> => f.geometry?.type === 'LineString',
  )
  // pass 1: which coords are junctions (appear in more than one place)
  const seen = new Map<string, number>()
  for (const f of lines) {
    const coords = f.geometry.coordinates
    for (let i = 0; i < coords.length; i++) {
      const k = keyOf(coords[i][0], coords[i][1])
      seen.set(k, (seen.get(k) ?? 0) + 1)
    }
  }
  const graph: TrailGraph = { nodes: new Map(), edges: [] }
  const addNode = (lon: number, lat: number) => {
    const k = keyOf(lon, lat)
    if (!graph.nodes.has(k)) graph.nodes.set(k, { lon, lat, edges: [] })
    return k
  }
  for (const f of lines) {
    const coords = f.geometry.coordinates as unknown as LonLat[]
    if (coords.length < 2) continue
    const kind = (f.properties as Record<string, string>)?.kind ?? 'trail'
    const name = (f.properties as Record<string, string>)?.name
    let segStart = 0
    for (let i = 1; i < coords.length; i++) {
      const isEnd = i === coords.length - 1
      const isJunction = (seen.get(keyOf(coords[i][0], coords[i][1])) ?? 0) > 1
      if (!isEnd && !isJunction) continue
      const piece = coords.slice(segStart, i + 1)
      let lenM = 0
      for (let j = 0; j < piece.length - 1; j++) lenM += haversineM(piece[j], piece[j + 1])
      if (lenM > 0.5) {
        const a = addNode(piece[0][0], piece[0][1])
        const b = addNode(piece[piece.length - 1][0], piece[piece.length - 1][1])
        const id = graph.edges.length
        graph.edges.push({ id, a, b, coords: piece, lenM, kind, name })
        graph.nodes.get(a)!.edges.push(id)
        graph.nodes.get(b)!.edges.push(id)
      }
      segStart = i
    }
  }
  return graph
}

export interface EdgeSnap {
  edge: GEdge
  /** index of segment within edge coords */
  seg: number
  t: number
  point: LonLat
  distM: number
  /** distance along the edge to the snap point */
  alongM: number
}

export function nearestOnGraph(g: TrailGraph, p: LonLat, maxM = 400): EdgeSnap | null {
  const frame = new LocalFrame(p[0], p[1])
  const [px, py] = frame.toXY(p[0], p[1])
  let best: EdgeSnap | null = null
  let bestD2 = maxM * maxM
  for (const e of g.edges) {
    // cheap bbox reject in degrees (~maxM)
    for (let i = 0; i < e.coords.length - 1; i++) {
      const [ax, ay] = frame.toXY(e.coords[i][0], e.coords[i][1])
      const [bx, by] = frame.toXY(e.coords[i + 1][0], e.coords[i + 1][1])
      if (Math.min(ax, bx) > maxM || Math.max(ax, bx) < -maxM) continue
      if (Math.min(ay, by) > maxM || Math.max(ay, by) < -maxM) continue
      const pr = projectOnSegment(px, py, ax, ay, bx, by)
      if (pr.d2 < bestD2) {
        bestD2 = pr.d2
        const point = frame.toLonLat(pr.x, pr.y)
        best = { edge: e, seg: i, t: pr.t, point, distM: Math.sqrt(pr.d2), alongM: 0 }
      }
    }
  }
  if (best) {
    let along = 0
    for (let i = 0; i < best.seg; i++) along += haversineM(best.edge.coords[i], best.edge.coords[i + 1])
    along += haversineM(best.edge.coords[best.seg], best.edge.coords[best.seg + 1]) * best.t
    best.alongM = along
  }
  return best
}

class MinHeap {
  keys: string[] = []
  costs: number[] = []
  push(k: string, c: number) {
    this.keys.push(k)
    this.costs.push(c)
    let i = this.keys.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.costs[p] <= this.costs[i]) break
      this.swap(i, p)
      i = p
    }
  }
  pop(): [string, number] | null {
    const n = this.keys.length
    if (n === 0) return null
    const top: [string, number] = [this.keys[0], this.costs[0]]
    this.swap(0, n - 1)
    this.keys.pop()
    this.costs.pop()
    let i = 0
    const m = this.keys.length
    for (;;) {
      const l = i * 2 + 1
      const r = l + 1
      let s = i
      if (l < m && this.costs[l] < this.costs[s]) s = l
      if (r < m && this.costs[r] < this.costs[s]) s = r
      if (s === i) break
      this.swap(i, s)
      i = s
    }
    return top
  }
  private swap(i: number, j: number) {
    ;[this.keys[i], this.keys[j]] = [this.keys[j], this.keys[i]]
    ;[this.costs[i], this.costs[j]] = [this.costs[j], this.costs[i]]
  }
}

function edgeCoordsFrom(e: GEdge, fromNode: string): LonLat[] {
  return fromNode === e.a ? e.coords : [...e.coords].reverse()
}

function slicePartial(e: GEdge, snap: EdgeSnap, towardNode: string): LonLat[] {
  // path from the snap point along the edge to one of its end nodes
  if (towardNode === e.b) {
    const out: LonLat[] = [snap.point]
    for (let i = snap.seg + 1; i < e.coords.length; i++) out.push(e.coords[i])
    return out
  }
  const out: LonLat[] = [snap.point]
  for (let i = snap.seg; i >= 0; i--) out.push(e.coords[i])
  return out
}

export function routeOnTrails(g: TrailGraph, from: LonLat, to: LonLat): LonLat[] | null {
  const sA = nearestOnGraph(g, from)
  const sB = nearestOnGraph(g, to)
  if (!sA || !sB) return null

  // both on the same edge: walk directly along it
  if (sA.edge.id === sB.edge.id) {
    const e = sA.edge
    const [lo, hi] = sA.alongM <= sB.alongM ? [sA, sB] : [sB, sA]
    const pts: LonLat[] = [lo.point]
    for (let i = lo.seg + 1; i <= hi.seg; i++) pts.push(e.coords[i])
    pts.push(hi.point)
    const path = sA.alongM <= sB.alongM ? pts : [...pts].reverse()
    return dedupe(path)
  }

  const dist = new Map<string, number>()
  const prev = new Map<string, { node: string; edge: GEdge } | null>()
  const heap = new MinHeap()
  const eA = sA.edge
  const seed = (node: string, cost: number) => {
    dist.set(node, cost)
    prev.set(node, null)
    heap.push(node, cost)
  }
  seed(eA.a, sA.alongM)
  const costToB = eA.lenM - sA.alongM
  if (!dist.has(eA.b) || costToB < dist.get(eA.b)!) seed(eA.b, costToB)

  const done = new Set<string>()
  while (true) {
    const top = heap.pop()
    if (!top) break
    const [node, cost] = top
    if (done.has(node)) continue
    done.add(node)
    if (cost > (dist.get(node) ?? Infinity)) continue
    const nd = g.nodes.get(node)
    if (!nd) continue
    for (const eid of nd.edges) {
      const e = g.edges[eid]
      const other = e.a === node ? e.b : e.a
      const nc = cost + e.lenM
      if (nc < (dist.get(other) ?? Infinity)) {
        dist.set(other, nc)
        prev.set(other, { node, edge: e })
        heap.push(other, nc)
      }
    }
  }

  const eB = sB.edge
  const viaA = (dist.get(eB.a) ?? Infinity) + sB.alongM
  const viaB = (dist.get(eB.b) ?? Infinity) + (eB.lenM - sB.alongM)
  if (!isFinite(viaA) && !isFinite(viaB)) return null
  const endNode = viaA <= viaB ? eB.a : eB.b

  // reconstruct node chain
  const chain: Array<{ node: string; edge: GEdge }> = []
  let cur: string | null = endNode
  while (cur) {
    const p: { node: string; edge: GEdge } | null | undefined = prev.get(cur)
    if (p == null) break
    chain.push({ node: cur, edge: p.edge })
    cur = p.node
  }
  chain.reverse()
  const firstNode = chain.length > 0 ? (chain[0].edge.a === chain[0].node ? chain[0].edge.b : chain[0].edge.a) : endNode

  const path: LonLat[] = []
  path.push(...slicePartial(eA, sA, firstNode))
  let at = firstNode
  for (const step of chain) {
    path.push(...edgeCoordsFrom(step.edge, at).slice(1))
    at = step.node
  }
  const tail = slicePartial(eB, sB, endNode)
  tail.reverse()
  path.push(...tail.slice(1))
  return dedupe(path)
}

function dedupe(pts: LonLat[]): LonLat[] {
  const out: LonLat[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (!last || Math.abs(last[0] - p[0]) > 1e-9 || Math.abs(last[1] - p[1]) > 1e-9) out.push(p)
  }
  return out
}

// ------------------------------------------------------ route synthesis

function resampleLine(coords: LonLat[], stepM: number): LonLat[] {
  const out: LonLat[] = [coords[0]]
  let carry = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]
    const b = coords[i + 1]
    const d = haversineM(a, b)
    if (d < 1e-6) continue
    let acc = carry
    while (acc + stepM <= d) {
      acc += stepM
      const t = acc / d
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
    carry = acc - d
  }
  const last = coords[coords.length - 1]
  const tail = out[out.length - 1]
  if (haversineM(tail, last) > 1) out.push(last)
  return out
}

/** Build a full RouteData (with synthesized turn waypoints) from a raw path. */
export function synthesizeRoute(
  raw: LonLat[],
  terrain: TerrainGrid | null,
  id: string,
  name: string,
): RouteData {
  const line = resampleLine(raw, 12)
  const coords: [number, number, number][] = line.map(([lon, lat]) => [
    lon,
    lat,
    terrain ? Math.round(terrain.elevAt(lon, lat) * 10) / 10 : 0,
  ])
  const cum: number[] = [0]
  for (let i = 0; i < coords.length - 1; i++) {
    cum.push(cum[i] + haversineM([coords[i][0], coords[i][1]], [coords[i + 1][0], coords[i + 1][1]]))
  }
  // turn detection on a simplified copy, in local meters
  const frame = new LocalFrame(coords[0][0], coords[0][1])
  const pts = coords.map((c, i) => {
    const [x, y] = frame.toXY(c[0], c[1])
    return { x, y, i }
  })
  const simp = simplifyDP(pts, 6)
  const wps: Waypoint[] = []
  for (let k = 1; k < simp.length - 1; k++) {
    const a = simp[k - 1]
    const b = simp[k]
    const c = simp[k + 1]
    const brgIn = bearingDeg(
      [coords[a.i][0], coords[a.i][1]],
      [coords[b.i][0], coords[b.i][1]],
    )
    const brgOut = bearingDeg(
      [coords[b.i][0], coords[b.i][1]],
      [coords[c.i][0], coords[c.i][1]],
    )
    const d = angDiffDeg(brgIn, brgOut)
    const mag = Math.abs(d)
    if (mag < 40) continue
    const side: 'left' | 'right' = d > 0 ? 'right' : 'left'
    const kind = mag >= 120 ? 'switchback' : mag >= 75 ? 'turn' : 'bear'
    const verb = kind === 'switchback' ? `Switchback ${side}` : kind === 'turn' ? `Turn ${side}` : `Bear ${side}`
    if (wps.length > 0 && cum[b.i] - cum[wps[wps.length - 1].i] < 25) continue
    wps.push({ i: b.i, kind, dir: side, instruction: verb })
  }
  wps.unshift({ i: 0, kind: 'start', name: 'Start', instruction: 'Head out toward the trail' })
  wps.push({ i: coords.length - 1, kind: 'arrive', name, instruction: 'You have arrived' })

  const eles = coords.map((c) => c[2])
  const sm = eles.map((_, i) => {
    let s = 0
    let n = 0
    for (let j = Math.max(0, i - 2); j <= Math.min(eles.length - 1, i + 2); j++) {
      s += eles[j]
      n++
    }
    return s / n
  })
  let gain = 0
  let loss = 0
  for (let i = 0; i < sm.length - 1; i++) {
    const d = sm[i + 1] - sm[i]
    if (d > 0) gain += d
    else loss -= d
  }
  const lengthM = cum[cum.length - 1]
  return {
    id,
    name,
    coords,
    cum: cum.map((c) => Math.round(c * 10) / 10),
    waypoints: wps,
    stats: {
      lengthM: Math.round(lengthM),
      gainM: Math.round(gain),
      lossM: Math.round(loss),
      minEle: Math.round(Math.min(...eles)),
      maxEle: Math.round(Math.max(...eles)),
      estMin: Math.round((lengthM / 1000) * 12 + (gain / 100) * 10),
    },
  }
}
