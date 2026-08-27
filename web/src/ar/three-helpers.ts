import * as THREE from 'three'
import type { LocalFrame } from '../geo/geo'
import type { TerrainGrid } from '../terrain/terrain'

/** deterministic RNG so the world looks identical on every visit */
export function seededRng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/* ------------------------------------------------------- label sprites */

export interface LabelOpts {
  sub?: string
  accent?: string
  icon?: string
  scale?: number
}

const labelCache = new Map<string, THREE.Texture>()

const TITLE_FONT = "'Barlow Condensed', 'Arial Narrow', -apple-system, sans-serif"
const SUB_FONT = "'Barlow', -apple-system, 'Segoe UI', Roboto, sans-serif"

/**
 * Floating spatial label: shadowed type with a short accent underline, no
 * card box. Rendered to a canvas texture so it works fully offline with the
 * bundled fonts.
 */
export function makeLabelSprite(title: string, opts: LabelOpts = {}): THREE.Sprite {
  const key = JSON.stringify([title, opts.sub, opts.accent, opts.icon])
  let tex = labelCache.get(key)
  let aspect = 1
  if (!tex) {
    const dpr = 2
    const pad = 16
    const titleSize = 32
    const subSize = 20
    const accent = opts.accent ?? '#cfc7b2'
    const c = document.createElement('canvas')
    const g = c.getContext('2d')!
    g.font = `600 ${titleSize}px ${TITLE_FONT}`
    const iconW = opts.icon ? titleSize * 1.05 : 0
    const titleW = g.measureText(title).width + iconW
    g.font = `500 ${subSize}px ${SUB_FONT}`
    const subW = opts.sub ? g.measureText(opts.sub).width : 0
    const w = Math.ceil(Math.max(titleW, subW) + pad * 2)
    const h = Math.ceil(titleSize + 10 + (opts.sub ? subSize + 12 : 6) + pad)
    c.width = w * dpr
    c.height = h * dpr
    const ctx = c.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.shadowColor = 'rgba(8, 8, 5, 0.85)'
    ctx.shadowBlur = 7
    ctx.shadowOffsetY = 2
    const cx = w / 2
    // title (+ optional icon prefix)
    ctx.font = `600 ${titleSize}px ${TITLE_FONT}`
    if (opts.icon) {
      ctx.fillStyle = accent
      ctx.fillText(opts.icon, cx - titleW / 2 + iconW / 2 - 4, 8)
      ctx.fillStyle = '#e8e4d6'
      ctx.fillText(title, cx + iconW / 2, 8)
    } else {
      ctx.fillStyle = '#e8e4d6'
      ctx.fillText(title, cx, 8)
    }
    // accent underline
    ctx.fillStyle = accent
    ctx.fillRect(cx - 15, titleSize + 12, 30, 3)
    if (opts.sub) {
      ctx.font = `500 ${subSize}px ${SUB_FONT}`
      ctx.fillStyle = 'rgba(232, 228, 214, 0.85)'
      ctx.fillText(opts.sub, cx, titleSize + 23)
    }
    tex = new THREE.CanvasTexture(c)
    tex.anisotropy = 4
    tex.colorSpace = THREE.SRGBColorSpace
    ;(tex as THREE.Texture & { userData: { aspect: number } }).userData = { aspect: w / h }
    labelCache.set(key, tex)
  }
  aspect = (tex.userData as { aspect?: number })?.aspect ?? 3
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
  })
  const sp = new THREE.Sprite(mat)
  const s = opts.scale ?? 1
  sp.scale.set(aspect * s, s, 1)
  sp.renderOrder = 50
  return sp
}

/* ------------------------------------------------------ terrain geometry */

/** ground color ramps for the simulated world, per region character */
export const TERRAIN_PALETTES = {
  desert: {
    low: '#b39a6f', // sandy wash
    mid: '#96805f', // desert soil
    rock: '#8a7a68', // granite slopes
    high: '#a89684', // pale summit granite
    scrub: '#6f7a4e', // scattered scrub tint
    scrubChance: 0.14,
  },
  hills: {
    low: '#a89c60', // dry summer grass
    mid: '#948b4f', // golden hillside
    rock: '#7d7a52', // serpentine outcrop
    high: '#a49a62', // ridgeline grass
    scrub: '#46512f', // oak and eucalyptus stands
    scrubChance: 0.3,
  },
  coastal: {
    low: '#b3a67c', // beach sand
    mid: '#98916a', // bluff scrub
    rock: '#857c64', // sea cliffs
    high: '#93906c', // headland grass
    scrub: '#4f5f3d', // cypress stands
    scrubChance: 0.24,
  },
} as const

export type TerrainPalette = keyof typeof TERRAIN_PALETTES

