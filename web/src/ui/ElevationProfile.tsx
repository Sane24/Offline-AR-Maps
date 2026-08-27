import { useEffect, useMemo, useRef } from 'react'
import { useStore } from '../app/store'

/**
 * Route elevation profile with live progress. The polyline is derived once
 * per route; progress updates mutate SVG attributes directly so the profile
 * never re-renders during navigation.
 */
export default function ElevationProfile({ height = 48 }: { height?: number }) {
  const prepared = useStore((s) => s.prepared)
  const progRef = useRef<SVGRectElement>(null)
  const dotRef = useRef<SVGCircleElement>(null)

  const model = useMemo(() => {
    if (!prepared) return null
    const W = 100
    const H = 100
    const n = 120
    const total = prepared.cum[prepared.cum.length - 1]
    const { minEle, maxEle } = prepared.stats
    const span = Math.max(20, maxEle - minEle)
    const pts: string[] = []
    const ys: number[] = []
    for (let i = 0; i <= n; i++) {
      const d = (i / n) * total
      // find ele at along-distance d
      let lo = 0
      let hi = prepared.cum.length - 1
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (prepared.cum[mid] <= d) lo = mid
        else hi = mid
      }
      const t = (d - prepared.cum[lo]) / Math.max(1e-6, prepared.cum[hi] - prepared.cum[lo])
      const ele = prepared.coords[lo][2] + (prepared.coords[hi][2] - prepared.coords[lo][2]) * t
      const x = (i / n) * W
      const y = H - ((ele - minEle) / span) * (H - 18) - 6
      ys.push(y)
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    }
    const line = pts.join(' ')
    const area = `0,${H} ${line} ${W},${H}`
    return { line, area, ys }
  }, [prepared])

  useEffect(() => {
    if (!model) return
    const unsub = useStore.subscribe(
      (s) => s.nav?.progress ?? 0,
      (p) => {
        if (progRef.current) progRef.current.setAttribute('width', String(p * 100))
        if (dotRef.current) {
          const i = Math.min(model.ys.length - 1, Math.round(p * (model.ys.length - 1)))
          dotRef.current.setAttribute('cx', String(p * 100))
          dotRef.current.setAttribute('cy', String(model.ys[i]))
        }
      },
      { fireImmediately: true },
    )
    return unsub
  }, [model])

  if (!model) return null
  return (
    <svg className="profile" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height }}>
      <defs>
        <clipPath id="pclip">
          <rect ref={progRef} x="0" y="0" width="0" height="100" />
        </clipPath>
      </defs>
      <polygon points={model.area} fill="rgba(232,228,214,0.07)" />
      <polyline
        points={model.line}
        fill="none"
        stroke="rgba(165,162,145,0.55)"
        strokeWidth="1.3"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={model.line}
        fill="none"
        stroke="#f07b31"
        strokeWidth="2.2"
        vectorEffect="non-scaling-stroke"
        clipPath="url(#pclip)"
      />
      <circle ref={dotRef} r="3" cx="0" cy="50" fill="#e8e4d6" stroke="#14160f" strokeWidth="1.2" />
    </svg>
  )
}
