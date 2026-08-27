import { Component, type ReactNode } from 'react'
import { useStore } from './store'
import StatusBar from './StatusBar'
import Onboarding from './Onboarding'
import ARView from '../ar/ARView'
import ARHud from '../ar/ARHud'
import MapView from '../maps/MapView'
import RoutePanel from '../ui/RoutePanel'
import OfflinePanel from '../offline/OfflinePanel'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="boot-error">
          <div className="panel-box">
            <b>Something went wrong rendering the app.</b>
            <br />
            {String(this.state.error?.message ?? this.state.error)}
            <br />
            <button className="btn primary" style={{ marginTop: 14 }} onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function Shell() {
  const booted = useStore((s) => s.booted)
  const bootError = useStore((s) => s.bootError)
  const onboarded = useStore((s) => s.onboarded)
  const mode = useStore((s) => s.mode)
  const regionsOpen = useStore((s) => s.regionsOpen)
  const setRegionsOpen = useStore((s) => s.setRegionsOpen)
  const toast = useStore((s) => s.toast)

  if (!booted) {
    return (
      <div className="loading-veil">
        <div className="mark">TRAILSIGHT</div>
      </div>
    )
  }

  const sheetOpen = mode !== 'map' && regionsOpen

  return (
    <div className={`app${sheetOpen ? ' sheet-open' : ''}`}>
      {mode !== 'map' && <ARView />}
      {mode === 'map' && <MapView />}
      <StatusBar />
      {mode === 'ar' && <ARHud />}
      {mode === 'explore' && <RoutePanel />}
      {sheetOpen && <OfflinePanel onClose={() => setRegionsOpen(false)} />}
      {!onboarded && <Onboarding />}
      {bootError && (
        <div className="boot-error">
          <div className="panel-box">{bootError}</div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <Shell />
    </ErrorBoundary>
  )
}
