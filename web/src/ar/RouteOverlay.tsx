import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import type { Feature, Point } from 'geojson'
import { useStore } from '../app/store'
import { pointAtAlong, waypointLonLat, type PreparedRoute } from '../routing/route'
import { fmtDistM } from '../ui/format'
import { chevronGeometry, makeLabelSprite } from './three-helpers'

/* trail-marker palette: blaze orange route, bone markers, moss at the end */
const ORANGE = new THREE.Color('#f07b31')
const BONE = new THREE.Color('#e8e4d6')
const MOSS = new THREE.Color('#9cab72')
const AMBER = new THREE.Color('#dca43e')
const HAZE = new THREE.Color('#cfc7b2')

function toWorld(prepared: PreparedRoute, lon: number, lat: number, ele: number, out: THREE.Vector3) {
  const [x, y] = prepared.frame.toXY(lon, lat)
  out.set(x, ele, -y)
  return out
}

/* ------------------------------------------------------------ route tube */

function RouteTube({ prepared }: { prepared: PreparedRoute }) {
  const obj = useMemo(() => {
    const group = new THREE.Group()
    const pts: THREE.Vector3[] = []
    const total = prepared.cum[prepared.cum.length - 1]
    const step = Math.max(14, total / 700)
    for (let d = 0; d <= total; d += step) {
      const p = pointAtAlong(prepared, d)
      pts.push(toWorld(prepared, p.lon, p.lat, p.ele + 0.55, new THREE.Vector3()))
    }
    // volumetric ribbon: reads at first-person scale
    const curve = new THREE.CatmullRomCurve3(pts)
    const geo = new THREE.TubeGeometry(curve, Math.min(1400, pts.length * 2), 0.34, 6, false)
    const mat = new THREE.MeshBasicMaterial({
      color: ORANGE,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
      fog: false,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.renderOrder = 10
    group.add(mesh)
    // crisp cased line at constant pixel width: reads at orbit / flyover
    // scale exactly like a route on a paper map
    const flat: number[] = []
    for (const p of pts) flat.push(p.x, p.y, p.z)
    const lineGeo = new LineGeometry()
    lineGeo.setPositions(flat)
    const casingMat = new LineMaterial({
      color: 0xf7f2e2,
      linewidth: 6.5,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
    })
    const casing = new Line2(lineGeo, casingMat)
    casing.renderOrder = 8
    const lineMat = new LineMaterial({
      color: 0xd6551a,
      linewidth: 3,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    })
    const line = new Line2(lineGeo, lineMat)
    line.renderOrder = 9
    const xray = new THREE.Group()
    xray.name = 'route-xray'
    xray.add(casing)
    xray.add(line)
    group.add(xray)
    return group
  }, [prepared])

  // the through-terrain line reads as x-ray vision in first person; show it
  // only at orbit / flyover scale, and keep its pixel width resolution-true
  useFrame(({ size }) => {
    const xray = obj.getObjectByName('route-xray')
    if (!xray) return
    xray.visible = useStore.getState().mode !== 'ar'
    for (const child of xray.children) {
      const mat = (child as Line2).material as LineMaterial
      mat.resolution.set(size.width, size.height)
    }
  })

  useEffect(
    () => () => {
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh
        mesh.geometry?.dispose()
        const m = mesh.material as THREE.Material | undefined
        m?.dispose()
      })
    },
    [obj],
  )
  return <primitive object={obj} />
}

/* ------------------------------------------------------- flow chevrons */

const CHEV_N = 46
const CHEV_SPACING = 9

