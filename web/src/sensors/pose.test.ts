import { describe, expect, it } from 'vitest'
import { destPoint } from '../geo/geo'
import { prepareRoute, type RouteData } from '../routing/route'
import { PoseController } from './pose'

/** straight route heading due north, 1 km, point every 20 m */
function straightNorthRoute(): RouteData {
  const coords: [number, number, number][] = []
  const cum: number[] = []
  for (let i = 0; i <= 50; i++) {
    const [lon, lat] = destPoint([-116.13, 34.0], 0, i * 20)
    coords.push([lon, lat, 1000])
    cum.push(i * 20)
  }
  return {
    id: 't',
    name: 'Test Trail',
    coords,
    cum,
    waypoints: [
      { i: 0, kind: 'start', name: 'Trailhead', instruction: 'Head out' },
      { i: 50, kind: 'arrive', name: 'Test Trail', instruction: 'You have arrived' },
    ],
    stats: { lengthM: 1000, gainM: 0, lossM: 0, minEle: 1000, maxEle: 1000, estMin: 12 },
  }
}

describe('free walk (WASD)', () => {
  it('W walks forward along the heading, faster than the auto walk', () => {
    const c = new PoseController()
    c.setRoute(prepareRoute(straightNorthRoute()), null)
    c.keys.w = true
    c.update(1)
    c.update(1)
    // 7 m/s heading north for 2 s
    expect(c.alongM).toBeGreaterThan(12)
    expect(c.alongM).toBeLessThan(16)
    expect(Math.abs(c.lateralM)).toBeLessThan(0.5)
    expect(c.pose.speedMps).toBeCloseTo(7, 1)
  })

  it('D strafes right of the heading into a lateral offset', () => {
    const c = new PoseController()
    c.setRoute(prepareRoute(straightNorthRoute()), null)
    c.keys.d = true
    c.update(1)
    // 5 m/s east of a north-running route => positive (right) lateral
    expect(c.lateralM).toBeGreaterThan(4)
    expect(c.lateralM).toBeLessThan(6)
    expect(c.alongM).toBeLessThan(1)
  })

  it('S backs up and movement composes with the existing offset', () => {
    const c = new PoseController()
    c.setRoute(prepareRoute(straightNorthRoute()), null)
    c.keys.w = true
    c.update(2) // ~14 m up the route
    c.clearKeys()
    c.keys.s = true
    c.update(1) // ~5 m back south
    expect(c.alongM).toBeGreaterThan(7)
    expect(c.alongM).toBeLessThan(11)
    c.clearKeys()
    expect(c.keys.w || c.keys.a || c.keys.s || c.keys.d).toBe(false)
  })
})
