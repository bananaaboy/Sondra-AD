import { useMemo, useState } from 'react'
import { useAppStore } from '../../state/appStore'
import { episodeLabel, formatRelativeTime } from '../../lib/format'
import type {
  AniworldLanguagePref,
  BacklogMode,
  SavedLinkItem,
  SavedLinkStatus,
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

export function WatchlistPanel() {
  const config = useAppStore((s) => s.config)
  const drive = useAppStore((s) => s.drive)
  const checking = useAppStore((s) => s.checking)
  const merkItems = useAppStore((s) => s.merkItems)
  const episodeIndex = useAppStore((s) => s.episodeIndex)

  const syncMerkliste = useAppStore((s) => s.syncMerkliste)
  const checkNow = useAppStore((s) => s.checkNow)
  const upsertSeries = useAppStore((s) => s.upsertSeries)
  const removeSeries = useAppStore((s) => s.removeSeries)
  const setSeriesOverride = useAppStore((s) => s.setSeriesOverride)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | SavedLinkStatus>('all')
  const [syncing, setSyncing] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)

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

      {filtered.length === 0 ? (
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
      ) : (
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
      )}

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

  return (
    <Dialog open onClose={onClose} title={`Auto-Download-Regel: ${item.title}`} size="md">
      <div className="flex flex-col gap-[16px]">
        <SectionHead rule={false}>Einzelregel für diese Serie</SectionHead>
        <Toggle
          label="Serie automatisch überwachen und herunterladen"
          checked={enabled}
          onChange={setEnabled}
        />

        <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
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
            label="Vorrats-Limit (ungesehene Folgen im Voraus)"
            hint="Leer = globale Vorgabe; 0 = unbegrenzt; z. B. 3 = immer höchstens die nächsten 3 Folgen vorladen."
            className="sm:col-span-2"
          >
            <TextInput
              type="number"
              min={0}
              placeholder="Globale Vorgabe"
              value={lookaheadLimit}
              onChange={(e) => setLookaheadLimit(e.target.value)}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-[12px] border-t border-line pt-[16px]">
          {current ? (
            <Button variant="ghost" size="sm" onClick={() => void onSave(null)}>
              Auf globalen Standard zurücksetzen
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-[10px]">
            <Button variant="quiet" size="sm" onClick={onClose}>
              Abbrechen
            </Button>
            <Button
              size="sm"
              onClick={() =>
                void onSave({
                  enabled,
                  ...(language ? { language } : {}),
                  ...(mode ? { mode } : {}),
                  ...(videoPref ? { videoPref } : {}),
                  ...(backlogMode ? { backlogMode } : {}),
                  ...(lookaheadLimit.trim() !== '' ? { lookaheadLimit: Math.max(0, Number(lookaheadLimit) || 0) } : {}),
                })
              }
            >
              Regel übernehmen
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