function Chevrons({ prepared }: { prepared: PreparedRoute }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const geo = useMemo(() => chevronGeometry(1.35), [])
  const mat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
    [],
  )
  const tmp = useMemo(
    () => ({
      m: new THREE.Matrix4(),
      p: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      e: new THREE.Euler(),
      s: new THREE.Vector3(),
      c: new THREE.Color(),
    }),
    [],
  )

  useEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    for (let i = 0; i < CHEV_N; i++) mesh.setColorAt(i, ORANGE)
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [prepared])

  useFrame(({ clock }) => {
    const mesh = ref.current
    if (!mesh) return
    const st = useStore.getState()
    mesh.visible = !st.flythrough
    if (st.flythrough) return
    const along0 = st.nav ? st.nav.snap.alongM : 0
    const total = prepared.cum[prepared.cum.length - 1]
    const tt = clock.elapsedTime
    // march the whole strip forward slowly for a "flowing" feel
    const flow = (tt * 2.2) % CHEV_SPACING
    for (let i = 0; i < CHEV_N; i++) {
      const d = along0 + 6 + i * CHEV_SPACING + flow
      if (d >= total) {
        tmp.s.setScalar(0.0001)
        tmp.m.compose(tmp.p, tmp.q, tmp.s)
        mesh.setMatrixAt(i, tmp.m)
        continue
      }
      const p = pointAtAlong(prepared, d)
      toWorld(prepared, p.lon, p.lat, p.ele + 0.5, tmp.p)
      tmp.e.set(0, (-p.bearing * Math.PI) / 180, 0)
      tmp.q.setFromEuler(tmp.e)
      const grow = 0.85 + Math.min(1.7, (i * CHEV_SPACING) / 200)
      tmp.s.setScalar(grow)
      tmp.m.compose(tmp.p, tmp.q, tmp.s)
      mesh.setMatrixAt(i, tmp.m)
      // fade into the haze with distance instead of glowing
      const f = i / CHEV_N
      tmp.c.copy(ORANGE).lerp(HAZE, Math.min(1, f * 1.1))
      mesh.setColorAt(i, tmp.c)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mat.opacity = 0.8 + 0.1 * Math.sin(tt * 2.4)
  })

  return <instancedMesh ref={ref} args={[geo, mat, CHEV_N]} frustumCulled={false} renderOrder={12} />
}

/* -------------------------------------------------- next waypoint beacon */

function bucketDist(d: number): string {
  if (d < 300) return fmtDistM(Math.round(d / 10) * 10)
  return fmtDistM(Math.round(d / 25) * 25)
}

function Beacon() {
  const group = useRef<THREE.Group>(null)
  const ring = useRef<THREE.Mesh>(null)
  const beam = useRef<THREE.Mesh>(null)
  const labelHolder = useRef<THREE.Group>(null)
  const lastLabel = useRef('')

  const parts = useMemo(() => {
    const ringGeo = new THREE.TorusGeometry(2.4, 0.16, 10, 40)
    const ringMat = new THREE.MeshBasicMaterial({
      color: ORANGE,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      fog: false,
    })
    const beamGeo = new THREE.CylinderGeometry(0.16, 0.4, 30, 8, 1, true)
    const beamMat = new THREE.MeshBasicMaterial({
      color: ORANGE,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    })
    return { ringGeo, ringMat, beamGeo, beamMat }
  }, [])

  useFrame(({ clock }) => {
    const g = group.current
    if (!g) return
    const st = useStore.getState()
    const prepared = st.prepared
    const next = st.nav?.next
    if (!prepared || !next || st.flythrough) {
      g.visible = false
      return
    }
    g.visible = true
    const ele = prepared.coords[Math.min(next.wp.i, prepared.coords.length - 1)][2]
    toWorld(prepared, next.lon, next.lat, ele, g.position)

    const t = clock.elapsedTime
    if (ring.current) {
      const s = 1 + 0.12 * Math.sin(t * 3.4)
      ring.current.scale.setScalar(s)
    }
    const isArrive = next.wp.kind === 'arrive'
    const isManeuver = ['bear', 'turn', 'switchback'].includes(next.wp.kind)
    const color = isArrive ? MOSS : ORANGE
    ;(parts.ringMat as THREE.MeshBasicMaterial).color.copy(color)
    ;(parts.beamMat as THREE.MeshBasicMaterial).color.copy(color)

    // label: rebuild only when text bucket changes
    const title = next.wp.name ?? next.wp.instruction
    const label = `${title}|${bucketDist(next.distM)}`
    if (label !== lastLabel.current && labelHolder.current) {
      lastLabel.current = label
      const holder = labelHolder.current
      while (holder.children.length) {
        const c = holder.children[0] as THREE.Sprite
        holder.remove(c)
        c.material.dispose()
      }
      const sp = makeLabelSprite(title, {
        sub: bucketDist(next.distM),
        accent: isArrive ? '#9cab72' : isManeuver ? '#f07b31' : '#cfc7b2',
        scale: 1,
      })
      holder.add(sp)
    }
    if (labelHolder.current) {
      // roughly constant on-screen size
      const dist = next.distM
      const s = Math.min(16, Math.max(2.6, dist * 0.055))
      labelHolder.current.scale.setScalar(s)
      labelHolder.current.position.y = 6.5 + s * 0.35
    }
  })

  return (
    <group ref={group} visible={false}>
      <mesh ref={ring} geometry={parts.ringGeo} material={parts.ringMat} rotation-x={-Math.PI / 2} position-y={0.3} renderOrder={14} />
      <mesh ref={beam} geometry={parts.beamGeo} material={parts.beamMat} position-y={15} renderOrder={13} />
      <group ref={labelHolder} />
    </group>
  )
}

