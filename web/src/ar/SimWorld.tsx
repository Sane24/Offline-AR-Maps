import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '../app/store'
import { buildTerrainGeometry, makeSky, seededRng } from './three-helpers'
import { LocalFrame } from '../geo/geo'

const FOG_COLOR = new THREE.Color('#d8cfba')

/**
 * Synthetic first-person world for desktop demos: the same DEM that powers
 * the AR ground plane, rendered as rocky high desert. On a phone this whole
 * component is swapped out for the live camera feed.
 *
 * Two terrain meshes share the scene: the high-res route corridor for
 * first-person scale, and the region-wide grid for orbit scale (so the
 * corridor's edges never show as cliffs). Visibility flips with the mode.
 */
export default function SimWorld() {
  const patch = useStore((s) => s.patch)
  const regionGrid = useStore((s) => s.region?.terrain ?? null)
  const prepared = useStore((s) => s.prepared)
  const scene = useThree((s) => s.scene)

  const world = useMemo(() => {
    if (!patch || !prepared) return null
    const frame: LocalFrame = prepared.frame
    const group = new THREE.Group()

    // sun + sky
    const sunAz = (250 * Math.PI) / 180
    const sunAlt = (38 * Math.PI) / 180
    const sunDir = new THREE.Vector3(
      Math.sin(sunAz) * Math.cos(sunAlt),
      Math.sin(sunAlt),
      -Math.cos(sunAz) * Math.cos(sunAlt),
    )
    const sky = makeSky(sunDir)
    sky.name = 'sky'
    group.add(sky)

    const sun = new THREE.DirectionalLight('#ffe8c4', 2.6)
    sun.position.copy(sunDir).multiplyScalar(4000)
    group.add(sun)
    group.add(new THREE.HemisphereLight('#bcd8f2', '#7a6a52', 0.85))

    // near terrain: the high-res corridor around the route
    const near = new THREE.Mesh(
      buildTerrainGeometry(patch, frame, 340),
      new THREE.MeshLambertMaterial({ vertexColors: true }),
    )
    near.name = 'terrain-near'
    group.add(near)

    // far terrain: the whole region, for orbit and flyover framing
    if (regionGrid && regionGrid !== patch) {
      const far = new THREE.Mesh(
        buildTerrainGeometry(regionGrid, frame, 340),
        new THREE.MeshLambertMaterial({ vertexColors: true }),
      )
      far.name = 'terrain-far'
      far.visible = false
      group.add(far)
    }

    // distant ground plane so terrain edges fade into haze instead of sky
    const lowest = Math.min(patch.range[0], regionGrid?.range[0] ?? Infinity)
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(40000, 48),
      new THREE.MeshLambertMaterial({ color: '#b6a37d' }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = lowest - 4
    group.add(ground)

    // scattered boulders, denser near slopes
    const rng = seededRng(97531)
    const rockGeo = new THREE.DodecahedronGeometry(1, 0)
    const rockMat = new THREE.MeshLambertMaterial({ flatShading: true })
    const COUNT = 550
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, COUNT)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const col = new THREE.Color()
    const [w0] = frame.toXY(patch.west, patch.south)
    const [w1] = frame.toXY(patch.east, patch.south)
    const [, s0] = frame.toXY(patch.west, patch.south)
    const [, s1] = frame.toXY(patch.west, patch.north)
    let placed = 0
    let guard = 0
    while (placed < COUNT && guard++ < COUNT * 8) {
      const x = w0 + rng() * (w1 - w0)
      const north = s0 + rng() * (s1 - s0)
      const [lon, lat] = frame.toLonLat(x, north)
      const ele = patch.elevAt(lon, lat)
      // avoid dropping rocks onto the trail corridor
      let nearRoute = false
      for (let i = 0; i < prepared.xy.length; i += 8) {
        const dx = prepared.xy[i] - x
        const dy = prepared.xy[i + 1] - north
        if (dx * dx + dy * dy < 90) {
          nearRoute = true
          break
        }
      }
      if (nearRoute) continue
      const s = 0.5 + Math.pow(rng(), 2.2) * 2.6
      e.set(rng() * 0.5, rng() * Math.PI * 2, rng() * 0.5)
      q.setFromEuler(e)
      m.compose(
        new THREE.Vector3(x, ele + s * 0.22, -north),
        q,
        new THREE.Vector3(s, s * (0.55 + rng() * 0.4), s),
      )
      rocks.setMatrixAt(placed, m)
      col.setHSL(0.08 + rng() * 0.03, 0.16 + rng() * 0.08, 0.38 + rng() * 0.16)
      rocks.setColorAt(placed, col)
      placed++
    }
    rocks.count = placed
    rocks.instanceMatrix.needsUpdate = true
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true
    group.add(rocks)

    return group
  }, [patch, regionGrid, prepared])

  const mode = useStore((s) => s.mode)
  const flythrough = useStore((s) => s.flythrough)
  const nearGround = mode === 'ar' || flythrough
  useEffect(() => {
    // haze reads right up close but buries the terrain at orbit distance
    scene.fog = nearGround
      ? new THREE.Fog(FOG_COLOR, 700, 5600)
      : new THREE.Fog(FOG_COLOR, 2200, 12000)
    return () => {
      scene.fog = null
    }
  }, [scene, nearGround])

  useEffect(() => {
    if (!world) return
    const near = world.getObjectByName('terrain-near')
    const far = world.getObjectByName('terrain-far')
    if (near) near.visible = nearGround || !far
    if (far) far.visible = !nearGround
  }, [world, nearGround])

  // keep the sky dome centered on the viewer
  const skyRef = useRef<THREE.Object3D | null>(null)
  useEffect(() => {
    skyRef.current = world?.getObjectByName('sky') ?? null
  }, [world])
  useFrame(({ camera }) => {
    skyRef.current?.position.copy(camera.position)
  })

  useEffect(() => {
    return () => {
      if (!world) return
      world.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose())
        else mat?.dispose()
      })
    }
  }, [world])

  if (!world) return null
  return <primitive object={world} />
}
