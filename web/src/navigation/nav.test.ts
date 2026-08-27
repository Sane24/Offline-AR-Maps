import { describe, expect, it } from 'vitest'
import { destPoint, type Pose } from '../geo/geo'
import { computeNav, navGuidance } from './nav'
import { prepareRoute, snapToRoute, pointAtAlong, type RouteData } from '../routing/route'

/** straight route heading due north, 1 km, point every 20 m */
function straightNorthRoute(): RouteData {
  const coords: [number, number, number][] = []
  const cum: number[] = []
  for (let i = 0; i <= 50; i++) {
    const [lon, lat] = destPoint([-116.13, 34.0], 0, i * 20)
    coords.push([lon, lat, 1000 + i])
    cum.push(i * 20)
  }
  return {
    id: 't',
    name: 'Test Trail',
    coords,
    cum,
    waypoints: [
      { i: 0, kind: 'start', name: 'Trailhead', instruction: 'Head out' },
      { i: 25, kind: 'turn', dir: 'right', instruction: 'Turn right' },
      { i: 50, kind: 'arrive', name: 'Test Trail', instruction: 'You have arrived' },
    ],
    stats: { lengthM: 1000, gainM: 50, lossM: 0, minEle: 1000, maxEle: 1050, estMin: 17 },
  }
}

const poseAt = (lon: number, lat: number, heading = 0): Pose => ({
  lon,
  lat,
  ele: 1000,
  heading,
  pitch: 0,
  accuracy: 5,
  speedMps: 1.3,
  ts: 0,
})

describe('route snapping', () => {
  it('snaps a point beside the line onto it', () => {
    const r = prepareRoute(straightNorthRoute())
    const beside = destPoint(destPoint([-116.13, 34.0], 0, 500), 90, 12)
    const snap = snapToRoute(r, beside[0], beside[1])
    expect(snap.offM).toBeCloseTo(12, 0)
    expect(snap.alongM).toBeGreaterThan(490)
    expect(snap.alongM).toBeLessThan(510)
  })

  it('pointAtAlong interpolates', () => {
    const r = straightNorthRoute()
    const p = pointAtAlong(r, 510)
    expect(p.ele).toBeCloseTo(1025.5, 1)
    expect(p.bearing).toBeCloseTo(0, 1)
  })
})

describe('nav engine', () => {
  const prepared = prepareRoute(straightNorthRoute())

  it('navigates toward the next waypoint', () => {
    const [lon, lat] = destPoint([-116.13, 34.0], 0, 300)
    const nav = computeNav(prepared, poseAt(lon, lat))
    expect(nav.phase).toBe('navigate')
    expect(nav.next?.wp.kind).toBe('turn')
    expect(nav.next?.distM).toBeCloseTo(200, -1)
    expect(nav.remainM).toBeCloseTo(700, -1)
    expect(nav.progress).toBeCloseTo(0.3, 1)
    const g = navGuidance(nav, 'Test Trail')
    expect(g.tone).toBe('ok')
  })

  it('announces maneuvers when close', () => {
    const [lon, lat] = destPoint([-116.13, 34.0], 0, 470)
    const nav = computeNav(prepared, poseAt(lon, lat))
    const g = navGuidance(nav, 'Test Trail')
    expect(g.tone).toBe('action')
    expect(g.title).toContain('Turn right')
  })

  it('flags off route with hysteresis', () => {
    const on = destPoint([-116.13, 34.0], 0, 400)
    const off40 = destPoint(on, 90, 40)
    const nav1 = computeNav(prepared, poseAt(off40[0], off40[1], 90))
    expect(nav1.phase).toBe('offroute')
    expect(nav1.offRoute).not.toBeNull()
    // heading east (90), rejoin to the west-northwest => |relBearing| > 150
    expect(Math.abs(nav1.offRoute!.relBearing)).toBeGreaterThan(150)

    // still off at 25 m (exit threshold 18) because we were off before
    const off25 = destPoint(on, 90, 25)
    const nav2 = computeNav(prepared, poseAt(off25[0], off25[1]), nav1)
    expect(nav2.phase).toBe('offroute')

    // fresh nav at 25 m without history stays on route (enter threshold 35)
    const nav3 = computeNav(prepared, poseAt(off25[0], off25[1]))
    expect(nav3.phase).toBe('navigate')

    // back within 10 m clears it even with history
    const off10 = destPoint(on, 90, 10)
    const nav4 = computeNav(prepared, poseAt(off10[0], off10[1]), nav1)
    expect(nav4.phase).toBe('navigate')
  })

  it('asks for a turn in place when facing away from the route', () => {
    const [lon, lat] = destPoint([-116.13, 34.0], 0, 300)
    const nav = computeNav(prepared, poseAt(lon, lat, 180))
    expect(nav.phase).toBe('navigate')
    const g = navGuidance(nav, 'Test Trail')
    expect(g.reorient).toBe(true)
    expect(g.tone).toBe('warn')
  })

  it('arrives at the end', () => {
    const [lon, lat] = destPoint([-116.13, 34.0], 0, 995)
    const nav = computeNav(prepared, poseAt(lon, lat))
    expect(nav.phase).toBe('arrived')
    expect(navGuidance(nav, 'Test Trail').tone).toBe('done')
  })

  it('eta scales with climb', () => {
    const [lon, lat] = destPoint([-116.13, 34.0], 0, 0)
    const nav = computeNav(prepared, poseAt(lon, lat))
    // 1 km at 12 min/km + 50 m climb at 10 min/100 m = 17 min
    expect(nav.etaMin).toBeCloseTo(17, 0)
  })
})
