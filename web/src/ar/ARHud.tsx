import { useEffect, useRef, useState } from 'react'
import { controller, useStore } from '../app/store'
import { fmtDistM, fmtDurMin, fmtEle } from '../ui/format'
import { compass16, wrap360 } from '../geo/geo'
import ElevationProfile from '../ui/ElevationProfile'
import {
  Alert,
  ArrowLeftTurn,
  ArrowRightTurn,
  ArrowUp,
  BearLeft,
  BearRight,
  CameraIcon,
  CompassIcon,
  Flag,
  GpsIcon,
  Pause,
  Peak,
  Play,
  Switchback,
  UTurn,
} from '../ui/icons'

/* ------------------------------------------------------------ compass */

const INK = 'rgba(232, 228, 214, 0.95)'
const DIM = 'rgba(165, 162, 145, 0.55)'
const NORTH = '#d0684a'
const FONT = "'Barlow Condensed', -apple-system, system-ui, sans-serif"

function CompassTape() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    let raf = 0
    const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const st = useStore.getState()
      const dpr = Math.min(devicePixelRatio, 2)
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w === 0) return
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const heading = st.pose.heading
      const pxPerDeg = w / 110
      const cx = w / 2

      ctx.shadowColor = 'rgba(10, 10, 6, 0.6)'
      ctx.shadowBlur = 3
      ctx.shadowOffsetY = 1
      ctx.textAlign = 'center'
      for (let d = -60; d <= 60; d += 5) {
        const deg = wrap360(heading + d)
        const x = cx + d * pxPerDeg
        const major = deg % 45 === 0
        const mid = deg % 15 === 0
        ctx.strokeStyle = major ? INK : DIM
        ctx.lineWidth = major ? 1.6 : 1
        const th = major ? 8 : mid ? 5.5 : 3
        ctx.beginPath()
        ctx.moveTo(x, h - 8)
        ctx.lineTo(x, h - 8 - th)
        ctx.stroke()
        if (major) {
          const name = CARD[Math.round(deg / 45) % 8]
          ctx.fillStyle = name === 'N' ? NORTH : INK
          ctx.font = `600 13px ${FONT}`
          ctx.fillText(name, x, h - 22)
        }
      }
      // heading readout
      ctx.fillStyle = INK
      ctx.font = `600 12px ${FONT}`
      ctx.fillText(`${String(Math.round(heading)).padStart(3, '0')}°`, cx, 11)

      // bearing markers on the tape
      const mark = (rel: number, color: string) => {
        const x = cx + Math.max(-w / 2 + 12, Math.min(w / 2 - 12, rel * pxPerDeg))
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.moveTo(x, h - 18)
        ctx.lineTo(x + 4.5, h - 12)
        ctx.lineTo(x, h - 6)
        ctx.lineTo(x - 4.5, h - 12)
        ctx.closePath()
        ctx.fill()
      }
      const nav = st.nav
      if (nav?.phase === 'offroute' && nav.offRoute) mark(nav.offRoute.relBearing, '#dca43e')
      else if (nav?.next) mark(nav.next.relBearing, nav.next.wp.kind === 'arrive' ? '#9cab72' : '#f07b31')
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="tape">
      <canvas ref={canvasRef} />
      <div className="tape-caret" />
    </div>
  )
}

/* ----------------------------------------------------------- guidance */

function maneuverIcon(phase: string, kind: string, dir?: 'left' | 'right', reorient?: boolean) {
  const size = 26
  if (phase === 'offroute') return <Alert size={size} />
  if (phase === 'arrived') return <Flag size={size} />
  if (reorient) return <UTurn size={size} />
  switch (kind) {
    case 'bear':
      return dir === 'left' ? <BearLeft size={size} /> : <BearRight size={size} />
    case 'turn':
      return dir === 'left' ? <ArrowLeftTurn size={size} /> : <ArrowRightTurn size={size} />
    case 'switchback':
      return <Switchback size={size} />
    case 'peak':
      return <Peak size={size} />
    case 'arrive':
      return <Flag size={size} />
    default:
      return <ArrowUp size={size} />
  }
}

function GuidanceReadout() {
  const guidance = useStore((s) => s.guidance)
  const phase = useStore((s) => s.nav?.phase ?? 'navigate')
  const kind = useStore((s) => s.nav?.next?.wp.kind ?? '')
  const dir = useStore((s) => s.nav?.next?.wp.dir)
  if (!guidance) return null
  return (
    <div className={`guide ${guidance.tone === 'ok' ? '' : guidance.tone}`}>
      <div className="g-eyebrow">{guidance.eyebrow}</div>
      <div className="g-title">
        {maneuverIcon(phase, kind, dir, guidance.reorient)}
        {guidance.title}
      </div>
      {guidance.sub && <div className="g-sub">{guidance.sub}</div>}
    </div>
  )
}

