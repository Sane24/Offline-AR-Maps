import { useStore } from './store'
import { fmtBytes } from '../ui/format'
import { Logo } from '../ui/icons'

/**
 * First-run briefing: one screen, then straight into the demo.
 * Offers the region download up front so the offline story is part of
 * the first minute, not buried in a settings panel.
 */
export default function Onboarding() {
  const finish = useStore((s) => s.finishOnboarding)
  const catalog = useStore((s) => s.catalog)
  const regionUI = useStore((s) => s.regionUI)
  const download = useStore((s) => s.download)

  const demo = catalog?.regions[0]
  const ui = demo ? regionUI[demo.id] : undefined
  const saved = ui?.state === 'ready'
  const downloading = ui?.state === 'downloading'

  return (
    <div className="onboard">
      <div className="onboard-inner">
        <div className="brand-row">
          <Logo size={17} />
          TRAILSIGHT
        </div>
        <h1>Point your phone at the terrain. See the way.</h1>
        <p className="lede">
          An offline navigator for trails that are easy to lose — rocky washes, open desert,
          unsigned junctions. Maps, elevation, and routes are stored on this device, and guidance
          is drawn into the camera view, anchored to the ground in front of you.
        </p>

        {demo && (
          <div className="region-offer">
            <div className="micro">Demo region</div>
            <div className="region-name">{demo.name.split(' - ')[0]}</div>
            <div className="region-sub">
              {demo.routes.map((r) => r.name).join(' · ')} · real OpenStreetMap and elevation data
            </div>
            <div className="region-row">
              {saved ? (
                <span className="region-badge">✓ Stored on this device</span>
              ) : downloading ? (
                <>
                  <div className="progress">
                    <div style={{ width: `${Math.round((ui?.pct ?? 0) * 100)}%` }} />
                  </div>
                  <span className="num" style={{ fontSize: 12, color: 'var(--dim)' }}>
                    {Math.round((ui?.pct ?? 0) * 100)}%
                  </span>
                </>
              ) : (
                <>
                  <button className="btn small" onClick={() => download(demo.id)}>
                    Download for offline use
                  </button>
                  <span className="num" style={{ fontSize: 12, color: 'var(--faint)' }}>
                    {fmtBytes(demo.bytes)}
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        <div className="cta-row">
          <button className="btn primary" onClick={finish}>
            {saved ? 'Start navigating' : 'Open the demo'}
          </button>
        </div>

        <p className="foot">
          On a laptop, a simulated walk moves you through the real terrain data and the camera is
          stood in by a rendered desert. On a phone, the live camera, compass, and GPS take over —
          the guidance is the same either way.
        </p>
      </div>
    </div>
  )
}
