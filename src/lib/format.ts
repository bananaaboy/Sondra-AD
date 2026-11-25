export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let val = bytes
  let idx = 0
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024
    idx += 1
  }
  const digits = idx >= 3 ? 2 : idx >= 2 ? 1 : 0
  return `${val.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[idx]}`
}

export function formatSpeed(bps: number | null | undefined): string {
  if (!bps || bps <= 0) return '—'
  return `${formatBytes(bps)}/s`
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return ''
  const s = Math.round(seconds)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return `${m}:${String(rem).padStart(2, '0')} Min.`
  const h = Math.floor(m / 60)
  const remM = m % 60
  return `${h} Std. ${remM} Min.`
}

export function formatRelativeTime(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp || timestamp <= 0) return 'noch nie'
  const diffSec = Math.round((timestamp - now) / 1000)
  const absSec = Math.abs(diffSec)

  if (absSec < 10) return 'gerade eben'
  if (diffSec > 0) {
    if (absSec < 60) return `in ${absSec} Sek.`
    const mins = Math.round(absSec / 60)
    if (mins < 60) return `in ${mins} Min.`
    const hrs = Math.round(mins / 60)
    if (hrs < 48) return `in ${hrs} Std.`
    return `in ${Math.round(hrs / 24)} Tagen`
  }
  if (absSec < 60) return `vor ${absSec} Sek.`
  const mins = Math.round(absSec / 60)
  if (mins < 60) return `vor ${mins} Min.`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `vor ${hrs} Std.`
  return `vor ${Math.round(hrs / 24)} Tagen`
}

export function formatDateTime(timestamp: number | null | undefined): string {
  if (!timestamp || timestamp <= 0) return '—'
  try {
    const d = new Date(timestamp)
    return d.toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return '—'
  }
}

export function episodeLabel(season: number, episode: number | null): string {
  if (season === 0) return `Film ${episode ?? 1}`
  return `Staffel ${season} · Folge ${episode ?? 1}`
}
