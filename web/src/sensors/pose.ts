/**
 * Pose sources, fused into one stream:
 *  - position: simulated walk along the route, or real GPS (watchPosition)
 *  - orientation: pointer drag (desktop), or device orientation sensors
 * Every consumer (AR scene, HUD, nav engine) reads the same Pose.
 */
import { angDiffDeg, clamp, lerpAngleDeg, wrap360, type Pose } from '../geo/geo'
import { pointAtAlong, snapToRoute, type PreparedRoute } from '../routing/route'
import type { TerrainGrid } from '../terrain/terrain'

export type PosSource = 'sim' | 'gps'
export type OriSource = 'pointer' | 'device'

export interface PoseConfig {
  posSource: PosSource
  oriSource: OriSource
  /** walk speed multiplier over 1.35 m/s */
  simSpeed: number
  playing: boolean
  /** synthetic gps wobble to demo route snapping */
  gpsNoise: boolean
}

export const EYE_HEIGHT = 1.7
const BASE_WALK_MPS = 1.35
// free-walk speeds for held WASD keys (heading-relative)
const FREE_FWD_MPS = 7
const FREE_BACK_MPS = 5
const FREE_STRAFE_MPS = 5

export type PermState = 'unknown' | 'granted' | 'denied' | 'unsupported'

export class PoseController {
  pose: Pose = {
    lon: 0,
    lat: 0,
    ele: 0,
    heading: 0,
    pitch: 0,
    accuracy: 5,
    speedMps: 0,
    ts: 0,
  }
  cfg: PoseConfig = {
    posSource: 'sim',
    oriSource: 'pointer',
    simSpeed: 2,
    playing: false,
    gpsNoise: false,
  }

  /** distance walked along the route in sim mode */
  alongM = 0
  /** lateral offset from the route in sim mode (demoes off-route states) */
  lateralM = 0
  /** held movement keys: free walk relative to the current heading */
  keys = { w: false, a: false, s: false, d: false }
  /** pointer-look state */
  lookYaw = 0
  lookPitch = 8

  private route: PreparedRoute | null = null
  private terrain: TerrainGrid | null = null
  private simTime = 0

  // device orientation
  deviceState: PermState = 'unknown'
  private devHeadingRaw: number | null = null
  private devPitchRaw = 0
  private headingOffset = 0
  private headingSm = 0
  private pitchSm = 0
  private oriHandler: ((e: DeviceOrientationEvent) => void) | null = null

  // gps
  gpsState: PermState = 'unknown'
  private gpsWatch: number | null = null
  private gpsFix: { lon: number; lat: number; acc: number; speed: number } | null = null

  clearKeys() {
    this.keys.w = this.keys.a = this.keys.s = this.keys.d = false
  }

  setRoute(route: PreparedRoute | null, terrain: TerrainGrid | null) {
    this.route = route
    this.terrain = terrain
    this.alongM = 0
    this.lateralM = 0
    this.lookYaw = 0
    this.lookPitch = 8
    this.clearKeys()
    if (route) {
      const p = pointAtAlong(route, 0)
      this.pose.lon = p.lon
      this.pose.lat = p.lat
      this.pose.heading = p.bearing
      this.headingSm = p.bearing
      this.updateGround()
    }
  }

  jumpToAlong(m: number) {
    this.alongM = m
    this.update(0)
  }