/* -------------------------------------------------------- static markers */

/**
 * Waypoints as trail-marker stakes: a bone post with a colored band, planted
 * in the ground, rather than shapes floating in the air.
 */
function WaypointStakes({ prepared }: { prepared: PreparedRoute }) {
  const obj = useMemo(() => {
    const g = new THREE.Group()
    const postGeo = new THREE.CylinderGeometry(0.06, 0.08, 1.35, 6)
    const bandGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.24, 8)
    const postMat = new THREE.MeshBasicMaterial({ color: BONE, transparent: true, opacity: 0.85, fog: false })
    const bandManeuver = new THREE.MeshBasicMaterial({ color: ORANGE, transparent: true, opacity: 0.95, fog: false })
    const bandPoi = new THREE.MeshBasicMaterial({ color: HAZE, transparent: true, opacity: 0.9, fog: false })
    for (const wp of prepared.waypoints) {
      if (wp.kind === 'start' || wp.kind === 'arrive') continue
      const [lon, lat] = waypointLonLat(prepared, wp)
      const ele = prepared.coords[Math.min(wp.i, prepared.coords.length - 1)][2]
      const isManeuver = ['bear', 'turn', 'switchback'].includes(wp.kind)
      const post = new THREE.Mesh(postGeo, postMat)
      toWorld(prepared, lon, lat, ele + 0.67, post.position)
      post.renderOrder = 11
      g.add(post)
      const band = new THREE.Mesh(bandGeo, isManeuver ? bandManeuver : bandPoi)
      band.position.copy(post.position)
      band.position.y = ele + 1.18
      band.renderOrder = 11
      g.add(band)
    }
    // destination: tall moss beam + route name
    const end = prepared.coords[prepared.coords.length - 1]
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.7, 46, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: MOSS,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
    )
    toWorld(prepared, end[0], end[1], end[2] + 23, beam.position)
    g.add(beam)
    const endLabel = makeLabelSprite(prepared.name, { accent: '#9cab72', scale: 1 })
    toWorld(prepared, end[0], end[1], end[2] + 50, endLabel.position)
    endLabel.scale.multiplyScalar(26)
    g.add(endLabel)
    return g
  }, [prepared])

  useEffect(
    () => () => {
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh
        mesh.geometry?.dispose()
      })
    },
    [obj],
  )
  return <primitive object={obj} />
}

/* -------------------------------------------------------- off route guide */

function OffRouteGuide() {
  const marker = useRef<THREE.Mesh>(null)
  const lineObj = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3))
    const m = new THREE.LineDashedMaterial({
      color: AMBER,
      dashSize: 2.4,
      gapSize: 1.6,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      fog: false,
    })
    const l = new THREE.Line(g, m)
    l.visible = false
    l.frustumCulled = false
    l.renderOrder = 15
    return l
  }, [])
  const geo = lineObj.geometry as THREE.BufferGeometry

  useFrame(({ clock }) => {
    const st = useStore.getState()
    const off = st.nav?.offRoute
    const prepared = st.prepared
    const l = lineObj
    const mk = marker.current
    if (!l || !mk || !prepared || !off || st.nav?.phase !== 'offroute') {
      if (l) l.visible = false
      if (mk) mk.visible = false
      return
    }
    l.visible = true
    mk.visible = true
    const pose = st.pose
    const a = toWorld(prepared, pose.lon, pose.lat, pose.ele - 0.4, new THREE.Vector3())
    const bEle = st.patch ? st.patch.elevAt(off.lon, off.lat) + 0.6 : pose.ele
    const b = toWorld(prepared, off.lon, off.lat, bEle, new THREE.Vector3())
    const attr = geo.getAttribute('position') as THREE.BufferAttribute
    attr.setXYZ(0, a.x, a.y, a.z)
    attr.setXYZ(1, b.x, b.y, b.z)
    attr.needsUpdate = true
    l.computeLineDistances()
    mk.position.copy(b)
    mk.position.y += 1.4
    mk.rotation.y = clock.elapsedTime * 1.5
  })

  return (
    <>
      <primitive object={lineObj} />
      <mesh ref={marker} visible={false} renderOrder={15}>
        <octahedronGeometry args={[1.4, 0]} />
        <meshBasicMaterial color={AMBER} transparent opacity={0.95} depthWrite={false} fog={false} />
      </mesh>
    </>
  )
}

