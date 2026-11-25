import { useMemo, useState } from 'react'
import { useAppStore } from '../../state/appStore'
import { episodeLabel, formatRelativeTime } from '../../lib/format'
import type {
  AniworldLanguagePref,
  BacklogMode,
  SavedLinkItem,
  SavedLinkStatus,
  SeasonDownloadRule,
  SeriesOverride,
  VideoFilePref,
} from '../../types'
import { Button, Card, Dialog, Field, SectionHead, Select, TextInput, Toggle } from '../ui/primitives'

const STATUS_LABELS: Record<SavedLinkStatus, string> = {
  watching: 'Am Schauen',
  later: 'Später',
  done: 'Fertig',
  paused: 'Pausiert',
  dropped: 'Abgebrochen',
}

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const
const WEEKDAY_LABELS: Record<number, string> = {
  1: 'Montag',
  2: 'Dienstag',
  3: 'Mittwoch',
  4: 'Donnerstag',
  5: 'Freitag',
  6: 'Samstag',
  0: 'Sonntag',
}

export function WatchlistPanel() {
  const config = useAppStore((s) => s.config)
  const drive = useAppStore((s) => s.drive)
  const checking = useAppStore((s) => s.checking)
  const merkItems = useAppStore((s) => s.merkItems)
  const merkMeta = useAppStore((s) => s.merkMeta)
  const episodeIndex = useAppStore((s) => s.episodeIndex)
  const calendar = useAppStore((s) => s.calendar)

  const syncMerkliste = useAppStore((s) => s.syncMerkliste)
  const checkNow = useAppStore((s) => s.checkNow)
  const upsertSeries = useAppStore((s) => s.upsertSeries)
  const removeSeries = useAppStore((s) => s.removeSeries)
  const setSeriesOverride = useAppStore((s) => s.setSeriesOverride)
  const removeWatchHistory = useAppStore((s) => s.removeWatchHistory)

  const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | SavedLinkStatus>('all')
  const [syncing, setSyncing] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  const [formItem, setFormItem] = useState<{
    id?: string
    title: string
    url: string
    status: SavedLinkStatus
    season: number
    episode: number
    language: AniworldLanguagePref
  }>({
    title: '',
    url: '',
    status: 'watching',
    season: 1,
    episode: 1,
    language: 'auto',
  })

  const [overrideTarget, setOverrideTarget] = useState<SavedLinkItem | null>(null)

  const countsBySeries = useMemo(() => {
    const map = new Map<string, { downloaded: number; archived: number }>()
    for (const rec of Object.values(episodeIndex.downloaded || {})) {
      const cur = map.get(rec.seriesId) || { downloaded: 0, archived: 0 }
      cur.downloaded += 1
      map.set(rec.seriesId, cur)
    }
    for (const rec of Object.values(episodeIndex.archived || {})) {
      const cur = map.get(rec.seriesId) || { downloaded: 0, archived: 0 }
      cur.archived += 1
      map.set(rec.seriesId, cur)
    }
    return map
  }, [episodeIndex])

  const watchHistoryEntries = useMemo(() => {
    const entries: Array<{
      seriesId: string
      seriesTitle: string
      entryId: string
      season: number
      episode: number
      at: number
    }> = []
    for (const item of merkItems) {
      for (const h of item.history || []) {
        entries.push({
          seriesId: item.id,
          seriesTitle: item.title,
          entryId: h.id,
          season: h.season,
          episode: h.episode,
          at: h.at,
        })
      }
    }
    entries.sort((a, b) => b.at - a.at)
    return entries
  }, [merkItems])

  if (!config) return null

  const filtered = merkItems.filter((item) => {
    if (statusFilter !== 'all' && (item.status || 'watching') !== statusFilter) return false
    if (!search.trim()) return true
    const q = search.trim().toLowerCase()
    return item.title.toLowerCase().includes(q) || item.url.toLowerCase().includes(q)
  })

  const isSeriesAutoEnabled = (item: SavedLinkItem): boolean => {
    const ov = config.seriesOverrides?.[item.id]
    if (ov && typeof ov.enabled === 'boolean') return ov.enabled
    return Boolean(item.url) && config.watchStatuses.includes(item.status || 'watching')
  }

  const openAddDialog = (existing?: SavedLinkItem) => {
    if (existing) {
      setFormItem({
        id: existing.id,
        title: existing.title,
        url: existing.url,
        status: existing.status || 'watching',
        season: existing.season ?? 1,
        episode: existing.episode ?? 1,
        language: existing.language || 'auto',
      })
    } else {
      setFormItem({
        title: '',
        url: '',
        status: 'watching',
        season: 1,
        episode: 1,
        language: 'auto',
      })
    }
    setAddOpen(true)
  }

  const handleSaveSeries = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formItem.url.trim() && !formItem.title.trim()) return
    await upsertSeries({
      ...(formItem.id ? { id: formItem.id } : {}),
      title: formItem.title.trim(),
      url: formItem.url.trim(),
      status: formItem.status,
      season: Math.max(0, Number(formItem.season) || 1),
      episode: Math.max(1, Number(formItem.episode) || 1),
      language: formItem.language,
      checkImmediately: true,
    })
    setAddOpen(false)
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      await syncMerkliste()
    } finally {
      setSyncing(false)
    }
  }

  const handleCheckSingle = async (id: string) => {
    setCheckingId(id)
    try {
      await checkNow(id)
    } finally {
      setCheckingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-[24px]">
      <div className="flex flex-col justify-between gap-[16px] sm:flex-row sm:items-end">
        <div className="flex flex-col gap-[4px]">
          <h2 className="display-md">Merkliste</h2>
          <p className="max-w-[34em] text-small text-muted">
            Gemeinsam mit Sondra über <span className="value">Sondra-Merkliste.sqlite</span> in Google Drive synchronisiert. Neue Staffeln und Episoden werden automatisch erkannt und geladen.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-[8px]">
          <div className="inline-flex rounded-pill bg-panel-soft p-[3px]">
            <button
              type="button"
              aria-pressed={viewMode === 'list'}
              onClick={() => setViewMode('list')}
              className={`press rounded-pill px-[12px] py-[5px] text-micro font-medium ${
                viewMode === 'list' ? 'bg-ink text-on-ink' : 'text-prose hover:text-ink'
              }`}
            >
              Liste
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'calendar'}
              onClick={() => setViewMode('calendar')}
              className={`press rounded-pill px-[12px] py-[5px] text-micro font-medium ${
                viewMode === 'calendar' ? 'bg-ink text-on-ink' : 'text-prose hover:text-ink'
              }`}
            >
              Wochenplan
            </button>
          </div>
          <Button variant="quiet" size="sm" onClick={() => setHistoryOpen(true)}>
            {watchHistoryEntries.length > 0 ? `Verlauf (${watchHistoryEntries.length})` : 'Verlauf'}
          </Button>
          {drive?.connected ? (
            <Button variant="quiet" size="sm" disabled={syncing} onClick={() => void handleSync()}>
              {syncing ? 'Gleicht ab …' : 'Mit Drive abgleichen'}
            </Button>
          ) : null}
          <Button variant="quiet" size="sm" disabled={checking} onClick={() => void checkNow()}>
            {checking ? 'Prüft …' : 'Alle prüfen'}
          </Button>
          <Button size="sm" onClick={() => openAddDialog()}>
            Serie hinzufügen
          </Button>
        </div>
      </div>

      {viewMode === 'calendar' ? (
        <section className="flex flex-col gap-[16px] border-t-2 border-rule pt-[16px]">
          <div className="flex flex-wrap items-center justify-between gap-[8px]">
            <p className="text-small text-muted">
              Erwartete Ausstrahlungstage laufender Serien. Über „Regeln“ lässt sich der Wochentag je Serie festlegen.
            </p>
            {merkMeta.nextCheckAt ? (
              <span className="value text-micro text-muted">
                Nächste Suche: {formatRelativeTime(merkMeta.nextCheckAt)}
              </span>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-[10px] sm:grid-cols-2 lg:grid-cols-7">
            {WEEKDAY_ORDER.map((dayIdx) => {
              const isToday = new Date().getDay() === dayIdx
              const dayEntries = calendar.filter((c) => c.airDay === dayIdx)
              return (
                <div
                  key={dayIdx}
                  className={`flex flex-col gap-[8px] rounded-card border p-[12px] ${
                    isToday ? 'border-ink bg-panel-soft/80' : 'border-line bg-surface'
                  }`}
                >
                  <div className="flex items-center justify-between border-b border-line pb-[6px]">
                    <span className="text-small font-semibold text-ink">{WEEKDAY_LABELS[dayIdx]}</span>
                    {isToday ? <span className="value text-micro text-ink">Heute</span> : null}
                  </div>
                  {dayEntries.length === 0 ? (
                    <span className="text-micro text-muted">Keine Serie</span>
                  ) : (
                    <ul className="flex flex-col gap-[6px]">
                      {dayEntries.map((entry) => {
                        const match = merkItems.find((m) => m.id === entry.seriesId)
                        return (
                          <li key={entry.seriesId}>
                            <button
                              type="button"
                              onClick={() => match && setOverrideTarget(match)}
                              className="press flex w-full flex-col items-start rounded-nav bg-panel-soft px-[8px] py-[6px] text-left hover:bg-panel-soft/90"
                            >
                              <span className="line-clamp-1 text-micro font-semibold text-ink">{entry.title}</span>
                              <span className="value text-[11px] text-muted">
                                S{entry.currentSeason}
                                {entry.currentEpisode ? `E${entry.currentEpisode}` : ''} ·{' '}
                                {entry.airDaySource === 'manual' ? 'Fest' : 'Geschätzt'}
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ) : null}

      {viewMode === 'list' ? (
      <div className="flex flex-col justify-between gap-[12px] border-t-2 border-rule pt-[14px] sm:flex-row sm:items-center">
        <div className="flex flex-wrap gap-[6px]">
          {(
            [
              ['all', `Alle (${merkItems.length})`],
              ['watching', 'Am Schauen'],
              ['later', 'Später'],
              ['done', 'Fertig'],
              ['paused', 'Pausiert'],
            ] as const
          ).map(([key, label]) => {
            const active = statusFilter === key
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() => setStatusFilter(key)}
                className={`press rounded-pill px-[12px] py-[6px] text-small font-medium ${
                  active
                    ? 'bg-ink font-semibold text-on-ink'
                    : 'bg-panel-soft text-prose hover:text-ink'
                }`}
              >
                {label}
              </button>
            )
          })}
        </div>

        <div className="w-full sm:w-[260px]">
          <TextInput
            placeholder="Serie oder Adresse suchen …"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      ) : null}

      {viewMode === 'list' && filtered.length === 0 ? (
        <Card tone="mint" className="flex flex-col items-start gap-[12px] p-[24px]">
          <p className="text-body font-semibold text-ink">
            {merkItems.length === 0 ? 'Ihre Merkliste ist noch leer' : 'Keine Serie passt zum gewählten Filter'}
          </p>
          <p className="max-w-[34em] text-small text-prose">
            {merkItems.length === 0
              ? 'Fügen Sie eine Serie per Adresse hinzu (z. B. AniWorld, SerienStream, RSS oder Playlist) oder verbinden Sie Google Drive, um Ihre bestehende Sondra-Merkliste automatisch zu laden.'
              : 'Passen Sie den Suchbegriff oder den Status-Filter oben an.'}
          </p>
          {merkItems.length === 0 ? (
            <Button size="sm" onClick={() => openAddDialog()}>
              Erste Serie eintragen
            </Button>
          ) : null}
        </Card>
      ) : viewMode === 'list' ? (
        <ul className="rise-list flex flex-col">
          {filtered.map((item) => {
            const autoOn = isSeriesAutoEnabled(item)
            const counts = countsBySeries.get(item.id) || { downloaded: 0, archived: 0 }
            const ov = config.seriesOverrides?.[item.id]
            const online = item.onlineAvailable

            return (
              <li
                key={item.id}
                className="flex flex-col justify-between gap-[14px] border-t border-line py-[16px] first:border-t-0 lg:flex-row lg:items-center"
              >
                <div className="flex min-w-0 items-start gap-[14px]">
                  {item.cover && !item.cover.startsWith('sondra:') ? (
                    <img
                      src={item.cover}
                      alt=""
                      className="h-[68px] w-[48px] shrink-0 rounded-nav object-cover ring-1 ring-line"
                    />
                  ) : (
                    <div className="flex h-[68px] w-[48px] shrink-0 items-center justify-center rounded-nav bg-panel-soft text-small font-semibold text-ink ring-1 ring-inset ring-line">
                      {item.title.slice(0, 2).toUpperCase()}
                    </div>
                  )}

                  <div className="flex min-w-0 flex-col gap-[4px]">
                    <div className="flex flex-wrap items-center gap-[8px]">
                      <span className="text-body font-semibold text-ink">{item.title}</span>
                      <span className="rounded-pill bg-panel-soft px-[8px] py-[2px] text-micro font-medium text-ink">
                        {STATUS_LABELS[item.status || 'watching']}
                      </span>
                      {ov ? (
                        <span className="rounded-pill bg-panel-mid px-[8px] py-[2px] text-micro font-medium text-ink">
                          Eigene Regel
                        </span>
                      ) : null}
                    </div>

                    <p className="value text-small text-prose">
                      Stand: {episodeLabel(item.season ?? 1, item.episode ?? 1)}
                      {online ? ` · Online bis S${String(online.maxSeason).padStart(2, '0')}E${String(online.maxEpisode).padStart(2, '0')}` : ''}
                      {counts.downloaded > 0 ? ` · ${counts.downloaded} in Drive` : ''}
                      {counts.archived > 0 ? ` · ${counts.archived} im Archiv` : ''}
                    </p>

                    <p className="truncate text-micro text-muted">
                      {item.url ? (
                        <>
                          <span className="value">{item.url}</span>
                          {online?.checkedAt ? ` · geprüft ${formatRelativeTime(online.checkedAt)}` : ''}
                        </>
                      ) : (
                        'Keine Quell-Adresse hinterlegt (nur Fortschritts-Eintrag)'
                      )}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-[10px]">
                  <div className="w-[155px]">
                    <Toggle
                      label={autoOn ? 'Auto-Download an' : 'Auto-Download aus'}
                      checked={autoOn}
                      disabled={!item.url}
                      onChange={(val) => void setSeriesOverride(item.id, { ...(ov || {}), enabled: val })}
                    />
                  </div>

                  {item.url ? (
                    <Button
                      variant="quiet"
                      size="sm"
                      disabled={checkingId === item.id}
                      onClick={() => void handleCheckSingle(item.id)}
                    >
                      {checkingId === item.id ? 'Prüft …' : 'Prüfen'}
                    </Button>
                  ) : null}

                  <Button variant="quiet" size="sm" onClick={() => setOverrideTarget(item)}>
                    Regeln
                  </Button>

                  <Button variant="ghost" size="sm" onClick={() => openAddDialog(item)}>
                    Bearbeiten
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}

      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title={formItem.id ? 'Serie bearbeiten' : 'Serie auf die Merkliste setzen'}
        size="md"
      >
        <form onSubmit={(e) => void handleSaveSeries(e)} className="flex flex-col gap-[16px]">
          <div className="grid grid-cols-1 gap-[16px] sm:grid-cols-2">
            <Field
              label="Quell-Adresse (AniWorld, SerienStream, Playlist, RSS)"
              hint="Aus der Adresse liest Sondra AD automatisch alle Staffeln und neuen Episoden."
              className="sm:col-span-2"
            >
              <TextInput
                placeholder="https://aniworld.to/anime/stream/…"
                value={formItem.url}
                onChange={(e) => setFormItem({ ...formItem, url: e.target.value })}
                autoFocus
              />
            </Field>

            <Field label="Titel der Serie" hint="Leer lassen, um den Namen aus der Adresse abzuleiten.">
              <TextInput
                placeholder="z. B. Frieren"
                value={formItem.title}
                onChange={(e) => setFormItem({ ...formItem, title: e.target.value })}
              />
            </Field>

            <Field label="Status">
              <Select
                value={formItem.status}
                onChange={(e) => setFormItem({ ...formItem, status: e.target.value as SavedLinkStatus })}
              >
                <option value="watching">Am Schauen</option>
                <option value="later">Später</option>
                <option value="done">Fertig (neue Staffeln trotzdem überwachen)</option>
                <option value="paused">Pausiert</option>
                <option value="dropped">Abgebrochen</option>
              </Select>
            </Field>

            <Field label="Aktuelle Staffel">
              <TextInput
                type="number"
                min={0}
                value={formItem.season}
                onChange={(e) => setFormItem({ ...formItem, season: Number(e.target.value) })}
              />
            </Field>

            <Field label="Nächste ungesehene Folge">
              <TextInput
                type="number"
                min={1}
                value={formItem.episode}
                onChange={(e) => setFormItem({ ...formItem, episode: Number(e.target.value) })}
              />
            </Field>

            <Field label="Bevorzugte Sprache dieser Serie" className="sm:col-span-2">
              <Select
                value={formItem.language}
                onChange={(e) => setFormItem({ ...formItem, language: e.target.value as AniworldLanguagePref })}
              >
                <option value="auto">Standard aus Einstellungen übernehmen</option>
                <option value="ger_sub">Deutsch Untertitel (Ger-Sub)</option>
                <option value="ger_dub">Deutsch Synchronisation (Ger-Dub)</option>
                <option value="eng_sub">Englisch Untertitel (Eng-Sub)</option>
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-[12px] border-t border-line pt-[16px]">
            {formItem.id ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  const id = formItem.id!
                  setAddOpen(false)
                  void removeSeries(id)
                }}
              >
                Von Merkliste entfernen
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-[10px]">
              <Button type="button" variant="quiet" size="sm" onClick={() => setAddOpen(false)}>
                Abbrechen
              </Button>
              <Button type="submit" size="sm">
                Speichern & prüfen
              </Button>
            </div>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title="Zuletzt geschaut (Verlauf)"
        size="md"
      >
        <div className="flex flex-col gap-[16px]">
          {watchHistoryEntries.length === 0 ? (
            <p className="py-[12px] text-small text-muted">
              Noch keine geschauten Folgen im Verlauf hinterlegt.
            </p>
          ) : (
            <ul className="flex max-h-[380px] flex-col overflow-y-auto pr-[4px]">
              {watchHistoryEntries.map((entry) => (
                <li
                  key={`${entry.seriesId}-${entry.entryId}`}
                  className="flex items-baseline justify-between gap-[12px] border-t border-line py-[10px] first:border-t-0"
                >
                  <div className="flex min-w-0 flex-col gap-[2px]">
                    <span className="truncate text-small font-semibold text-ink">
                      {entry.seriesTitle} · {episodeLabel(entry.season, entry.episode)}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-baseline gap-[10px]">
                    <span className="value text-micro text-muted">{formatRelativeTime(entry.at)}</span>
                    <button
                      type="button"
                      onClick={() =>
                        void removeWatchHistory({
                          seriesId: entry.seriesId,
                          entryId: entry.entryId,
                        })
                      }
                      className="press text-micro text-muted hover:text-ink"
                    >
                      Löschen
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center justify-between gap-[10px] border-t border-line pt-[14px]">
            {watchHistoryEntries.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void removeWatchHistory({ clearAll: true })}
              >
                Verlauf leeren
              </Button>
            ) : (
              <span />
            )}
            <Button variant="quiet" size="sm" onClick={() => setHistoryOpen(false)}>
              Schließen
            </Button>
          </div>
        </div>
      </Dialog>

      {overrideTarget ? (
        <SeriesOverrideDialog
          item={overrideTarget}
          current={config.seriesOverrides?.[overrideTarget.id]}
          onClose={() => setOverrideTarget(null)}
          onSave={async (next) => {
            await setSeriesOverride(overrideTarget.id, next)
            setOverrideTarget(null)
          }}
        />
      ) : null}
    </div>
  )
}

function SeriesOverrideDialog({
  item,
  current,
  onClose,
  onSave,
}: {
  item: SavedLinkItem
  current: SeriesOverride | undefined
  onClose: () => void
  onSave: (override: SeriesOverride | null) => Promise<void>
}) {
  const [enabled, setEnabled] = useState<boolean>(current?.enabled ?? true)
  const [language, setLanguage] = useState<AniworldLanguagePref | ''>(current?.language ?? '')
  const [mode, setMode] = useState<'video' | 'audio' | ''>(current?.mode ?? '')
  const [videoPref, setVideoPref] = useState<VideoFilePref | ''>(current?.videoPref ?? '')
  const [backlogMode, setBacklogMode] = useState<BacklogMode | ''>(current?.backlogMode ?? '')
  const [lookaheadLimit, setLookaheadLimit] = useState<string>(
    typeof current?.lookaheadLimit === 'number' ? String(current.lookaheadLimit) : '',
  )
  const [maxStorageGb, setMaxStorageGb] = useState<string>(
    typeof current?.maxStorageGb === 'number' && current.maxStorageGb > 0 ? String(current.maxStorageGb) : '',
  )
  const [airDay, setAirDay] = useState<string>(
    typeof current?.airDay === 'number' && current.airDay >= 0 && current.airDay <= 6 ? String(current.airDay) : '',
  )

  const discoveredNumbers = (() => {
    const nums = new Set<number>()
    for (const s of item.seasons || []) {
      if (s.number > 0) nums.add(s.number)
    }
    const maxS = Math.max(item.onlineAvailable?.maxSeason || 0, item.season || 1, 1)
    for (let i = 1; i <= maxS; i += 1) nums.add(i)
    for (const key of Object.keys(current?.seasonRules || {})) {
      const n = Number(key)
      if (Number.isFinite(n) && n > 0) nums.add(n)
    }
    return [...nums].sort((a, b) => a - b)
  })()

  const [seasonNumbers, setSeasonNumbers] = useState<number[]>(discoveredNumbers)
  const [seasonRules, setSeasonRules] = useState<Record<string, SeasonDownloadRule>>(() => {
    const init: Record<string, SeasonDownloadRule> = {}
    for (const n of discoveredNumbers) {
      const existing = current?.seasonRules?.[String(n)]
      init[String(n)] = existing
        ? {
            enabled: existing.enabled !== false,
            fromEpisode: existing.fromEpisode ?? null,
            toEpisode: existing.toEpisode ?? null,
            maxEpisodes: existing.maxEpisodes ?? null,
          }
        : { enabled: true, fromEpisode: null, toEpisode: null, maxEpisodes: null }
    }
    return init
  })

  const seasonEpisodeCounts = new Map<number, number | null>()
  for (const s of item.seasons || []) {
    seasonEpisodeCounts.set(s.number, s.episodes)
  }

  const updateSeasonRule = (seasonNum: number, patch: Partial<SeasonDownloadRule>) => {
    const key = String(seasonNum)
    setSeasonRules((prev) => ({
      ...prev,
      [key]: {
        ...(prev[key] || { enabled: true, fromEpisode: null, toEpisode: null, maxEpisodes: null }),
        ...patch,
      },
    }))
  }

  const setAllSeasonsEnabled = (flag: boolean) => {
    setSeasonRules((prev) => {
      const next: Record<string, SeasonDownloadRule> = {}
      for (const n of seasonNumbers) {
        const key = String(n)
        next[key] = { ...(prev[key] || { fromEpisode: null, toEpisode: null, maxEpisodes: null }), enabled: flag }
      }
      return next
    })
  }

  const addNextSeason = () => {
    const nextNum = seasonNumbers.length > 0 ? Math.max(...seasonNumbers) + 1 : 1
    setSeasonNumbers((prev) => [...prev, nextNum])
    setSeasonRules((prev) => ({
      ...prev,
      [String(nextNum)]: { enabled: true, fromEpisode: null, toEpisode: null, maxEpisodes: null },
    }))
  }

  const handleApply = () => {
    const cleanedRules: Record<string, SeasonDownloadRule> = {}
    let hasCustomSeasonRule = false
    for (const n of seasonNumbers) {
      const r = seasonRules[String(n)]
      if (!r) continue
      const fromEpisode = typeof r.fromEpisode === 'number' && r.fromEpisode > 0 ? r.fromEpisode : null
      const toEpisode = typeof r.toEpisode === 'number' && r.toEpisode > 0 ? r.toEpisode : null
      const maxEpisodes = typeof r.maxEpisodes === 'number' && r.maxEpisodes > 0 ? r.maxEpisodes : null
      if (!r.enabled || fromEpisode || toEpisode || maxEpisodes) {
        hasCustomSeasonRule = true
      }
      cleanedRules[String(n)] = {
        enabled: r.enabled,
        ...(fromEpisode ? { fromEpisode } : {}),
        ...(toEpisode ? { toEpisode } : {}),
        ...(maxEpisodes ? { maxEpisodes } : {}),
      }
    }

    void onSave({
      enabled,
      ...(language ? { language } : {}),
      ...(mode ? { mode } : {}),
      ...(videoPref ? { videoPref } : {}),
      ...(backlogMode ? { backlogMode } : {}),
      ...(lookaheadLimit.trim() !== '' ? { lookaheadLimit: Math.max(0, Number(lookaheadLimit) || 0) } : {}),
      ...(maxStorageGb.trim() !== '' ? { maxStorageGb: Math.max(0, Number(maxStorageGb) || 0) } : {}),
      ...(airDay !== '' ? { airDay: Number(airDay) } : {}),
      ...(hasCustomSeasonRule ? { seasonRules: cleanedRules } : {}),
    })
  }

  return (
    <Dialog open onClose={onClose} title={`Regeln: ${item.title}`} size="lg">
      <div className="flex flex-col gap-[18px]">
        <Toggle
          label="Serie automatisch überwachen und herunterladen"
          checked={enabled}
          onChange={setEnabled}
        />

        <div className="flex flex-col gap-[10px] border-t border-line pt-[14px]">
          <div className="flex flex-wrap items-center justify-between gap-[8px]">
            <div>
              <SectionHead rule={false}>Staffel-spezifische Downloads</SectionHead>
              <p className="text-micro text-muted">
                Lege für jede Staffel fest, ob sie geladen werden darf, ab/bis welcher Folge und wie viele Folgen maximal.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-[6px]">
              <Button type="button" variant="ghost" size="sm" onClick={() => setAllSeasonsEnabled(true)}>
                Alle an
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setAllSeasonsEnabled(false)}>
                Alle aus
              </Button>
              <Button type="button" variant="quiet" size="sm" onClick={addNextSeason}>
                + Staffel
              </Button>
            </div>
          </div>

          <div className="divide-y divide-line rounded-card bg-panel-soft/60 px-[12px] ring-1 ring-inset ring-line">
            {seasonNumbers.map((num) => {
              const r = seasonRules[String(num)] || { enabled: true }
              const epCount = seasonEpisodeCounts.get(num)
              return (
                <div
                  key={num}
                  className="grid grid-cols-1 items-center gap-[10px] py-[10px] sm:grid-cols-[150px_1fr_1fr_1fr]"
                >
                  <div className="flex items-center gap-[8px]">
                    <Toggle
                      label={`Staffel ${num}`}
                      hint={typeof epCount === 'number' ? `${epCount} Folgen` : undefined}
                      checked={r.enabled !== false}
                      onChange={(val) => updateSeasonRule(num, { enabled: val })}
                    />
                  </div>

                  <label className="flex flex-col gap-[2px]">
                    <span className="text-micro text-muted">Ab Folge</span>
                    <TextInput
                      type="number"
                      min={1}
                      disabled={!r.enabled}
                      placeholder="1"
                      value={r.fromEpisode ?? ''}
                      onChange={(e) =>
                        updateSeasonRule(num, {
                          fromEpisode: e.target.value.trim() ? Math.max(1, Number(e.target.value) || 1) : null,
                        })
                      }
                    />
                  </label>

                  <label className="flex flex-col gap-[2px]">
                    <span className="text-micro text-muted">Bis Folge</span>
                    <TextInput
                      type="number"
                      min={1}
                      disabled={!r.enabled}
                      placeholder={typeof epCount === 'number' ? String(epCount) : 'alle'}
                      value={r.toEpisode ?? ''}
                      onChange={(e) =>
                        updateSeasonRule(num, {
                          toEpisode: e.target.value.trim() ? Math.max(1, Number(e.target.value) || 1) : null,
                        })
                      }
                    />
                  </label>

                  <label className="flex flex-col gap-[2px]">
                    <span className="text-micro text-muted">Max. Folgen</span>
                    <TextInput
                      type="number"
                      min={0}
                      disabled={!r.enabled}
                      placeholder="unbegrenzt"
                      value={r.maxEpisodes ?? ''}
                      onChange={(e) =>
                        updateSeasonRule(num, {
                          maxEpisodes: e.target.value.trim() ? Math.max(0, Number(e.target.value) || 0) : null,
                        })
                      }
                    />
                  </label>
                </div>
              )
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-[14px] border-t border-line pt-[14px] sm:grid-cols-2">
          <Field label="Wunschsprache">
            <Select value={language} onChange={(e) => setLanguage(e.target.value as AniworldLanguagePref | '')}>
              <option value="">Globale Einstellung nutzen</option>
              <option value="auto">Automatisch</option>
              <option value="ger_sub">Deutsch Untertitel (Ger-Sub)</option>
              <option value="ger_dub">Deutsch Synchronisation (Ger-Dub)</option>
              <option value="eng_sub">Englisch Untertitel (Eng-Sub)</option>
            </Select>
          </Field>

          <Field label="Modus">
            <Select value={mode} onChange={(e) => setMode(e.target.value as 'video' | 'audio' | '')}>
              <option value="">Globale Einstellung nutzen</option>
              <option value="video">Video</option>
              <option value="audio">Nur Ton</option>
            </Select>
          </Field>

          <Field label="Videoqualität">
            <Select value={videoPref} onChange={(e) => setVideoPref(e.target.value as VideoFilePref | '')}>
              <option value="">Globale Einstellung nutzen</option>
              <option value="best">Beste verfügbare</option>
              <option value="1080p">1080p (Full HD)</option>
              <option value="720p">720p (HD)</option>
              <option value="480p">480p (Kompakt)</option>
            </Select>
          </Field>

          <Field label="Umfang beim Nachladen">
            <Select value={backlogMode} onChange={(e) => setBacklogMode(e.target.value as BacklogMode | '')}>
              <option value="">Globale Einstellung nutzen</option>
              <option value="from_current">Ungesehene ab aktuellem Stand + neue Releases</option>
              <option value="new_only">Nur neu erscheinende Folgen</option>
              <option value="all_unwatched">Alle ungesehenen Folgen aller Staffeln</option>
            </Select>
          </Field>

          <Field
            label="Vorrats-Limit insgesamt (0 = unbegrenzt)"
            hint="Begrenzt vorgeladene ungesehene Folgen."
          >
            <TextInput
              type="number"
              min={0}
              placeholder="Globale Vorgabe"
              value={lookaheadLimit}
              onChange={(e) => setLookaheadLimit(e.target.value)}
            />
          </Field>

          <Field
            label="Speicherbudget (GB, 0 = unbegrenzt)"
            hint="Pausiert neue Folgen dieser Serie ab diesem Limit."
          >
            <TextInput
              type="number"
              min={0}
              step={0.5}
              placeholder="Unbegrenzt"
              value={maxStorageGb}
              onChange={(e) => setMaxStorageGb(e.target.value)}
            />
          </Field>

          <Field
            label="Ausstrahlungstag (Wochenplan)"
            hint="Wird im Wochenplan angezeigt; leer = automatisch geschätzt."
            className="sm:col-span-2"
          >
            <Select value={airDay} onChange={(e) => setAirDay(e.target.value)}>
              <option value="">Automatisch schätzen</option>
              <option value="1">Montag</option>
              <option value="2">Dienstag</option>
              <option value="3">Mittwoch</option>
              <option value="4">Donnerstag</option>
              <option value="5">Freitag</option>
              <option value="6">Samstag</option>
              <option value="0">Sonntag</option>
            </Select>
          </Field>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-[12px] border-t border-line pt-[16px]">
          {current ? (
            <Button variant="ghost" size="sm" onClick={() => void onSave(null)}>
              Auf Standard zurücksetzen
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-[10px]">
            <Button variant="quiet" size="sm" onClick={onClose}>
              Abbrechen
            </Button>
            <Button size="sm" onClick={handleApply}>
              Regeln übernehmen
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
