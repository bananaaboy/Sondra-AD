import { useEffect, useState } from 'react'
import { useAppStore } from '../../state/appStore'
import { formatBytes, formatEta, formatRelativeTime, formatSpeed } from '../../lib/format'
import { Button, Card, Notice, Progress, RowMark, SectionHead, Stat } from '../ui/primitives'

export function OverviewPanel() {
  const config = useAppStore((s) => s.config)
  const drive = useAppStore((s) => s.drive)
  const checking = useAppStore((s) => s.checking)
  const merkItems = useAppStore((s) => s.merkItems)
  const merkMeta = useAppStore((s) => s.merkMeta)
  const queue = useAppStore((s) => s.queue)
  const episodeIndex = useAppStore((s) => s.episodeIndex)
  const storage = useAppStore((s) => s.storage)
  const logs = useAppStore((s) => s.logs)
  const runtimeMode = useAppStore((s) => s.runtimeMode)

  const checkNow = useAppStore((s) => s.checkNow)
  const toggleEngine = useAppStore((s) => s.toggleEngine)
  const setPanel = useAppStore((s) => s.setPanel)
  const retryAllFailed = useAppStore((s) => s.retryAllFailed)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])

  if (!config) return null

  const activeDownloads = queue.filter((q) => q.status === 'downloading' || q.status === 'uploading' || q.status === 'queued')
  const retryDownloads = queue.filter((q) => q.status === 'retrying' || q.status === 'failed' || q.status === 'waiting_language')
  const downloadedCount = Object.keys(episodeIndex.downloaded || {}).length
  const archivedCount = Object.keys(episodeIndex.archived || {}).length

  const watchedSeriesCount = merkItems.filter((item) => {
    const ov = config.seriesOverrides?.[item.id]
    if (ov && typeof ov.enabled === 'boolean') return ov.enabled
    return item.url && config.watchStatuses.includes(item.status || 'watching')
  }).length

  const driveInfo = storage?.drive
  const driveLimit = driveInfo?.limitBytes || 0
  const seriesPct = driveLimit > 0 ? Math.min(100, ((driveInfo?.seriesBytes || 0) / driveLimit) * 100) : 0
  const archivePct = driveLimit > 0 ? Math.min(100, ((driveInfo?.archiveBytes || 0) / driveLimit) * 100) : 0
  const otherDriveBytes = Math.max(0, (driveInfo?.usageBytes || 0) - (driveInfo?.sondraTotalBytes || 0))
  const otherPct = driveLimit > 0 ? Math.min(100, (otherDriveBytes / driveLimit) * 100) : 0

  return (
    <div className="flex flex-col gap-[28px]">
      <Card tone="mint" className="flex flex-col justify-between gap-[20px] p-[20px] sm:flex-row sm:items-center sm:p-[24px]">
        <div className="flex flex-col gap-[6px]">
          <h2 className="display-md">
            {checking
              ? 'Merkliste wird auf neue Staffeln und Episoden geprüft'
              : config.enabled
                ? 'Bereit im Dauerbetrieb'
                : 'Hintergrund-Überwachung ist pausiert'}
          </h2>
          <p className="max-w-[34em] text-body text-prose">
            {drive?.connected
              ? `Verbunden mit Google Drive${drive.account?.email ? ` (${drive.account.email})` : ''}. Neue Episoden landen direkt unter Sondra/Serien.`
              : 'Verbinden Sie Google Drive oder übernehmen Sie Ihre lokale Sondra-Anmeldung, damit Merkliste und Serien automatisch synchron bleiben.'}
          </p>
          <p className="value text-small text-muted">
            Letzte Prüfung: {formatRelativeTime(merkMeta.lastCheckAt, now)} · Nächster Lauf:{' '}
            {config.enabled ? formatRelativeTime(merkMeta.nextCheckAt, now) : 'pausiert'} · Intervall: alle{' '}
            {config.checkIntervalMinutes} Min.
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-[10px]">
          {!drive?.connected ? (
            <Button onClick={() => setPanel('einstellungen')}>Mit Sondra / Drive verbinden</Button>
          ) : (
            <Button disabled={checking} onClick={() => void checkNow()}>
              {checking ? 'Prüfung läuft …' : 'Jetzt prüfen'}
            </Button>
          )}
          <Button variant="quiet" onClick={() => void toggleEngine()}>
            {config.enabled ? 'Pausieren' : 'Fortsetzen'}
          </Button>
        </div>
      </Card>

      {!drive?.connected && config.storageTarget !== 'local_only' ? (
        <Card tone="slate">
          <p className="text-small font-semibold text-ink">Google Drive noch nicht verbunden</p>
          <p className="mt-[4px] max-w-[34em] text-small text-prose">
            Ihr Speicherziel steht auf Google Drive. Öffnen Sie die Einstellungen, um sich anzumelden oder die bestehende Anmeldung aus Ihrer Sondra-App mit einem Klick zu übernehmen.
          </p>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-[28px] lg:grid-cols-2">
        <section className="flex flex-col">
          <SectionHead rule={false} className="border-t-2 border-rule pb-[8px] pt-[12px]">
            Kennzahlen
          </SectionHead>
          <Stat
            label="Überwachte Serien auf der Merkliste"
            value={String(watchedSeriesCount)}
            note={`aus ${merkItems.length} Einträgen gesamt`}
            emphasis
          />
          <Stat
            label="Bereitliegende Episoden (Serien)"
            value={String(downloadedCount)}
            note="automatisch einsortiert für Sondra"
          />
          <Stat
            label="Archivierte Episoden"
            value={String(archivedCount)}
            note={config.inactivityEnabled ? `Inaktivitäts-Regel ab ${config.inactivityDays} Tagen` : 'Archiv-Automatik aus'}
          />
          <Stat
            label="Aktive & eingereihte Downloads"
            value={String(activeDownloads.length)}
            note={`Parallelität: max. ${config.concurrency}`}
          />
          <Stat
            label="Wiederholungen & Sprach-Warteliste"
            value={String(retryDownloads.length)}
            note={retryDownloads.length > 0 ? 'wird automatisch erneut versucht' : 'keine offenen Fehler'}
          />
          <Stat
            label="Betriebsart"
            value={runtimeMode === 'desktop' ? 'Windows-App' : 'Server'}
            note={
              config.autostartWindows
                ? 'Startet automatisch mit Windows · Standby-Schutz aktiv'
                : 'Manueller Start'
            }
          />
        </section>

        <section className="flex flex-col">
          <div className="flex items-baseline justify-between border-t-2 border-rule pb-[8px] pt-[12px]">
            <SectionHead rule={false}>Speicher & Löschgrenzen</SectionHead>
            <button
              type="button"
              onClick={() => setPanel('speicher')}
              className="press text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
            >
              Regeln anpassen
            </button>
          </div>

          {driveInfo ? (
            <div className="flex flex-col gap-[12px] pt-[8px]">
              <div className="flex flex-col gap-[6px]">
                <div className="flex items-baseline justify-between text-small">
                  <span className="text-prose">Google Drive Gesamtbelegung</span>
                  <span className="value text-ink">
                    {formatBytes(driveInfo.usageBytes)}
                    {driveLimit > 0 ? ` / ${formatBytes(driveLimit)}` : ''}
                  </span>
                </div>
                {driveLimit > 0 ? (
                  <div className="flex h-[8px] w-full overflow-hidden rounded-pill bg-ink/10">
                    <div
                      style={{ width: `${seriesPct}%` }}
                      className="bg-ink transition-[width] duration-[var(--dur-base)]"
                      title={`Sondra Serien: ${formatBytes(driveInfo.seriesBytes)}`}
                    />
                    <div
                      style={{ width: `${archivePct}%` }}
                      className="bg-ink/55 transition-[width] duration-[var(--dur-base)]"
                      title={`Sondra Archiv: ${formatBytes(driveInfo.archiveBytes)}`}
                    />
                    <div
                      style={{ width: `${otherPct}%` }}
                      className="bg-rule transition-[width] duration-[var(--dur-base)]"
                      title={`Übriges Drive: ${formatBytes(otherDriveBytes)}`}
                    />
                  </div>
                ) : null}
              </div>

              <Stat
                label="Sondra Serien in Google Drive"
                value={formatBytes(driveInfo.seriesBytes)}
                note={`${driveInfo.seriesFiles} Mediendateien`}
              />
              <Stat
                label="Sondra Archiv in Google Drive"
                value={formatBytes(driveInfo.archiveBytes)}
                note={`${driveInfo.archiveFiles} archivierte Dateien`}
              />
              <Stat
                label="Freier Speicher in Google Drive"
                value={driveInfo.freeBytes !== null ? formatBytes(driveInfo.freeBytes) : 'Unbegrenzt'}
                note={
                  config.cleanupEnabled
                    ? `Bereinigung unter ${config.minFreeDriveGb} GB frei${config.maxSondraDriveGb > 0 ? ` oder ab ${config.maxSondraDriveGb} GB Sondra` : ''}`
                    : 'Automatische Bereinigung deaktiviert'
                }
              />
            </div>
          ) : (
            <div className="flex flex-col pt-[4px]">
              <Stat
                label="Lokaler Freispeicher"
                value={storage?.local?.totalBytes ? formatBytes(storage.local.freeBytes) : '—'}
                note={storage?.local?.path || config.localDir}
              />
              <Stat
                label="Temporärer Arbeitsordner"
                value={formatBytes(storage?.local?.tempBytes || 0)}
                note="wird nach jedem Upload sofort geleert"
              />
              <Stat
                label="Lokales Archiv"
                value={formatBytes(storage?.local?.archiveBytes || 0)}
                note={`${storage?.local?.archiveFiles || 0} ausgelagerte Dateien`}
              />
            </div>
          )}
        </section>
      </div>

      <section className="flex flex-col gap-[12px]">
        <div className="flex items-baseline justify-between border-t-2 border-rule pt-[12px]">
          <SectionHead rule={false}>Laufende & anstehende Aufgaben</SectionHead>
          <div className="flex items-center gap-[14px]">
            {retryDownloads.length > 0 ? (
              <button
                type="button"
                onClick={() => void retryAllFailed()}
                className="press text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
              >
                Alle Wiederholungen sofort starten
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setPanel('warteschlange')}
              className="press text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
            >
              Zur Warteschlange
            </button>
          </div>
        </div>

        {activeDownloads.length === 0 && retryDownloads.length === 0 ? (
          <p className="py-[8px] text-small text-muted">
            Aktuell laufen keine Downloads. Neue Staffeln und Episoden Ihrer Merkliste werden beim nächsten Prüflauf automatisch eingereiht.
          </p>
        ) : (
          <ul className="rise-list flex flex-col">
            {[...activeDownloads, ...retryDownloads].slice(0, 6).map((job) => (
              <li
                key={job.id}
                className="flex flex-col gap-[6px] border-t border-line py-[10px] first:border-t-0"
              >
                <div className="flex items-baseline justify-between gap-[12px]">
                  <div className="flex min-w-0 items-center gap-[8px]">
                    <RowMark
                      state={
                        job.status === 'downloading' || job.status === 'uploading'
                          ? 'running'
                          : job.status === 'failed' || job.status === 'retrying'
                            ? 'error'
                            : 'pending'
                      }
                    />
                    <span className="truncate text-small font-semibold text-ink">{job.title}</span>
                  </div>
                  <span className="value shrink-0 text-micro text-muted">
                    {job.status === 'downloading'
                      ? `Lädt${job.activeHoster ? ` · ${job.activeHoster}` : ''} · ${formatSpeed(job.speedBps)}${job.etaSeconds ? ` · ${formatEta(job.etaSeconds)}` : ''}`
                      : job.status === 'uploading'
                        ? `Drive-Upload · ${formatSpeed(job.speedBps)}`
                        : job.status === 'retrying'
                          ? `Versuch ${job.attempts} · erneut ${formatRelativeTime(job.nextRetryAt, now)}`
                          : job.status === 'waiting_language'
                            ? 'Wartet auf Wunschsprache'
                            : job.status === 'failed'
                              ? 'Fehlgeschlagen'
                              : 'Eingereiht'}
                  </span>
                </div>
                {job.status === 'downloading' || job.status === 'uploading' ? (
                  <Progress value={job.progress > 0 ? job.progress / 100 : null} />
                ) : null}
                {job.error ? <p className="text-micro text-muted">{job.error}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-[8px]">
        <div className="flex items-baseline justify-between border-t-2 border-rule pt-[12px]">
          <SectionHead rule={false}>Letzte Ereignisse im Protokoll</SectionHead>
          <button
            type="button"
            onClick={() => setPanel('protokoll')}
            className="press text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
          >
            Vollständiges Protokoll
          </button>
        </div>
        {logs.length === 0 ? (
          <p className="py-[8px] text-small text-muted">Noch keine Einträge im Protokoll.</p>
        ) : (
          <ul className="flex flex-col">
            {logs.slice(0, 5).map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col justify-between gap-[4px] border-t border-line py-[8px] first:border-t-0 sm:flex-row sm:items-baseline sm:gap-[16px]"
              >
                <div className="flex min-w-0 items-baseline gap-[8px]">
                  <span className="value text-small font-bold text-ink">
                    {entry.level === 'error' ? '!' : entry.level === 'warn' ? '·' : '●'}
                  </span>
                  <span className="truncate text-small font-medium text-ink">{entry.title}</span>
                  <span className="hidden truncate text-small text-muted md:inline">— {entry.message}</span>
                </div>
                <span className="value shrink-0 text-micro text-muted">{formatRelativeTime(entry.at, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {retryDownloads.some((j) => j.status === 'failed') ? (
        <Notice tone="warn" title="Einige Downloads haben das Wiederholungslimit erreicht">
          Öffnen Sie die Warteschlange, um die betroffenen Episoden mit einem anderen Hoster erneut zu starten oder die Ursache im Protokoll einzusehen.
        </Notice>
      ) : null}
    </div>
  )
}
