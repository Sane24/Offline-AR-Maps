import { useStore, type Mode } from './store'
import { isDownloaded } from '../offline/regions'
import { Logo } from '../ui/icons'

const MODES: { id: Mode; label: string }[] = [
  { id: 'map', label: 'Map' },
  { id: 'explore', label: '3D' },
  { id: 'ar', label: 'AR' },
]

export default function StatusBar() {
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const online = useStore((s) => s.online)
  const regionReady = useStore((s) => {
    const id = s.region?.manifest.id
    if (!id) return false
    return s.regionUI[id]?.state === 'ready' || isDownloaded(id)
  })

  // What matters in the field is whether maps survive losing signal.
  const state = regionReady
    ? { cls: 'ready', label: 'Offline ready' }
    : online
      ? { cls: '', label: 'Streaming' }
      : { cls: 'warn', label: 'No offline maps' }

  return (
    <div className="topbar">
      <div className="wordmark">
        <Logo size={18} />
        <span>TRAILSIGHT</span>
      </div>
      <div className="modes">
        {MODES.map((m) => (
          <button key={m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <div className={`netstate ${state.cls}`} title="Whether map data is stored on this device">
        <span className="dot" />
        {state.label}
      </div>
    </div>
  )
}
