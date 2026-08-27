import { useEffect, useRef } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { controller, useStore } from '../app/store'
import { CameraFeed } from '../sensors/camera'
import CameraRig, { frameRouteInOrbit, orbitState } from './CameraRig'
import SimWorld from './SimWorld'
import RouteOverlay from './RouteOverlay'

const feed = new CameraFeed()

/**
 * Dev aid: browsers stop requestAnimationFrame in occluded tabs, which
 * freezes the canvas during automated captures. When rAF goes quiet, drive
 * the frame loop manually. DEV builds only.
 */
function DevFramePump() {
  const three = useThree()
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__three = three
    let raf = 0
    let lastRaf = performance.now()
    const mark = () => {
      lastRaf = performance.now()
      raf = requestAnimationFrame(mark)
    }
    raf = requestAnimationFrame(mark)
    const timer = setInterval(() => {
      if (performance.now() - lastRaf > 250) three.advance(performance.now() / 1000)
    }, 33)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(timer)
    }
  }, [three])
  return null
}

/**
 * The shared 3D viewport for both the explore (orbit) and AR (first person)
 * modes. Background is either the synthetic terrain world or, on devices
 * that grant it, the live rear camera feed.
 */
export default function Scene3D() {
  const cameraOn = useStore((s) => s.cameraOn)
  const prepared = useStore((s) => s.prepared)
  const videoRef = useRef<HTMLVideoElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinchDist = useRef(0)

  // frame the orbit camera whenever the route changes
  useEffect(() => {
    if (prepared) frameRouteInOrbit(prepared)
  }, [prepared])

  // camera feed lifecycle
  useEffect(() => {
    const video = videoRef.current
    if (!cameraOn || !video) return
    let cancelled = false
    feed.start(video).then((state) => {
      if (cancelled) return
      if (state !== 'granted') {
        useStore.getState().setCameraOn(false)
        useStore
          .getState()
          .setToast(
            state === 'denied'
              ? 'Camera access denied. Showing the simulated terrain instead.'
              : 'No camera available here. Showing the simulated terrain.',
          )
      }
    })
    return () => {
      cancelled = true
      feed.stop(video)
    }
  }, [cameraOn])

  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinchDist.current = Math.hypot(a.x - b.x, a.y - b.y)
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    const dx = e.clientX - prev.x
    const dy = e.clientY - prev.y
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const st = useStore.getState()

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinchDist.current > 0 && st.mode === 'explore') {
        orbitState.dist *= pinchDist.current / d
      }
      pinchDist.current = d
      return
    }

    if (st.mode === 'ar') {
      if (st.cfg.oriSource === 'pointer') controller.addLook(dx * 0.26, dy * 0.26)
    } else if (st.mode === 'explore' && !st.flythrough) {
      orbitState.az -= dx * 0.006
      orbitState.polar -= dy * 0.005
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    pinchDist.current = 0
  }

  const onWheel = (e: React.WheelEvent) => {
    const st = useStore.getState()
    if (st.mode === 'explore') {
      orbitState.dist *= 1 + e.deltaY * 0.0011
    } else if (st.mode === 'ar' && st.cfg.oriSource === 'pointer') {
      controller.addLook(0, e.deltaY * 0.05)
    }
  }

  return (
    <div
      className="viewport"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      style={{ touchAction: 'none' }}
    >
      {cameraOn && <video ref={videoRef} className="camera-feed" playsInline muted />}
      <Canvas
        gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
        dpr={[1, 2]}
        style={{ position: 'absolute', inset: 0, background: 'transparent' }}
        camera={{ fov: 60, near: 0.4, far: 16000 }}
      >
        <CameraRig />
        {import.meta.env.DEV && <DevFramePump />}
        {!cameraOn && <SimWorld />}
        <RouteOverlay />
      </Canvas>
    </div>
  )
}
