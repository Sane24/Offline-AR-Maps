import { useStore } from '../app/store'
import { fmtDistM, fmtDurMin } from './format'
import ElevationProfile from './ElevationProfile'

export default function RoutePanel() {
  const region = useStore((s) => s.region)
  const activeRouteId = useStore((s) => s.activeRouteId)
  const prepared = useStore((s) => s.prepared)
  const flythrough = useStore((s) => s.flythrough)
  const selectRoute = useStore((s) => s.selectRoute)
  const setFlythrough = useStore((s) => s.setFlythrough)
  const startNav = useStore((s) => s.startNav)
  const clearCustomRoute = useStore((s) => s.clearCustomRoute)

  if (!region || !prepared) return null
  const routeIds = Object.keys(region.routes)

  return (
    <div className="route-panel">
      <div className="route-card panel">
        {routeIds.length > 1 && (
          <div className="route-tabs">
            {routeIds.map((id) => (
              <button
                key={id}
                className={`route-tab ${id === activeRouteId ? 'on' : ''}`}
                onClick={() => selectRoute(id)}
              >
                {region.routes[id].name}
              </button>
            ))}
          </div>
        )}
        <div className="route-title">{prepared.name}</div>
        {prepared.blurb && <div className="route-blurb">{prepared.blurb}</div>}
        <div className="route-stats">
          <div className="stat">
            <span className="v num">{fmtDistM(prepared.stats.lengthM)}</span>
            <span className="k">length</span>
          </div>
          <div className="stat">
            <span className="v num">+{prepared.stats.gainM} m</span>
            <span className="k">climb</span>
          </div>
          <div className="stat">
            <span className="v num">{fmtDurMin(prepared.stats.estMin)}</span>
            <span className="k">est. time</span>
          </div>
          <div className="stat">
            <span className="v num">{prepared.waypoints.length - 2}</span>
            <span className="k">waypoints</span>
          </div>
        </div>
        <ElevationProfile height={44} />
        <div className="actions-row">
          <button className="btn quiet" onClick={() => setFlythrough(!flythrough)}>
            {flythrough ? 'Stop flyover' : 'Preview flyover'}
          </button>
          <button className="btn primary" onClick={startNav}>
            Start navigation
          </button>
        </div>
        {activeRouteId === 'custom' && (
          <div className="actions-row">
            <button className="btn quiet small" onClick={clearCustomRoute}>
              Discard custom route
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
