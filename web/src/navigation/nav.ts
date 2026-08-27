import { angDiffDeg, bearingDeg, compass16, haversineM, type Pose } from '../geo/geo'
import { fmtDistM } from '../ui/format'
import {
  pointAtAlong,
  snapToRoute,
  waypointLonLat,
  type PreparedRoute,
  type Snap,
  type Waypoint,
} from '../routing/route'

export type NavPhase = 'navigate' | 'offroute' | 'arrived'

export interface NavTarget {
  wp: Waypoint
  lon: number
  lat: number
  ele: number
  distM: number
  bearing: number
  /** bearing relative to current heading, [-180, 180) */
  relBearing: number
}

export interface OffRouteInfo {
  distM: number
  bearing: number
  relBearing: number
  lon: number
  lat: number
}

export interface NavState {
  phase: NavPhase
  snap: Snap
  remainM: number
  remainGainM: number
  etaMin: number
  /** 0..1 along the route */
  progress: number
  /** the waypoint guidance is pointing at right now */
  next: NavTarget | null
  /** the one after, for "then ..." previews */
  upcoming: NavTarget | null
  offRoute: OffRouteInfo | null
}

const OFF_ENTER_M = 35
const OFF_EXIT_M = 18
const ARRIVE_M = 25
const RESUME_M = 60

function target(r: PreparedRoute, pose: Pose, wp: Waypoint): NavTarget {
  const [lon, lat] = waypointLonLat(r, wp)
  const ele = r.coords[wp.i][2]
  const distM = haversineM([pose.lon, pose.lat], [lon, lat])
  const bearing = bearingDeg([pose.lon, pose.lat], [lon, lat])
  return { wp, lon, lat, ele, distM, bearing, relBearing: angDiffDeg(pose.heading, bearing) }
}

export function computeNav(r: PreparedRoute, pose: Pose, prev?: NavState | null): NavState {
  const snap = snapToRoute(r, pose.lon, pose.lat)
  const lengthM = r.cum[r.cum.length - 1]
  const remainM = Math.max(0, lengthM - snap.alongM)
  const remainGainM = r.remGain[Math.min(snap.seg + 1, r.remGain.length - 1)]
  const progress = lengthM > 0 ? snap.alongM / lengthM : 0

  // arrived: near the end both along the line and in plain distance
  const end = r.coords[r.coords.length - 1]
  const distToEnd = haversineM([pose.lon, pose.lat], [end[0], end[1]])
  let arrived = remainM < ARRIVE_M && distToEnd < ARRIVE_M * 2
  if (prev?.phase === 'arrived' && distToEnd < RESUME_M) arrived = true

  // off route with hysteresis
  const wasOff = prev?.phase === 'offroute'
  const isOff = snap.offM > (wasOff ? OFF_EXIT_M : OFF_ENTER_M)

  let phase: NavPhase = 'navigate'
  if (arrived) phase = 'arrived'
  else if (isOff) phase = 'offroute'

  // pick the next waypoint strictly ahead of us along the route
  let next: NavTarget | null = null
  let upcoming: NavTarget | null = null
  if (!arrived) {
    const ahead = r.waypoints.filter((w) => w.kind !== 'start' && r.cum[w.i] > snap.alongM + 3)
    if (ahead.length > 0) next = target(r, pose, ahead[0])
    if (ahead.length > 1) upcoming = target(r, pose, ahead[1])
  }

  let offRoute: OffRouteInfo | null = null
  if (phase === 'offroute') {
    const rejoin = pointAtAlong(r, snap.alongM + Math.min(20, remainM))
    const bearing = bearingDeg([pose.lon, pose.lat], [rejoin.lon, rejoin.lat])
    offRoute = {
      distM: snap.offM,
      bearing,
      relBearing: angDiffDeg(pose.heading, bearing),
      lon: rejoin.lon,
      lat: rejoin.lat,
    }
  }

  const etaMin = (remainM / 1000) * 12 + (remainGainM / 100) * 10

  return { phase, snap, remainM, remainGainM, etaMin, progress, next, upcoming, offRoute }
}

export interface Guidance {
  /** small-caps phase line above the instruction, e.g. "NEXT TURN · 40 M" */
  eyebrow: string
  title: string
  sub: string
  tone: 'ok' | 'action' | 'warn' | 'done'
  /** true when the fix is turning in place, not walking */
  reorient?: boolean
}

/** Human guidance strings for the HUD readout. */
export function navGuidance(nav: NavState, routeName: string): Guidance {
  if (nav.phase === 'arrived') {
    return { eyebrow: 'Arrived', title: routeName, sub: 'End of route', tone: 'done' }
  }
  if (nav.phase === 'offroute' && nav.offRoute) {
    return {
      eyebrow: `Off trail · ${fmtDistM(nav.offRoute.distM)}`,
      title: `Head ${compass16(nav.offRoute.bearing)} to rejoin`,
      sub: 'Follow the marked line back to the trail',
      tone: 'warn',
    }
  }
  const next = nav.next
  if (!next) {
    return {
      eyebrow: 'On route',
      title: 'Follow the trail',
      sub: `${fmtDistM(nav.remainM)} to go`,
      tone: 'ok',
    }
  }
  // facing away from the route: fix the heading before giving directions
  if (Math.abs(next.relBearing) > 115 && next.distM > 20) {
    const side = next.relBearing < 0 ? 'left' : 'right'
    return {
      eyebrow: 'Reorient',
      title: `Turn ${side} to face the route`,
      sub: `You're ${Math.abs(Math.round(next.relBearing))}° off heading`,
      tone: 'warn',
      reorient: true,
    }
  }
  const d = next.distM
  const isManeuver = next.wp.kind === 'bear' || next.wp.kind === 'turn' || next.wp.kind === 'switchback'
  if (isManeuver && d <= 60) {
    return {
      eyebrow: d <= 15 ? 'Next turn · now' : `Next turn · ${fmtDistM(d)}`,
      title: next.wp.instruction,
      sub: nav.upcoming
        ? `then ${nav.upcoming.wp.instruction.toLowerCase()}`
        : `${fmtDistM(nav.remainM)} to go`,
      tone: 'action',
    }
  }
  const label = next.wp.name ?? next.wp.instruction
  return {
    eyebrow: 'On route',
    title: `${label} · ${fmtDistM(d)}`,
    sub: `${fmtDistM(nav.remainM)} to go`,
    tone: 'ok',
  }
}
