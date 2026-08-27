import { useEffect, useState } from 'react'
import { useStore } from '../app/store'
import { storageEstimate } from './regions'
import { fmtBytes } from '../ui/format'

/** What a saved region pack actually contains, in user terms. */
const LAYERS = ['Maps', 'Routes', 'Terrain', 'Landmarks']

export default function OfflinePanel() {
  const catalog = useStore((s) => s.catalog)
  const regionUI = useStore((s) => s.regionUI)
  const suggestion = useStore((s) => s.suggestion)
  const online = useStore((s) => s.online)
  const activeId = useStore((s) => s.region?.manifest.id)
  const download = useStore((s) => s.download)
  const removeDownload = useStore((s) => s.removeDownload)
  const suggestNearMe = useStore((s) => s.suggestNearMe)
  const switchRegion = useStore((s) => s.switchRegion)
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null)

  useEffect(() => {
    storageEstimate().then(setStorage)
  }, [regionUI])

  if (!catalog) return null

  return (
    <div className="offline-panel panel">
      <div className="op-head">
        <div className="micro">Offline regions</div>
        <button className="btn small quiet" onClick={() => suggestNearMe(true)}>
          Find nearby
        </button>
      </div>
      <div className="op-body">
        {suggestion && (
          <div className="suggestion">
            {suggestion.distKm === 0 ? (
              <>
                <b>{suggestion.name.split(' - ')[0]}</b> covers your current area. Download it
                before heading out of coverage ({fmtBytes(suggestion.bytes)}).
              </>
            ) : (
              <>
                Nearest region: <b>{suggestion.name.split(' - ')[0]}</b>, about{' '}
                {suggestion.distKm} km away ({fmtBytes(suggestion.bytes)}).
              </>
            )}
          </div>
        )}
        {catalog.regions.map((r) => {
          const ui = regionUI[r.id] ?? { state: 'none' as const, pct: 0 }
          const active = r.id === activeId
          return (
            <div key={r.id} className="region-entry">
              <div className="region-head">
                <div>
                  <div className="region-name">{r.name.split(' - ')[0]}</div>
                  <div className="region-sub">
                    {r.routes.map((rt) => `${rt.name} · ${rt.km} km`).join('  ·  ')}
                  </div>
                </div>
                {active ? (
                  <span className="micro current">Viewing</span>
                ) : (
                  <button className="btn small quiet" onClick={() => switchRegion(r.id)}>
                    Open
                  </button>
                )}
              </div>
              {ui.state === 'ready' && (
                <>
                  <div className="region-row">
                    <span className="region-badge">✓ Downloaded · {fmtBytes(r.bytes)}</span>
                    <span style={{ flex: 1 }} />
                    <button className="btn small quiet" onClick={() => removeDownload(r.id)}>
                      Remove
                    </button>
                  </div>
                  <div className="layer-grid">
                    {LAYERS.map((l) => (
                      <div className="row" key={l}>
                        {l} <span className="ok">✓</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {ui.state === 'downloading' && (
                <div className="region-row">
                  <div className="progress">
                    <div style={{ width: `${Math.round(ui.pct * 100)}%` }} />
                  </div>
                  <span className="num" style={{ fontSize: 12, color: 'var(--dim)' }}>
                    {Math.round(ui.pct * 100)}%
                  </span>
                </div>
              )}
              {ui.state === 'none' && (
                <div className="region-row">
                  <button
                    className="btn small"
                    disabled={!online}
                    onClick={() => download(r.id)}
                    title={online ? '' : 'Downloads need a connection'}
                  >
                    Download this area
                  </button>
                  <span className="num" style={{ fontSize: 12, color: 'var(--faint)' }}>
                    {fmtBytes(r.bytes)}
                  </span>
                </div>
              )}
              {ui.error && (
                <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{ui.error}</div>
              )}
            </div>
          )
        })}
        <div className="storage-line">
          {storage && storage.usage > 0
            ? `${fmtBytes(storage.usage)} on device · ${fmtBytes(storage.quota)} available`
            : 'Map and route data is stored on this device'}
        </div>
      </div>
    </div>
  )
}