  /**
   * Free walk while WASD is held: move in the direction the camera faces,
   * then decompose the new position back into along-route distance plus a
   * signed lateral offset, so nav progress and off-route detection follow
   * wherever you wander. Returns the speed moved (0 when no key is held).
   */
  private applyFreeMove(dt: number, r: PreparedRoute): number {
    const k = this.keys
    const fwd = (k.w ? FREE_FWD_MPS : 0) - (k.s ? FREE_BACK_MPS : 0)
    const strafe = ((k.d ? 1 : 0) - (k.a ? 1 : 0)) * FREE_STRAFE_MPS
    if (fwd === 0 && strafe === 0) return 0
    const h = (this.pose.heading * Math.PI) / 180
    // east/north velocity: forward = (sin h, cos h), right = (cos h, -sin h)
    const ve = Math.sin(h) * fwd + Math.cos(h) * strafe
    const vn = Math.cos(h) * fwd - Math.sin(h) * strafe
    const [x, y] = r.frame.toXY(this.pose.lon, this.pose.lat)
    const nx = x + ve * dt
    const ny = y + vn * dt
    const [lon, lat] = r.frame.toLonLat(nx, ny)
    const snap = snapToRoute(r, lon, lat)
    const [sx, sy] = r.frame.toXY(snap.lon, snap.lat)
    const b = (pointAtAlong(r, snap.alongM).bearing * Math.PI) / 180
    // cross(route direction, offset): negative z means offset to the right
    const crossZ = Math.sin(b) * (ny - sy) - Math.cos(b) * (nx - sx)
    this.alongM = snap.alongM
    this.lateralM = clamp(-crossZ, -120, 120)
    return Math.hypot(ve, vn)
  }

  /** advance the simulation / apply latest sensor values */
  update(dt: number) {
    const r = this.route
    this.simTime += dt
    if (this.cfg.posSource === 'sim' && r) {
      const freeSpeed = this.applyFreeMove(dt, r)
      if (freeSpeed > 0) {
        this.pose.speedMps = freeSpeed
      } else if (this.cfg.playing) {
        const total = r.cum[r.cum.length - 1]
        this.alongM = Math.min(this.alongM + BASE_WALK_MPS * this.cfg.simSpeed * dt, total)
        this.pose.speedMps = this.alongM >= total ? 0 : BASE_WALK_MPS * this.cfg.simSpeed
      } else {
        this.pose.speedMps = 0
      }
      const p = pointAtAlong(r, this.alongM)
      // lateral offset (perpendicular to path) + optional gps-like wobble
      let ox = 0
      let oy = 0
      const side = ((p.bearing + 90) * Math.PI) / 180
      ox += Math.sin(side) * this.lateralM
      oy += Math.cos(side) * this.lateralM
      if (this.cfg.gpsNoise) {
        ox += 3.5 * Math.sin(this.simTime * 0.31)
        oy += 3.5 * Math.sin(this.simTime * 0.53 + 1.3)
      }
      this.pose.lon = p.lon + ox / (111320 * Math.cos((p.lat * Math.PI) / 180))
      this.pose.lat = p.lat + oy / 110574
      this.pose.accuracy = this.cfg.gpsNoise ? 8 : 3

      if (this.cfg.oriSource === 'pointer') {
        // look follows the path plus the user's drag offset
        const want = wrap360(p.bearing + this.lookYaw)
        const k = 1 - Math.exp(-dt * 5)
        this.headingSm = lerpAngleDeg(this.headingSm, want, dt > 0 ? k : 1)
        this.pose.heading = this.headingSm
        this.pose.pitch = this.lookPitch
      }
    } else if (this.cfg.posSource === 'gps' && this.gpsFix) {
      this.pose.lon = this.gpsFix.lon
      this.pose.lat = this.gpsFix.lat
      this.pose.accuracy = this.gpsFix.acc
      this.pose.speedMps = this.gpsFix.speed
      if (this.cfg.oriSource === 'pointer') {
        this.pose.heading = wrap360(this.lookYaw)
        this.pose.pitch = this.lookPitch
      }
    }

    if (this.cfg.oriSource === 'device' && this.devHeadingRaw != null) {
      const want = wrap360(this.devHeadingRaw + this.headingOffset)
      const k = dt > 0 ? 1 - Math.exp(-dt * 10) : 1
      this.headingSm = lerpAngleDeg(this.headingSm, want, k)
      this.pitchSm = this.pitchSm + (this.devPitchRaw - this.pitchSm) * k
      this.pose.heading = this.headingSm
      this.pose.pitch = clamp(this.pitchSm, -85, 85)
    }

    this.updateGround()
    this.pose.ts = performance.now()
  }

