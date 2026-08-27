export function fmtDistM(m: number): string {
  if (!isFinite(m)) return '--'
  if (m < 10) return `${Math.round(m)} m`
  if (m < 950) return `${Math.round(m / 5) * 5} m`
  return `${(m / 1000).toFixed(m < 9500 ? 1 : 0)} km`
}

export function fmtDurMin(min: number): string {
  if (!isFinite(min)) return '--'
  const m = Math.round(min)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

export function fmtEle(m: number): string {
  return `${Math.round(m).toLocaleString('en-US')} m`
}

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export function fmtPct(p: number): string {
  return `${Math.round(p * 100)}%`
}
