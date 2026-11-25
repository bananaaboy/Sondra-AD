import { useEffect, useState } from 'react'
import { apiCall, useAppStore } from '../../state/appStore'
import { episodeLabel, formatBytes } from '../../lib/format'
import type { InactivityAction } from '../../types'
import { Button, Card, Field, Notice, SectionHead, Select, Stat, TextInput, Toggle } from '../ui/primitives'

interface CleanupPreview {
  neededDriveBytes: number
  neededLocalBytes: number
  reclaimableBytes: number
  deletedCount?: number
  deletedBytes?: number
  candidates: {
    target: 'drive' | 'local'
    reason: string
    id: string
    name: string
    path: string
    sizeBytes: number
  }[]
}

interface ArchivePreview {
  processed?: number
  pausedSeries?: number
  planned?: {
    id: string
    name: string
    path: string
    sizeBytes: number
    seriesTitle: string | null
    inactiveDays: number
    operations: string[]
  }[]
}

const INACTIVITY_OPTIONS: { id: InactivityAction; label: string; desc: string }[] = [
  {
    id: 'drive_archive',
    label: 'In Google Drive nach „Sondra/Archiv“ verschieben',
    desc: 'Trennt lange ungenutzte Serien sauber vom aktiven Serien-Ordner.',
  },
  {
    id: 'compress_archive',
    label: 'Vor dem Archivieren platzsparend mit FFmpeg verkleinern',
    desc: 'Rechnet große Videodateien vor der Ablage im Archiv kompakt um (sofern FFmpeg installiert ist).',
  },
  {
    id: 'offload_local',
    label: 'Auf lokale Archiv-Festplatte auslagern und aus Google Drive entfernen',
    desc: 'Lädt die Dateien auf den lokalen Server/Laptop herunter und gibt den Cloud-Speicher komplett frei.',
  },
  {
    id: 'pause_series',
    label: 'Auto-Download für die inaktive Serie pausieren',
    desc: 'Stoppt weiteres Nachladen neuer Episoden, bis Sie die Serie wieder öffnen.',
  },
  {
    id: 'delete',
    label: 'Inaktive Dateien sofort endgültig löschen',
    desc: 'Entfernt lange nicht genutzte Dateien vollständig statt sie zu archivieren.',
  },
]

