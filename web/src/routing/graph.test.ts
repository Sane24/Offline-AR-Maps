import { describe, expect, it } from 'vitest'
import type { FeatureCollection } from 'geojson'
import { buildGraph, nearestOnGraph, routeOnTrails, synthesizeRoute } from './graph'
import { destPoint, haversineM, type LonLat } from '../geo/geo'

/**
 * Trail network around a junction J:
 *
 *   A ---- J ---- B     (west-east trail)
 *          |
 *          C            (spur going south)
 */
function network(): FeatureCollection {
  const J: LonLat = [-116.13, 34.0]
  const A = destPoint(J, 270, 500)
  const B = destPoint(J, 90, 500)
  const C = destPoint(J, 180, 400)
  const mk = (coords: LonLat[]): GeoJSON.Feature => ({
    type: 'Feature',
    properties: { kind: 'trail' },
    geometry: { type: 'LineString', coordinates: coords as unknown as number[][] },
  })
  // west-east line includes J as an interior shared vertex
  return {
    type: 'FeatureCollection',
    features: [mk([A, J, B]), mk([J, C])],
  } as FeatureCollection
}

describe('trail graph', () => {
  it('splits ways at junctions', () => {
    const g = buildGraph(network())
    expect(g.edges.length).toBe(3)
    expect(g.nodes.size).toBe(4)
  })

  it('routes across the junction', () => {
    const g = buildGraph(network())
    const J: LonLat = [-116.13, 34.0]
    const start = destPoint(J, 270, 400) // on the west arm
    const goal = destPoint(J, 180, 300) // on the spur
    const path = routeOnTrails(g, start, goal)
    expect(path).not.toBeNull()
    let len = 0
    for (let i = 0; i < path!.length - 1; i++) len += haversineM(path![i], path![i + 1])
    expect(len).toBeCloseTo(700, -2)
    // path passes through the junction
    const nearJ = path!.some((p) => haversineM(p, J) < 5)
    expect(nearJ).toBe(true)
  })

  it('routes within a single edge', () => {
    const g = buildGraph(network())
    const J: LonLat = [-116.13, 34.0]
    const a = destPoint(J, 270, 450)
    const b = destPoint(J, 270, 100)
    const path = routeOnTrails(g, a, b)
    expect(path).not.toBeNull()
    let len = 0
    for (let i = 0; i < path!.length - 1; i++) len += haversineM(path![i], path![i + 1])
    expect(len).toBeCloseTo(350, -1)
  })

  it('nearestOnGraph rejects far points', () => {
    const g = buildGraph(network())
    const far = destPoint([-116.13, 34.0], 45, 5000)
    expect(nearestOnGraph(g, far, 400)).toBeNull()
  })

  it('synthesizes turn waypoints on an L path', () => {
    const J: LonLat = [-116.13, 34.0]
    const A = destPoint(J, 270, 300)
    const C = destPoint(J, 180, 300)
    const path: LonLat[] = [A, J, C]
    const route = synthesizeRoute(path, null, 'x', 'X')
    expect(route.stats.lengthM).toBeCloseTo(600, -1)
    const turns = route.waypoints.filter((w) => w.kind === 'turn' || w.kind === 'switchback')
    expect(turns.length).toBe(1)
    // walking east then south = a right turn
    expect(turns[0].dir).toBe('right')
  })
})