/**
 * Terrain mesh for the simulated world, in the route's local frame:
 * x = east meters, z = -north meters, y = elevation ASL.
 */
export function buildTerrainGeometry(
  grid: TerrainGrid,
  frame: LocalFrame,
  maxVerts = 240,
  palette: TerrainPalette = 'desert',
): THREE.BufferGeometry {
  const [wm0, ym0] = frame.toXY(grid.west, grid.south)
  const [wm1, ym1] = frame.toXY(grid.east, grid.north)
  const nx = Math.min(grid.w, maxVerts)
  const ny = Math.min(grid.h, maxVerts)
  const pos = new Float32Array(nx * ny * 3)
  const col = new Float32Array(nx * ny * 3)
  const rng = seededRng(1234567)
  const [lo, hi] = grid.range
  const tmp = new THREE.Color()
  const pal = TERRAIN_PALETTES[palette]
  const COL_LOW = new THREE.Color(pal.low)
  const COL_MID = new THREE.Color(pal.mid)
  const COL_ROCK = new THREE.Color(pal.rock)
  const COL_HIGH = new THREE.Color(pal.high)
  const COL_SCRUB = new THREE.Color(pal.scrub)

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const fx = i / (nx - 1)
      const fy = j / (ny - 1)
      const lon = grid.west + fx * (grid.east - grid.west)
      // grid rows are mercator-spaced; linear lat interpolation is fine at this scale
      const lat = grid.north + fy * (grid.south - grid.north)
      const ele = grid.elevAt(lon, lat)
      const x = wm0 + fx * (wm1 - wm0)
      const north = ym1 + fy * (ym0 - ym1)
      const k = (j * nx + i) * 3
      pos[k] = x
      pos[k + 1] = ele
      pos[k + 2] = -north

      // color by relative elevation + noise; slope shading comes from lights
      const t = (ele - lo) / Math.max(1, hi - lo)
      if (t < 0.25) tmp.copy(COL_LOW).lerp(COL_MID, t / 0.25)
      else if (t < 0.6) tmp.copy(COL_MID).lerp(COL_ROCK, (t - 0.25) / 0.35)
      else tmp.copy(COL_ROCK).lerp(COL_HIGH, (t - 0.6) / 0.4)
      const n = rng()
      if (n > 1 - pal.scrubChance && t < 0.55) tmp.lerp(COL_SCRUB, 0.4)
      const v = 0.92 + rng() * 0.16
      col[k] = tmp.r * v
      col[k + 1] = tmp.g * v
      col[k + 2] = tmp.b * v
    }
  }

  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6)
  let p = 0
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i
      const b = a + 1
      const c = a + nx
      const d = c + 1
      idx[p++] = a
      idx[p++] = c
      idx[p++] = b
      idx[p++] = b
      idx[p++] = c
      idx[p++] = d
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  geo.computeVertexNormals()
  return geo
}

/** flat arrow/chevron pointing along -Z, lying in the XZ plane */
export function chevronGeometry(size = 1): THREE.BufferGeometry {
  const s = size
  const shape = new THREE.Shape()
  // chevron: two strokes meeting at a point
  shape.moveTo(-0.62 * s, 0.5 * s)
  shape.lineTo(0, -0.5 * s)
  shape.lineTo(0.62 * s, 0.5 * s)
  shape.lineTo(0.62 * s, 0.05 * s)
  shape.lineTo(0, -0.95 * s)
  shape.lineTo(-0.62 * s, 0.05 * s)
  shape.closePath()
  const g = new THREE.ShapeGeometry(shape)
  g.rotateX(-Math.PI / 2) // lay flat: shape y becomes -z
  return g
}

/** sky dome with a simple atmosphere gradient + sun glow */
export function makeSky(sunDir: THREE.Vector3): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      sunDir: { value: sunDir.clone().normalize() },
      zenith: { value: new THREE.Color('#6ea7d8') },
      horizon: { value: new THREE.Color('#dcd3bd') },
      ground: { value: new THREE.Color('#8c7d63') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 sunDir;
      uniform vec3 zenith;
      uniform vec3 horizon;
      uniform vec3 ground;
      void main() {
        float h = clamp(vDir.y, -1.0, 1.0);
        vec3 col = h >= 0.0
          ? mix(horizon, zenith, pow(h, 0.55))
          : mix(horizon, ground, clamp(-h * 3.0, 0.0, 1.0));
        float sun = pow(max(dot(vDir, sunDir), 0.0), 600.0);
        float glow = pow(max(dot(vDir, sunDir), 0.0), 8.0);
        col += vec3(1.0, 0.92, 0.75) * sun * 1.2 + vec3(1.0, 0.85, 0.6) * glow * 0.22;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(7000, 32, 18), mat)
  mesh.frustumCulled = false
  mesh.renderOrder = -100
  return mesh
}