export function StorageArchivePanel() {
  const config = useAppStore((s) => s.config)
  const storage = useAppStore((s) => s.storage)
  const loadingStorage = useAppStore((s) => s.loadingStorage)
  const episodeIndex = useAppStore((s) => s.episodeIndex)
  const merkItems = useAppStore((s) => s.merkItems)

  const updateConfig = useAppStore((s) => s.updateConfig)
  const refreshStorage = useAppStore((s) => s.refreshStorage)
  const bootstrap = useAppStore((s) => s.bootstrap)

  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview | null>(null)
  const [archivePreview, setArchivePreview] = useState<ArchivePreview | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [statusNote, setStatusNote] = useState<string | null>(null)

  useEffect(() => {
    void refreshStorage()
  }, [refreshStorage])

  if (!config) return null

  const toggleInactivityAction = (action: InactivityAction) => {
    const cur = new Set(config.inactivityActions || [])
    if (cur.has(action)) {
      if (cur.size > 1) cur.delete(action)
    } else {
      cur.add(action)
    }
    void updateConfig({ inactivityActions: [...cur] })
  }

  const handleCleanup = async (dryRun: boolean) => {
    setBusyAction(dryRun ? 'cleanup-preview' : 'cleanup-run')
    setStatusNote(null)
    try {
      const res = await apiCall<CleanupPreview>('storage/cleanup', { body: { dryRun } })
      setCleanupPreview(res)
      if (!dryRun) {
        await refreshStorage()
        setStatusNote(
          res.deletedCount
            ? `${res.deletedCount} Datei(en) gelöscht (${formatBytes(res.deletedBytes || 0)} freigegeben).`
            : 'Speicher liegt innerhalb der eingestellten Grenzen — nichts zu löschen.',
        )
      }
    } catch (err) {
      setStatusNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyAction(null)
    }
  }

  const handleArchive = async (dryRun: boolean) => {
    setBusyAction(dryRun ? 'archive-preview' : 'archive-run')
    setStatusNote(null)
    try {
      const res = await apiCall<ArchivePreview>('archive/run', { body: { dryRun } })
      setArchivePreview(res)
      if (!dryRun) {
        await refreshStorage()
        await bootstrap()
        setStatusNote(
          res.processed
            ? `${res.processed} inaktive Datei(en) verarbeitet.`
            : 'Aktuell überschreitet keine Serie die eingestellte Inaktivitäts-Frist.',
        )
      }
    } catch (err) {
      setStatusNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyAction(null)
    }
  }

  const handleRestore = async (key: string) => {
    const rec = episodeIndex.archived[key]
    if (!rec) return
    const series = merkItems.find((m) => m.id === rec.seriesId)
    setBusyAction(`restore-${key}`)
    try {
      await apiCall('archive/restore', {
        body: {
          driveFileId: rec.driveFileId || null,
          localArchivePath: rec.localArchivePath || null,
          seriesId: rec.seriesId,
          season: rec.season,
          episode: rec.episode,
          seriesTitle: series?.title || 'Serie',
        },
      })
      await refreshStorage()
      await bootstrap()
    } catch (err) {
      setStatusNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyAction(null)
    }
  }

  const archivedEntries = Object.entries(episodeIndex.archived || {})
  const merkMap = new Map(merkItems.map((m) => [m.id, m]))
  const d = storage?.drive

  return (
    <div className="flex flex-col gap-[32px]">
      <div className="flex flex-col justify-between gap-[16px] sm:flex-row sm:items-end">
        <div className="flex flex-col gap-[4px]">
          <h2 className="display-md">Speicher & Archiv</h2>
          <p className="max-w-[34em] text-small text-muted">
            Legen Sie genau fest, ab welcher Belegung alte gesehene Episoden automatisch gelöscht werden und was mit lange ungenutzten Serien geschieht.
          </p>
        </div>
        <Button variant="quiet" size="sm" disabled={loadingStorage} onClick={() => void refreshStorage()}>
          {loadingStorage ? 'Misst Speicher …' : 'Speicher neu messen'}
        </Button>
      </div>

      {statusNote ? <Notice tone="info">{statusNote}</Notice> : null}

      <div className="grid grid-cols-1 gap-[28px] lg:grid-cols-2">
        <section className="flex flex-col">
          <SectionHead rule={false} className="border-t-2 border-rule pb-[8px] pt-[12px]">
            Google Drive Kontingent
          </SectionHead>
          {d ? (
            <>
              <Stat
                label="Gesamtspeicher belegt"
                value={formatBytes(d.usageBytes)}
                note={d.limitBytes > 0 ? `von ${formatBytes(d.limitBytes)} Kontingent` : 'Unbegrenztes Konto'}
                emphasis
              />
              <Stat
                label="Freier Speicher in Google Drive"
                value={d.freeBytes !== null ? formatBytes(d.freeBytes) : 'Unbegrenzt'}
              />
              <Stat
                label="Sondra/Serien"
                value={formatBytes(d.seriesBytes)}
                note={`${d.seriesFiles} aktive Episoden`}
              />
              <Stat
                label="Sondra/Archiv"
                value={formatBytes(d.archiveBytes)}
                note={`${d.archiveFiles} archivierte Dateien`}
              />
              <Stat
                label="Sondra-Dateien im Drive-Papierkorb"
                value={formatBytes(d.sondraTrashBytes)}
                note={`${d.sondraTrashFiles} Dateien (belegen weiterhin Kontingent bis zur Leerung)`}
              />
            </>
          ) : (
            <p className="py-[12px] text-small text-muted">
              Google Drive ist aktuell nicht verbunden. Es werden nur lokale Speicherwerte gemessen.
            </p>
          )}
        </section>

        <section className="flex flex-col">
          <SectionHead rule={false} className="border-t-2 border-rule pb-[8px] pt-[12px]">
            Lokaler Datenträger
          </SectionHead>
          <Stat
            label="Freier Speicherplatz lokal"
            value={storage?.local?.totalBytes ? formatBytes(storage.local.freeBytes) : '—'}
            note={
              storage?.local?.totalBytes
                ? `von ${formatBytes(storage.local.totalBytes)} (${storage.local.path})`
                : config.localDir
            }
            emphasis
          />
          <Stat
            label="Lokale Kopien (Sondra-AD)"
            value={formatBytes(storage?.local?.savedBytes || 0)}
            note={`${storage?.local?.savedFiles || 0} Dateien`}
          />
          <Stat
            label="Lokales Auslagerungs-Archiv"
            value={formatBytes(storage?.local?.archiveBytes || 0)}
            note={`${storage?.local?.archiveFiles || 0} ausgelagerte Dateien`}
          />
          <Stat
            label="Temporärer Staging-Ordner"
            value={formatBytes(storage?.local?.tempBytes || 0)}
            note="wird nach jedem Upload automatisch bereinigt"
          />
        </section>
      </div>

      <section className="flex flex-col gap-[16px] border-t-2 border-rule pt-[20px]">
        <div className="flex flex-col gap-[4px]">
          <h3 className="display-sm">Automatische Speicherbereinigung</h3>
          <p className="max-w-[34em] text-small text-muted">
            Sobald ein Grenzwert erreicht wird, räumt Sondra AD in festgelegter Reihenfolge Platz frei — beginnend mit dem Papierkorb und bereits gesehenen Folgen.
          </p>
        </div>

        <Toggle
          label="Automatische Speicherbereinigung aktivieren"
          hint="Prüft regelmäßig und nach Downloads, ob Google Drive oder die lokale Festplatte unter das Freispeicher-Limit fällt."
          checked={config.cleanupEnabled}
          onChange={(val) => void updateConfig({ cleanupEnabled: val })}
        />

        <div className="grid grid-cols-1 gap-[16px] sm:grid-cols-3">
          <Field
            label="Max. Google-Drive-Speicher für Sondra (GB)"
            hint="0 = kein eigenes Sondra-Limit; z. B. 50 = ab 50 GB Sondra-Belegung löschen."
          >
            <TextInput
              type="number"
              min={0}
              step={1}
              value={config.maxSondraDriveGb}
              onChange={(e) => void updateConfig({ maxSondraDriveGb: Math.max(0, Number(e.target.value) || 0) })}
            />
          </Field>

          <Field
            label="Mindestens frei halten in Google Drive (GB)"
            hint="Räumt auf, sobald weniger als dieser Wert in Ihrem Google-Konto frei ist."
          >
            <TextInput
              type="number"
              min={0}
              step={0.5}
              value={config.minFreeDriveGb}
              onChange={(e) => void updateConfig({ minFreeDriveGb: Math.max(0, Number(e.target.value) || 0) })}
            />
          </Field>

          <Field
            label="Mindestens frei halten auf lokaler Platte (GB)"
            hint="Schützt Server und Laptop vor volllaufender Festplatte."
          >
            <TextInput
              type="number"
              min={0}
              step={1}
              value={config.minFreeLocalGb}
              onChange={(e) => void updateConfig({ minFreeLocalGb: Math.max(0, Number(e.target.value) || 0) })}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-[14px] pt-[4px] sm:grid-cols-2">
          <Toggle
            label="Zuerst Sondra-Papierkorb in Google Drive leeren"
            hint="Gelöschte Dateien im Papierkorb zählen bei Google Drive sonst 30 Tage lang weiter zum Verbrauch."
            checked={config.emptyDriveTrashFirst}
            onChange={(val) => void updateConfig({ emptyDriveTrashFirst: val })}
          />
          <Toggle
            label="Bereits als „Gesehen“ markierte Episoden löschen (älteste zuerst)"
            hint="Nutzt den Schau-Fortschritt aus Ihrer Sondra-Merkliste."
            checked={config.deleteWatchedFirst}
            onChange={(val) => void updateConfig({ deleteWatchedFirst: val })}
          />
          <Toggle
            label="Archivierte Episoden ebenfalls löschen, falls Speicher weiterhin voll ist"
            checked={config.deleteArchivedWhenFull}
            onChange={(val) => void updateConfig({ deleteArchivedWhenFull: val })}
          />
          <Toggle
            label="Ungesehene Episoden strikt schützen (nie automatisch löschen)"
            checked={config.protectUnwatched}
            onChange={(val) => void updateConfig({ protectUnwatched: val })}
          />
        </div>

        <div className="max-w-[320px]">
          <Field
            label="Zuletzt gesehene Folgen pro Serie verschonen"
            hint="Behält z. B. die letzte gesehene Folge für Rückblicke."
          >
            <TextInput
              type="number"
              min={0}
              max={20}
              value={config.keepRecentWatchedCount}
              onChange={(e) => void updateConfig({ keepRecentWatchedCount: Math.max(0, Number(e.target.value) || 0) })}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-[10px] pt-[4px]">
          <Button
            variant="quiet"
            size="sm"
            disabled={busyAction !== null}
            onClick={() => void handleCleanup(true)}
          >
            {busyAction === 'cleanup-preview' ? 'Berechnet Vorschau …' : 'Vorschau berechnen'}
          </Button>
          <Button
            size="sm"
            disabled={busyAction !== null}
            onClick={() => void handleCleanup(false)}
          >
            {busyAction === 'cleanup-run' ? 'Bereinigt …' : 'Jetzt Speicher bereinigen'}
          </Button>
        </div>

        {cleanupPreview ? (
          <Card tone="mint" className="flex flex-col gap-[8px]">
            <p className="text-small font-semibold text-ink">
              Bereinigungs-Plan: {cleanupPreview.candidates.length} Datei(en) ({formatBytes(cleanupPreview.reclaimableBytes)})
            </p>
            <p className="value text-micro text-muted">
              Freizugebender Bedarf — Drive: {formatBytes(cleanupPreview.neededDriveBytes)} · Lokal:{' '}
              {formatBytes(cleanupPreview.neededLocalBytes)}
            </p>
            {cleanupPreview.candidates.length === 0 ? (
              <p className="text-small text-prose">Aktuell müssen keine Dateien gelöscht werden.</p>
            ) : (
              <ul className="flex max-h-[220px] flex-col overflow-y-auto">
                {cleanupPreview.candidates.map((c) => (
                  <li key={c.id} className="flex items-baseline justify-between gap-[12px] border-t border-line py-[6px] text-small">
                    <span className="truncate text-prose">
                      {c.name} <span className="text-muted">({c.reason})</span>
                    </span>
                    <span className="value shrink-0 text-ink">{formatBytes(c.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}
      </section>

      <section className="flex flex-col gap-[16px] border-t-2 border-rule pt-[20px]">
        <div className="flex flex-col gap-[4px]">
          <h3 className="display-sm">Inaktivität & Archivierung („Lange nicht genutzt“)</h3>
          <p className="max-w-[34em] text-small text-muted">
            Erkennt anhand des letzten Öffnens bzw. Schau-Verlaufs in Sondra, welche Serien lange ruhen, und verschiebt, verkleinert oder lagert deren Episoden automatisch aus.
          </p>
        </div>

        <Toggle
          label="Automatische Inaktivitäts-Regel aktivieren"
          checked={config.inactivityEnabled}
          onChange={(val) => void updateConfig({ inactivityEnabled: val })}
        />

        <div className="grid grid-cols-1 gap-[16px] sm:grid-cols-3">
          <Field
            label="Inaktiv ab (Tage ohne Nutzung)"
            hint="Gemessen seit der letzten gesehenen Folge oder Änderung."
          >
            <TextInput
              type="number"
              min={1}
              max={1000}
              value={config.inactivityDays}
              onChange={(e) => void updateConfig({ inactivityDays: Math.max(1, Number(e.target.value) || 45) })}
            />
          </Field>

          <Field label="Qualitätsstufe bei FFmpeg-Archivkomprimierung">
            <Select
              value={String(config.archiveCompressHeight)}
              onChange={(e) => void updateConfig({ archiveCompressHeight: Number(e.target.value) })}
            >
              <option value="720">720p Kompakt (empfohlen)</option>
              <option value="480">480p Maximale Platzersparnis</option>
            </Select>
          </Field>

          <Field
            label="Archiv endgültig löschen nach weiteren (Tagen)"
            hint="0 = im Archiv dauerhaft behalten."
          >
            <TextInput
              type="number"
              min={0}
              value={config.archiveDeleteAfterDays}
              onChange={(e) => void updateConfig({ archiveDeleteAfterDays: Math.max(0, Number(e.target.value) || 0) })}
            />
          </Field>
        </div>

        <div className="flex flex-col gap-[12px] border-t border-line pt-[12px]">
          <span className="text-small font-semibold text-ink">Aktionen bei Inaktivität (kombinierbar)</span>
          {INACTIVITY_OPTIONS.map((opt) => (
            <Toggle
              key={opt.id}
              label={opt.label}
              hint={opt.desc}
              checked={(config.inactivityActions || []).includes(opt.id)}
              onChange={() => toggleInactivityAction(opt.id)}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-[10px] pt-[4px]">
          <Button
            variant="quiet"
            size="sm"
            disabled={busyAction !== null}
            onClick={() => void handleArchive(true)}
          >
            {busyAction === 'archive-preview' ? 'Prüft Inaktivität …' : 'Inaktive Dateien anzeigen'}
          </Button>
          <Button
            size="sm"
            disabled={busyAction !== null}
            onClick={() => void handleArchive(false)}
          >
            {busyAction === 'archive-run' ? 'Archiviert …' : 'Inaktivitäts-Regel jetzt ausführen'}
          </Button>
        </div>

        {archivePreview?.planned ? (
          <Card tone="mint" className="flex flex-col gap-[8px]">
            <p className="text-small font-semibold text-ink">
              Inaktivitäts-Vorschau: {archivePreview.planned.length} betroffene Datei(en)
            </p>
            {archivePreview.planned.length === 0 ? (
              <p className="text-small text-prose">Keine Datei überschreitet derzeit die Frist von {config.inactivityDays} Tagen.</p>
            ) : (
              <ul className="flex max-h-[220px] flex-col overflow-y-auto">
                {archivePreview.planned.map((p) => (
                  <li key={p.id} className="flex items-baseline justify-between gap-[12px] border-t border-line py-[6px] text-small">
                    <span className="truncate text-prose">
                      {p.name} <span className="text-muted">(seit {p.inactiveDays} Tagen ungenutzt)</span>
                    </span>
                    <span className="value shrink-0 text-ink">{formatBytes(p.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}
      </section>

      <section className="flex flex-col gap-[10px] border-t-2 border-rule pt-[20px]">
        <SectionHead rule={false}>Aktuell im Archiv ({archivedEntries.length})</SectionHead>
        {archivedEntries.length === 0 ? (
          <p className="text-small text-muted">Derzeit liegen keine Episoden im Archiv.</p>
        ) : (
          <ul className="flex flex-col">
            {archivedEntries.map(([key, rec]) => {
              const sTitle = merkMap.get(rec.seriesId)?.title || rec.seriesId
              return (
                <li
                  key={key}
                  className="flex flex-col justify-between gap-[8px] border-t border-line py-[10px] first:border-t-0 sm:flex-row sm:items-center"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-small font-semibold text-ink">
                      {sTitle} · {episodeLabel(rec.season, rec.episode)}
                    </span>
                    <span className="value truncate text-micro text-muted">
                      {rec.drivePath
                        ? `Google Drive: Sondra/${rec.drivePath}`
                        : rec.localArchivePath
                          ? `Lokal ausgelagert: ${rec.localArchivePath}`
                          : rec.fileName}{' '}
                      · {formatBytes(rec.sizeBytes || 0)}
                    </span>
                  </div>
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={busyAction !== null}
                    onClick={() => void handleRestore(key)}
                  >
                    {busyAction === `restore-${key}` ? 'Stellt wieder her …' : 'Zurück zu Serien'}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
