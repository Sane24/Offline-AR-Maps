import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '../app/store'
import { pointAtAlong, type PreparedRoute } from '../routing/route'
import { clamp } from '../geo/geo'

/** shared orbit parameters, mutated directly by pointer handlers */
export const orbitState = {
  az: 0.4,
  polar: 0.85,
  dist: 2400,
  target: new THREE.Vector3(),
}

export function frameRouteInOrbit(prepared: PreparedRoute) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < prepared.xy.length; i += 2) {
    minX = Math.min(minX, prepared.xy[i])
    maxX = Math.max(maxX, prepared.xy[i])
    minY = Math.min(minY, prepared.xy[i + 1])
    maxY = Math.max(maxY, prepared.xy[i + 1])
  }
  const eleMid = (prepared.stats.minEle + prepared.stats.maxEle) / 2
  orbitState.target.set((minX + maxX) / 2, eleMid, -(minY + maxY) / 2)
  const extent = Math.max(maxX - minX, maxY - minY, 600)
  orbitState.dist = extent * 0.92 + 380
  orbitState.polar = 0.78
  const start = pointAtAlong(prepared, 0)
  orbitState.az = ((start.bearing + 180) * Math.PI) / 180
}

const D2R = Math.PI / 180
const smooth = (t: number) => t * t * (3 - 2 * t)

export default function CameraRig() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const mode = useStore((s) => s.mode)
  const flythrough = useStore((s) => s.flythrough)
  const routeId = useStore((s) => s.activeRouteId)

  const blend = useRef({ t: 1, pos: new THREE.Vector3(), quat: new THREE.Quaternion() })
  const fly = useRef(0)
  const tmp = useRef({
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    m: new THREE.Matrix4(),
    look: new THREE.Vector3(),
    eul: new THREE.Euler(),
  })

  useEffect(() => {
    blend.current.t = 0
    blend.current.pos.copy(camera.position)
    blend.current.quat.copy(camera.quaternion)
    fly.current = 0
  }, [mode, flythrough, routeId, camera])

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1)
    const st = useStore.getState()
    const prepared = st.prepared
    if (!prepared) return
    const t = tmp.current
    const total = prepared.cum[prepared.cum.length - 1]

    let wantFov = 55
    if (st.mode === 'ar') {
      wantFov = 66
      const pose = st.pose
      const [x, y] = prepared.frame.toXY(pose.lon, pose.lat)
      t.pos.set(x, pose.ele, -y)
      t.eul.set(pose.pitch * D2R, -pose.heading * D2R, 0, 'YXZ')
      t.quat.setFromEuler(t.eul)
    } else if (st.flythrough) {
      fly.current += dt * 170
      if (fly.current >= total + 120) {
        st.setFlythrough(false)
      }
      const here = pointAtAlong(prepared, Math.min(fly.current, total))
      const ahead = pointAtAlong(prepared, Math.min(fly.current + 170, total + 1))
      const [hx, hy] = prepared.frame.toXY(here.lon, here.lat)
      const [ax, ay] = prepared.frame.toXY(ahead.lon, ahead.lat)
      t.pos.set(hx, here.ele + 55, -hy)
      t.look.set(ax, ahead.ele + 14, -ay)
      t.m.lookAt(t.pos, t.look, THREE.Object3D.DEFAULT_UP)
      t.quat.setFromRotationMatrix(t.m)
      wantFov = 60
    } else {
      const o = orbitState
      o.polar = clamp(o.polar, 0.18, 1.42)
      o.dist = clamp(o.dist, 260, 24000)
      t.pos.set(
        o.target.x + Math.sin(o.az) * Math.sin(o.polar) * o.dist,
        o.target.y + Math.cos(o.polar) * o.dist,
        o.target.z + Math.cos(o.az) * Math.sin(o.polar) * o.dist,
      )
      t.m.lookAt(t.pos, o.target, THREE.Object3D.DEFAULT_UP)
      t.quat.setFromRotationMatrix(t.m)
    }

    if (blend.current.t < 1) {
      blend.current.t = Math.min(1, blend.current.t + dt / 0.75)
      const s = smooth(blend.current.t)
      camera.position.lerpVectors(blend.current.pos, t.pos, s)
      camera.quaternion.slerpQuaternions(blend.current.quat, t.quat, s)
    } else {
      camera.position.copy(t.pos)
      camera.quaternion.copy(t.quat)
    }

    if (Math.abs(camera.fov - wantFov) > 0.05) {
      camera.fov += (wantFov - camera.fov) * Math.min(1, dt * 5)
      camera.updateProjectionMatrix()
    }
  })

  useEffect(() => {
    camera.near = 0.4
    camera.far = 16000
    camera.updateProjectionMatrix()
  }, [camera])

  return null
}
