import { useEffect, useState } from 'react'
import { useAppStore } from '../../state/appStore'
import { formatBytes, formatEta, formatRelativeTime, formatSpeed } from '../../lib/format'
import type { QueueJob } from '../../types'
import { Button, Card, Progress, RowMark, SectionHead, Select, TextInput } from '../ui/primitives'

type QueueFilter = 'all' | 'active' | 'retry' | 'completed'

export function QueuePanel() {
  const queue = useAppStore((s) => s.queue)
  const addQueueUrl = useAppStore((s) => s.addQueueUrl)
  const retryJob = useAppStore((s) => s.retryJob)
  const retryAllFailed = useAppStore((s) => s.retryAllFailed)
  const cancelJob = useAppStore((s) => s.cancelJob)
  const cancelAllJobs = useAppStore((s) => s.cancelAllJobs)
  const removeJob = useAppStore((s) => s.removeJob)
  const clearCompletedJobs = useAppStore((s) => s.clearCompletedJobs)
  const shutdownAfterQueue = useAppStore((s) => Boolean(s.config?.shutdownAfterQueue || s.shutdownState?.shutdownAfterQueue))
  const setShutdownAfterQueue = useAppStore((s) => s.setShutdownAfterQueue)

  const [manualUrl, setManualUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [filter, setFilter] = useState<QueueFilter>('all')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 3000)
    return () => clearInterval(t)
  }, [])

  const handleAddUrl = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!manualUrl.trim()) return
    setAdding(true)
    setFeedback(null)
    try {
      const count = await addQueueUrl({ url: manualUrl.trim() })
      setManualUrl('')
      setFeedback(count > 0 ? `${count} Eintrag/Einträge in die Warteschlange aufgenommen.` : 'Eintrag befindet sich bereits in der Warteschlange.')
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }

  const ordered = [...queue].sort((a, b) => {
    const rank = (s: QueueJob['status']) =>
      s === 'downloading' || s === 'uploading'
        ? 0
        : s === 'queued'
          ? 1
          : s === 'retrying' || s === 'waiting_language'
            ? 2
            : s === 'failed'
              ? 3
              : 4
    return rank(a.status) - rank(b.status) || b.updatedAt - a.updatedAt
  })

  const visible = ordered.filter((job) => {
    if (filter === 'active') return job.status === 'downloading' || job.status === 'uploading' || job.status === 'queued'
    if (filter === 'retry') return job.status === 'retrying' || job.status === 'failed' || job.status === 'waiting_language'
    if (filter === 'completed') return job.status === 'completed' || job.status === 'cancelled'
    return true
  })

  const cancellableCount = queue.filter(
    (q) =>
      q.status === 'downloading' ||
      q.status === 'uploading' ||
      q.status === 'queued' ||
      q.status === 'retrying' ||
      q.status === 'waiting_language',
  ).length
  const retryCount = queue.filter(
    (q) => q.status === 'retrying' || q.status === 'failed' || q.status === 'waiting_language' || q.status === 'cancelled',
  ).length
  const completedCount = queue.filter((q) => q.status === 'completed' || q.status === 'cancelled').length

  return (
    <div className="flex flex-col gap-[24px]">
      <div className="flex flex-col gap-[4px]">
        <h2 className="display-md">Warteschlange</h2>
        <p className="max-w-[34em] text-small text-muted">
          Alle automatischen und manuellen Downloads. Bei Hoster-Störungen wechselt Sondra AD selbstständig auf den nächsten Mirror und plant bei Netzausfällen gestaffelte Wiederholungen ein.
        </p>
      </div>

      <Card tone="mint" className="p-[16px] sm:p-[20px]">
        <form onSubmit={(e) => void handleAddUrl(e)} className="flex flex-col gap-[10px]">
          <span className="text-small font-semibold text-ink">Einzelne Folge oder ganze Staffel direkt einreihen</span>
          <div className="flex flex-col gap-[10px] sm:flex-row">
            <TextInput
              placeholder="https://aniworld.to/anime/stream/… oder direkte Medienadresse"
              value={manualUrl}
              onChange={(e) => setManualUrl(e.target.value)}
              className="flex-1"
            />
            <Button type="submit" size="sm" disabled={adding || !manualUrl.trim()}>
              {adding ? 'Wird aufgelöst …' : 'Einreihen'}
            </Button>
          </div>
          {feedback ? <p className="text-micro text-ink">{feedback}</p> : null}
        </form>
      </Card>

      <div className="flex flex-col justify-between gap-[12px] border-t-2 border-rule pt-[14px] sm:flex-row sm:items-center">
        <div className="flex flex-wrap gap-[6px]">
          {(
            [
              ['all', `Alle (${queue.length})`],
              ['active', 'Aktiv & Eingereiht'],
              ['retry', `Wiederholung & Fehler (${retryCount})`],
              ['completed', `Abgeschlossen (${completedCount})`],
            ] as const
          ).map(([key, label]) => {
            const on = filter === key
            return (
              <button
                key={key}
                type="button"
                aria-pressed={on}
                onClick={() => setFilter(key)}
                className={`press rounded-pill px-[12px] py-[6px] text-small font-medium ${
                  on ? 'bg-ink font-semibold text-on-ink' : 'bg-panel-soft text-prose hover:text-ink'
                }`}
              >
                {label}
              </button>
            )
          })}
        </div>

        <div className="flex flex-wrap items-center gap-[10px]">
          <button
            type="button"
            aria-pressed={shutdownAfterQueue}
            onClick={() => void setShutdownAfterQueue(!shutdownAfterQueue)}
            className={`press rounded-pill border px-[12px] py-[6px] text-micro font-medium transition-colors ${
              shutdownAfterQueue
                ? 'border-ink bg-ink text-on-ink'
                : 'border-line bg-surface text-prose hover:border-ink hover:text-ink'
            }`}
          >
            {shutdownAfterQueue ? 'Danach herunterfahren: An' : 'Danach herunterfahren'}
          </button>
          {cancellableCount > 0 ? (
            <Button variant="quiet" size="sm" onClick={() => void cancelAllJobs()}>
              Alle abbrechen ({cancellableCount})
            </Button>
          ) : null}
          {retryCount > 0 ? (
            <Button variant="quiet" size="sm" onClick={() => void retryAllFailed()}>
              Fehlversuche wiederholen
            </Button>
          ) : null}
          {completedCount > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => void clearCompletedJobs()}>
              Abgeschlossene leeren
            </Button>
          ) : null}
        </div>
      </div>

      {visible.length === 0 ? (
        <SectionHead rule={false} className="py-[12px] font-normal text-muted">
          Keine Einträge in dieser Ansicht der Warteschlange.
        </SectionHead>
      ) : (
        <ul className="rise-list flex flex-col">
          {visible.map((job) => (
            <QueueRow
              key={job.id}
              job={job}
              now={now}
              onRetry={(hoster) => void retryJob(job.id, hoster)}
              onCancel={() => void cancelJob(job.id)}
              onRemove={() => void removeJob(job.id)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function QueueRow({
  job,
  now,
  onRetry,
  onCancel,
  onRemove,
}: {
  job: QueueJob
  now: number
  onRetry: (hoster?: string | null) => void
  onCancel: () => void
  onRemove: () => void
}) {
  const [hosterChoice, setHosterChoice] = useState(job.preferredHoster || '')
  const isRunning = job.status === 'downloading' || job.status === 'uploading'

  return (
    <li className="flex flex-col gap-[8px] border-t border-line py-[14px] first:border-t-0">
      <div className="flex flex-col justify-between gap-[8px] sm:flex-row sm:items-baseline">
        <div className="flex min-w-0 items-center gap-[8px]">
          <RowMark
            state={
              job.status === 'completed'
                ? 'done'
                : isRunning
                  ? 'running'
                  : job.status === 'failed' || job.status === 'retrying'
                    ? 'error'
                    : 'pending'
            }
          />
          <span className="truncate text-body font-semibold text-ink">{job.title}</span>
        </div>

        <span className="value shrink-0 text-small text-prose">
          {job.status === 'downloading'
            ? `Lädt${job.activeHoster ? ` (${job.activeHoster})` : ''} · ${formatSpeed(job.speedBps)}${job.etaSeconds ? ` · Rest ${formatEta(job.etaSeconds)}` : ''}`
            : job.status === 'uploading'
              ? `Google Drive Upload · ${formatSpeed(job.speedBps)}`
              : job.status === 'completed'
                ? `Fertig · ${formatBytes(job.totalBytes)}${job.activeHoster ? ` · ${job.activeHoster}` : ''}`
                : job.status === 'retrying'
                  ? `Fehlversuch ${job.attempts} · Nächster Versuch ${formatRelativeTime(job.nextRetryAt, now)}`
                  : job.status === 'waiting_language'
                    ? `Wartet auf Wunschsprache · Prüft ${formatRelativeTime(job.nextRetryAt, now)}`
                    : job.status === 'failed'
                      ? `Dauerhaft fehlgeschlagen (${job.attempts} Versuche)`
                      : job.status === 'cancelled'
                        ? 'Abgebrochen'
                        : 'Wartet in Schlange'}
        </span>
      </div>

      {isRunning ? (
        <Progress
          value={job.progress > 0 ? job.progress / 100 : null}
          label={
            job.totalBytes > 0
              ? `${formatBytes(job.loadedBytes)} von ${formatBytes(job.totalBytes)}`
              : 'Datenstrom aktiv'
          }
        />
      ) : null}

      {job.drivePath ? (
        <p className="value text-micro text-muted">Gespeichert in Google Drive: Sondra/{job.drivePath}</p>
      ) : job.localPath ? (
        <p className="value text-micro text-muted">Lokal gespeichert: {job.localPath}</p>
      ) : null}

      {job.error ? <p className="text-small text-ink">! {job.error}</p> : null}

      {job.triedHosters && job.triedHosters.length > 0 ? (
        <p className="value text-micro text-muted">Geprüfte Hoster: {job.triedHosters.join(' → ')}</p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-[10px] pt-[2px]">
        <span className="value truncate text-micro text-faint">{job.url}</span>

        <div className="flex flex-wrap items-center gap-[8px]">
          {job.status === 'retrying' || job.status === 'failed' || job.status === 'waiting_language' || job.status === 'cancelled' ? (
            <>
              <div className="w-[150px]">
                <Select
                  value={hosterChoice}
                  onChange={(e) => setHosterChoice(e.target.value)}
                  aria-label="Hoster wählen"
                >
                  <option value="">Hoster automatisch</option>
                  <option value="voe">VOE bevorzugen</option>
                  <option value="filemoon">FileMoon bevorzugen</option>
                  <option value="vidmoly">Vidmoly bevorzugen</option>
                  <option value="streamtape">Streamtape bevorzugen</option>
                  <option value="vidoza">Vidoza bevorzugen</option>
                  <option value="dood">Doodstream bevorzugen</option>
                </Select>
              </div>
              <Button variant="quiet" size="sm" onClick={() => onRetry(hosterChoice || null)}>
                Sofort wiederholen
              </Button>
            </>
          ) : null}

          {isRunning || job.status === 'queued' ? (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Abbrechen
            </Button>
          ) : null}

          {!isRunning ? (
            <Button variant="ghost" size="sm" onClick={onRemove}>
              Entfernen
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  )
}
