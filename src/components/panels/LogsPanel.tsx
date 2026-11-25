import { useState } from 'react'
import { useAppStore } from '../../state/appStore'
import { formatDateTime } from '../../lib/format'
import type { LogRecord } from '../../types'
import { Button, SectionHead, TextInput } from '../ui/primitives'

type CategoryFilter = 'all' | LogRecord['category']

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: 'Alle',
  download: 'Downloads',
  retry: 'Wiederholungen & Hoster',
  sync: 'Merkliste & Sync',
  storage: 'Speicherbereinigung',
  archive: 'Archiv',
  system: 'System',
}

export function LogsPanel() {
  const logs = useAppStore((s) => s.logs)
  const clearLogs = useAppStore((s) => s.clearLogs)

  const [category, setCategory] = useState<CategoryFilter>('all')
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = logs.filter((entry) => {
    if (category !== 'all' && entry.category !== category) return false
    if (onlyProblems && entry.level === 'info') return false
    if (!search.trim()) return true
    const q = search.trim().toLowerCase()
    return (
      entry.title.toLowerCase().includes(q) ||
      entry.message.toLowerCase().includes(q) ||
      (entry.seriesTitle && entry.seriesTitle.toLowerCase().includes(q)) ||
      (entry.hoster && entry.hoster.toLowerCase().includes(q))
    )
  })

  const exportLogFile = () => {
    const lines = filtered.map(
      (l) =>
        `[${new Date(l.at).toISOString()}] [${l.level.toUpperCase()}] [${l.category}] ${l.title} — ${l.message}${
          l.triedHosters?.length ? ` | Hoster: ${l.triedHosters.join(' -> ')}` : ''
        }`,
    )
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `sondra-ad-protokoll-${new Date().toISOString().slice(0, 10)}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-[24px]">
      <div className="flex flex-col justify-between gap-[16px] sm:flex-row sm:items-end">
        <div className="flex flex-col gap-[4px]">
          <h2 className="display-md">Protokoll</h2>
          <p className="max-w-[34em] text-small text-muted">
            Jeder Prüflauf, Download, Hoster-Wechsel, Wiederholungsversuch und jede Speicherbereinigung wird dauerhaft auf der Festplatte protokolliert.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-[8px]">
          <Button variant="quiet" size="sm" disabled={filtered.length === 0} onClick={exportLogFile}>
            Als .log speichern
          </Button>
          <Button variant="ghost" size="sm" disabled={logs.length === 0} onClick={() => void clearLogs()}>
            Protokoll leeren
          </Button>
        </div>
      </div>

      <div className="flex flex-col justify-between gap-[12px] border-t-2 border-rule pt-[14px] lg:flex-row lg:items-center">
        <div className="flex flex-wrap gap-[6px]">
          {(['all', 'download', 'retry', 'sync', 'storage', 'archive', 'system'] as const).map((cat) => {
            const on = category === cat
            return (
              <button
                key={cat}
                type="button"
                aria-pressed={on}
                onClick={() => setCategory(cat)}
                className={`press rounded-pill px-[12px] py-[6px] text-small font-medium ${
                  on ? 'bg-ink font-semibold text-on-ink' : 'bg-panel-soft text-prose hover:text-ink'
                }`}
              >
                {CATEGORY_LABELS[cat]}
              </button>
            )
          })}
          <button
            type="button"
            aria-pressed={onlyProblems}
            onClick={() => setOnlyProblems(!onlyProblems)}
            className={`press rounded-pill px-[12px] py-[6px] text-small font-medium ${
              onlyProblems ? 'bg-ink font-semibold text-on-ink' : 'bg-raised text-prose ring-1 ring-inset ring-line hover:text-ink'
            }`}
          >
            Nur Warnungen & Fehler
          </button>
        </div>

        <div className="w-full lg:w-[260px]">
          <TextInput
            placeholder="Im Protokoll suchen …"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <SectionHead rule={false} className="py-[12px] font-normal text-muted">
          Keine Protokolleinträge für diese Auswahl vorhanden.
        </SectionHead>
      ) : (
        <ul className="rise-list flex flex-col">
          {filtered.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-col gap-[4px] border-t border-line py-[10px] first:border-t-0"
            >
              <div className="flex flex-col justify-between gap-[4px] sm:flex-row sm:items-baseline sm:gap-[16px]">
                <div className="flex min-w-0 items-baseline gap-[8px]">
                  <span className="value w-[14px] shrink-0 text-small font-bold text-ink">
                    {entry.level === 'error' ? '!' : entry.level === 'warn' ? '·' : '●'}
                  </span>
                  <span className="rounded-nav bg-panel-soft px-[6px] py-[1px] text-micro font-medium text-ink">
                    {CATEGORY_LABELS[entry.category]}
                  </span>
                  <span className="text-small font-semibold text-ink">{entry.title}</span>
                </div>
                <span className="value shrink-0 text-micro text-muted">{formatDateTime(entry.at)}</span>
              </div>

              <p className="pl-[22px] text-small text-prose">{entry.message}</p>

              {entry.triedHosters && entry.triedHosters.length > 0 ? (
                <p className="value pl-[22px] text-micro text-muted">
                  Hoster-Verlauf: {entry.triedHosters.join(' → ')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