  private updateGround() {
    if (this.terrain) {
      this.pose.ele = this.terrain.elevAt(this.pose.lon, this.pose.lat) + EYE_HEIGHT
    }
  }

  addLook(dxDeg: number, dyDeg: number) {
    this.lookYaw = this.lookYaw + dxDeg
    this.lookPitch = clamp(this.lookPitch - dyDeg, -70, 80)
  }

  resetLook() {
    this.lookYaw = 0
    this.lookPitch = 8
  }

  stepLateral(m: number) {
    this.lateralM = clamp(this.lateralM + m, -120, 120)
  }

  /**
   * Align the device compass so the camera currently faces `targetBearing`.
   * A pragmatic one-tap calibration for demos and drifting compasses.
   */
  calibrate(targetBearing: number) {
    if (this.devHeadingRaw != null) {
      this.headingOffset = angDiffDeg(this.devHeadingRaw, targetBearing)
    } else {
      this.lookYaw = 0
    }
  }

  async requestDeviceOrientation(): Promise<PermState> {
    const DOE = DeviceOrientationEvent as unknown as DeviceOrientationEventStatic | undefined
    if (typeof DeviceOrientationEvent === 'undefined') {
      this.deviceState = 'unsupported'
      return 'unsupported'
    }
    try {
      if (typeof DOE?.requestPermission === 'function') {
        const res = await DOE.requestPermission()
        if (res !== 'granted') {
          this.deviceState = 'denied'
          return 'denied'
        }
      }
    } catch {
      this.deviceState = 'denied'
      return 'denied'
    }
    this.attachOrientation()
    this.deviceState = 'granted'
    return 'granted'
  }

  private attachOrientation() {
    if (this.oriHandler) return
    this.oriHandler = (ev: DeviceOrientationEvent) => {
      const e = ev as DeviceOrientationEventiOS
      const screenAngle =
        (screen.orientation && typeof screen.orientation.angle === 'number'
          ? screen.orientation.angle
          : 0) || 0
      if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
        // iOS: degrees clockwise from north of the device top
        this.devHeadingRaw = wrap360(e.webkitCompassHeading + screenAngle)
      } else if (e.alpha != null) {
        // Android / absolute orientation
        this.devHeadingRaw = wrap360(360 - e.alpha + screenAngle)
      }
      if (e.beta != null) {
        // portrait, phone raised toward the horizon => beta ~90 => pitch 0
        this.devPitchRaw = clamp(e.beta - 90, -85, 85)
      }
    }
    window.addEventListener(
      'deviceorientationabsolute' as keyof WindowEventMap,
      this.oriHandler as EventListener,
      true,
    )
    window.addEventListener('deviceorientation', this.oriHandler as EventListener, true)
  }

  startGps(onError?: (msg: string) => void) {
    if (!('geolocation' in navigator)) {
      this.gpsState = 'unsupported'
      onError?.('Geolocation is not supported here')
      return
    }
    if (this.gpsWatch != null) return
    this.gpsWatch = navigator.geolocation.watchPosition(
      (pos) => {
        this.gpsState = 'granted'
        this.gpsFix = {
          lon: pos.coords.longitude,
          lat: pos.coords.latitude,
          acc: pos.coords.accuracy ?? 20,
          speed: pos.coords.speed ?? 0,
        }
      },
      (err) => {
        this.gpsState = 'denied'
        onError?.(err.message)
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
    )
  }

  stopGps() {
    if (this.gpsWatch != null) {
      navigator.geolocation.clearWatch(this.gpsWatch)
      this.gpsWatch = null
    }
  }

  /** one-shot position for "suggest a region near me" */
  static async currentPosition(timeoutMs = 6000): Promise<{ lon: number; lat: number } | null> {
    if (!('geolocation' in navigator)) return null
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), timeoutMs + 500)
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(t)
          resolve({ lon: pos.coords.longitude, lat: pos.coords.latitude })
        },
        () => {
          clearTimeout(t)
          resolve(null)
        },
        { maximumAge: 600000, timeout: timeoutMs },
      )
    })
  }
}