/* ------------------------------------------------------------- landmarks */

interface Poi {
  name: string
  kind: string
  lon: number
  lat: number
  ele: number
}

function Landmarks({ prepared }: { prepared: PreparedRoute }) {
  const holder = useRef<THREE.Group>(null)
  const lastKey = useRef('')
  const nextCheck = useRef(0)

  const pois: Poi[] = useMemo(() => {
    const region = useStore.getState().region
    if (!region) return []
    const out: Poi[] = []
    for (const f of region.pois.features) {
      const props = (f.properties ?? {}) as { name?: string; kind?: string; ele?: number }
      if (!props.name) continue
      const pt = f as Feature<Point>
      const [lon, lat] = pt.geometry.coordinates
      out.push({ name: props.name, kind: props.kind ?? 'landmark', lon, lat, ele: props.ele ?? 0 })
    }
    return out
  }, [prepared])

  useFrame(({ clock }) => {
    const g = holder.current
    if (!g) return
    if (clock.elapsedTime < nextCheck.current) return
    nextCheck.current = clock.elapsedTime + 0.8
    const st = useStore.getState()
    const pose = st.pose
    const patch = st.patch
    // nearest few POIs within range
    const scored = pois
      .map((p) => {
        const [px, py] = prepared.frame.toXY(p.lon, p.lat)
        const [ux, uy] = prepared.frame.toXY(pose.lon, pose.lat)
        const d = Math.hypot(px - ux, py - uy)
        return { p, d }
      })
      .filter((s) => s.d < 900 && s.d > 25)
      .sort((a, b) => a.d - b.d)
      .slice(0, 7)
    const key = scored.map((s) => `${s.p.name}:${Math.round(s.d / 30)}`).join('|')
    if (key === lastKey.current) return
    lastKey.current = key
    while (g.children.length) {
      const c = g.children[0] as THREE.Sprite
      g.remove(c)
      c.material.dispose()
    }
    const icons: Record<string, string> = {
      peak: '▲',
      saddle: '⌄',
      water: '●',
      parking: 'P',
      viewpoint: '◉',
      camp: '⌂',
      guidepost: '⚑',
    }
    for (const { p, d } of scored) {
      const ele = p.ele || (patch ? patch.elevAt(p.lon, p.lat) : pose.ele)
      const visible = patch
        ? patch.lineOfSight(pose.lon, pose.lat, pose.ele + 1, p.lon, p.lat, ele + 6)
        : true
      const sp = makeLabelSprite(p.name, {
        sub: fmtDistM(d),
        accent: '#cfc7b2',
        icon: icons[p.kind] ?? '◆',
        scale: 1,
      })
      toWorld(prepared, p.lon, p.lat, ele + 10 + d * 0.02, sp.position)
      const s = Math.min(30, Math.max(3.4, d * 0.062))
      sp.scale.multiplyScalar(s)
      sp.material.opacity = visible ? 0.92 : 0.28
      g.add(sp)
    }
  })

  return <group ref={holder} />
}

/* ----------------------------------------------------------------- root */

export default function RouteOverlay() {
  const prepared = useStore((s) => s.prepared)
  if (!prepared) return null
  return (
    <group>
      <RouteTube prepared={prepared} />
      <Chevrons prepared={prepared} />
      <WaypointStakes prepared={prepared} />
      <Beacon />
      <OffRouteGuide />
      <Landmarks prepared={prepared} />
    </group>
  )
}