/* ------------------------------------------------------------ minimap */

function Minimap() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [big, setBig] = useState(false)
  const bigRef = useRef(big)
  bigRef.current = big

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const timer = setInterval(() => {
      const st = useStore.getState()
      const prepared = st.prepared
      const dpr = Math.min(devicePixelRatio, 2)
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w === 0 || !prepared) return
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const cx = w / 2
      const cy = h / 2
      // meters from center to edge: expanded shows the wider picture
      const RANGE = bigRef.current ? 900 : 320
      const scale = Math.min(w, h) / 2 / RANGE
      const [ux, uy] = prepared.frame.toXY(st.pose.lon, st.pose.lat)
      const rot = (-st.pose.heading * Math.PI) / 180

      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(rot)

      // route line, split at current position
      const along = st.nav?.snap.alongM ?? 0
      const drawPart = (fromIdx: number, toIdx: number, color: string, width: number) => {
        ctx.strokeStyle = color
        ctx.lineWidth = width
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()
        let started = false
        for (let i = fromIdx; i <= toIdx; i++) {
          const x = (prepared.xy[i * 2] - ux) * scale
          const y = -(prepared.xy[i * 2 + 1] - uy) * scale
          if (Math.abs(x) > w && Math.abs(y) > h) continue
          if (!started) {
            ctx.moveTo(x, y)
            started = true
          } else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
      const n = prepared.coords.length
      let curIdx = 0
      while (curIdx < n - 1 && prepared.cum[curIdx + 1] < along) curIdx++
      drawPart(0, curIdx, 'rgba(232, 228, 214, 0.3)', 2.5)
      drawPart(curIdx, n - 1, '#f07b31', 3)

      // next waypoint
      const next = st.nav?.next
      if (next) {
        const [wx, wy] = prepared.frame.toXY(next.lon, next.lat)
        let x = (wx - ux) * scale
        let y = -(wy - uy) * scale
        const r = Math.hypot(x, y)
        const maxR = Math.min(w, h) / 2 - 8
        if (r > maxR) {
          x = (x / r) * maxR
          y = (y / r) * maxR
        }
        ctx.fillStyle = next.wp.kind === 'arrive' ? '#9cab72' : '#e8e4d6'
        ctx.beginPath()
        ctx.arc(x, y, 3.5, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()

      // user marker (always center, pointing up)
      ctx.fillStyle = '#e8e4d6'
      ctx.strokeStyle = 'rgba(20, 22, 15, 0.8)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(cx, cy - 8)
      ctx.lineTo(cx + 5.5, cy + 6)
      ctx.lineTo(cx, cy + 2.5)
      ctx.lineTo(cx - 5.5, cy + 6)
      ctx.closePath()
      ctx.stroke()
      ctx.fill()

      // north indicator on the rim
      const nAng = rot - Math.PI / 2
      const rr = Math.min(w, h) / 2 - 10
      ctx.fillStyle = NORTH
      ctx.font = `600 11px ${FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('N', cx + Math.cos(nAng) * rr, cy + Math.sin(nAng) * rr)
    }, 90)
    return () => clearInterval(timer)
  }, [])

  return (
    <button
      className={`minimap ${big ? 'big' : ''}`}
      onClick={() => setBig(!big)}
      title={big ? 'Shrink the overview' : 'Expand the overview'}
    >
      <canvas ref={canvasRef} />
    </button>
  )
}

/* ------------------------------------------------------------ controls */

function Controls() {
  const cfg = useStore((s) => s.cfg)
  const cameraOn = useStore((s) => s.cameraOn)
  const setCfg = useStore((s) => s.setCfg)
  const setCameraOn = useStore((s) => s.setCameraOn)
  const enableDeviceOrientation = useStore((s) => s.enableDeviceOrientation)
  const enableGps = useStore((s) => s.enableGps)
  const useSim = useStore((s) => s.useSimulatedPosition)
  const calibrate = useStore((s) => s.calibrateToTrail)

  const speeds = [1, 2, 4, 8]
  const nextSpeed = () => {
    const i = speeds.indexOf(cfg.simSpeed)
    setCfg({ simSpeed: speeds[(i + 1) % speeds.length] })
  }

  return (
    <>
      {cfg.posSource === 'sim' && (
        <>
          <button
            className="ictl"
            onClick={() => setCfg({ playing: !cfg.playing })}
            title="Play / pause the walk (space)"
          >
            {cfg.playing ? <Pause /> : <Play />}
          </button>
          <button className="ictl wide num" onClick={nextSpeed} title="Walk speed">
            {cfg.simSpeed}×
          </button>
          <button
            className="ictl wide"
            onClick={() => controller.stepLateral(-8)}
            title="Drift off the trail to the left (A)"
          >
            ⇠ off
          </button>
          <button
            className="ictl wide"
            onClick={() => controller.stepLateral(8)}
            title="Drift off the trail to the right (D)"
          >
            off ⇢
          </button>
        </>
      )}
      <button
        className={`ictl ${cameraOn ? 'on' : ''}`}
        onClick={() => setCameraOn(!cameraOn)}
        title="Use the live camera as the AR background"
      >
        <CameraIcon />
      </button>
      <button
        className={`ictl ${cfg.oriSource === 'device' ? 'on' : ''}`}
        onClick={() =>
          cfg.oriSource === 'device' ? setCfg({ oriSource: 'pointer' }) : enableDeviceOrientation()
        }
        title="Steer the view with the phone's motion sensors"
      >
        <CompassIcon />
      </button>
      <button
        className={`ictl ${cfg.posSource === 'gps' ? 'on' : ''}`}
        onClick={() => (cfg.posSource === 'gps' ? useSim() : enableGps())}
        title="Use device GPS instead of the simulated walk"
      >
        <GpsIcon />
      </button>
      {cfg.oriSource === 'device' && (
        <button className="ictl wide" onClick={calibrate} title="Align the compass to the trail ahead">
          align
        </button>
      )}
    </>
  )
}

/* ------------------------------------------------------- instrument bar */

function NavBar() {
  const name = useStore((s) => s.prepared?.name ?? '')
  const ele = useStore((s) => fmtEle(s.pose.ele))
  const dirNow = useStore((s) => compass16(s.pose.heading))
  const remain = useStore((s) => (s.nav ? fmtDistM(s.nav.remainM) : '--'))
  const eta = useStore((s) => (s.nav ? fmtDurMin(s.nav.etaMin) : '--'))
  const climb = useStore((s) => (s.nav ? Math.round(s.nav.remainGainM) : 0))
  const regionReady = useStore((s) => {
    const id = s.region?.manifest.id
    return id ? s.regionUI[id]?.state === 'ready' : false
  })
  const stopNav = useStore((s) => s.stopNav)

  return (
    <div className="navbar panel">
      <div className="nb-main">
        <div className="nb-dest">
          <div className="name">{name}</div>
          <div className="sub num">
            {ele} · facing {dirNow}
          </div>
        </div>
        <div className="nb-spark">
          <ElevationProfile height={40} />
        </div>
        <div className="nb-dist">
          <div className="v num">{remain}</div>
          <div className="sub num">
            {eta} · +{climb} m
          </div>
        </div>
      </div>
      <div className="nb-foot">
        <div className={`nb-offline ${regionReady ? '' : 'stream'}`}>
          <span className="dot" />
          <span className="nb-offline-label">
            {regionReady ? 'Offline maps ready' : 'Streaming maps'}
          </span>
        </div>
        <Controls />
        <button className="nb-end" onClick={stopNav}>
          End
        </button>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------- edge arrows */

function EdgeArrows() {
  const rel = useStore((s) => {
    if (!s.nav) return 0
    if (s.nav.phase === 'offroute' && s.nav.offRoute) return s.nav.offRoute.relBearing
    return s.nav.next?.relBearing ?? 0
  })
  const warn = useStore((s) => s.nav?.phase === 'offroute')
  if (Math.abs(rel) < 42) return null
  const side = rel < 0 ? 'left' : 'right'
  return (
    <div className={`edge-arrow ${side} ${warn ? 'warn' : ''}`}>
      <svg width="36" height="58" viewBox="0 0 40 64" fill="none">
        {side === 'left' ? (
          <path d="M30 8 10 32l20 24" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="m10 8 20 24-20 24" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </div>
  )
}

/* ---------------------------------------------------------------- root */

export default function ARHud() {
  const oriSource = useStore((s) => s.cfg.oriSource)
  const [showHint, setShowHint] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => setShowHint(false), 7000)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const KEYMAP: Record<string, 'w' | 'a' | 's' | 'd'> = {
      w: 'w',
      a: 'a',
      s: 's',
      d: 'd',
      arrowup: 'w',
      arrowleft: 'a',
      arrowdown: 's',
      arrowright: 'd',
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        e.preventDefault()
        const st = useStore.getState()
        st.setCfg({ playing: !st.cfg.playing })
        return
      }
      const k = KEYMAP[e.key.toLowerCase()]
      if (k) {
        controller.keys[k] = true
        e.preventDefault()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      const k = KEYMAP[e.key.toLowerCase()]
      if (k) controller.keys[k] = false
    }
    const clear = () => controller.clearKeys()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', clear)
      clear()
    }
  }, [])

  return (
    <div className="hud">
      <div className="hud-top">
        <CompassTape />
        <GuidanceReadout />
      </div>
      <Minimap />
      <EdgeArrows />
      {showHint && oriSource === 'pointer' && (
        <div className="hint">Drag to look around · WASD to walk · space auto-walks</div>
      )}
      <div className="hud-bottom">
        <NavBar />
      </div>
    </div>
  )
}
