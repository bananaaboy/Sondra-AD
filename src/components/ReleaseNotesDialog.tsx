import { useEffect, useState } from 'react'
import { APP_VERSION, RELEASE_NOTES } from '../lib/releaseNotes'
import { RELEASES_URL } from '../lib/downloads'
import type { AppUpdateState } from '../types'
import { Button, Dialog, Progress } from './ui/primitives'

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((n) => Number(n) || 0)
  const pb = b.replace(/^v/i, '').split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

export function ReleaseNotesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [updateState, setUpdateState] = useState<AppUpdateState>({
    supported: Boolean(typeof window !== 'undefined' && window.sondraAd?.checkForUpdates),
    status: 'idle',
    currentVersion: APP_VERSION,
    availableVersion: null,
    progress: 0,
    error: null,
  })
  const [checkingFallback, setCheckingFallback] = useState(false)

  useEffect(() => {
    if (!open) return
    let unsub: (() => void) | undefined
    if (window.sondraAd?.getUpdateState) {
      void window.sondraAd.getUpdateState().then((st) => {
        if (st) setUpdateState(st)
      })
    }
    if (window.sondraAd?.onUpdateState) {
      unsub = window.sondraAd.onUpdateState((st) => setUpdateState(st))
    }
    return () => unsub?.()
  }, [open])

  const handleCheck = async () => {
    if (window.sondraAd?.checkForUpdates && updateState.supported) {
      const next = await window.sondraAd.checkForUpdates()
      if (next) setUpdateState(next)
      return
    }
    setCheckingFallback(true)
    setUpdateState((prev) => ({ ...prev, status: 'checking', error: null }))
    try {
      const res = await fetch('https://api.github.com/repos/bananaaboy/Sondra-AD/releases/latest', {
        headers: { Accept: 'application/vnd.github+json' },
      })
      if (!res.ok) throw new Error(`GitHub antwortete mit HTTP ${res.status}`)
      const data = (await res.json()) as { tag_name?: string }
      const latest = String(data.tag_name || '').replace(/^v/i, '')
      if (latest && compareSemver(latest, APP_VERSION) > 0) {
        setUpdateState((prev) => ({ ...prev, status: 'available', availableVersion: latest, error: null }))
      } else {
        setUpdateState((prev) => ({ ...prev, status: 'up_to_date', availableVersion: null, error: null }))
      }
    } catch (err) {
      setUpdateState((prev) => ({
        ...prev,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }))
    } finally {
      setCheckingFallback(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Änderungen & Updates · v${APP_VERSION}`} size="lg">
      <div className="flex flex-col gap-[20px]">
        <div className="flex flex-col gap-[10px] rounded-card bg-panel-soft p-[14px]">
          <div className="flex flex-wrap items-center justify-between gap-[10px]">
            <div className="flex flex-col gap-[2px]">
              <span className="text-small font-semibold text-ink">
                {updateState.status === 'downloaded'
                  ? `Update v${updateState.availableVersion} bereit zur Installation`
                  : updateState.status === 'downloading'
                    ? `Lade Update v${updateState.availableVersion || ''} (${Math.round(updateState.progress)} %)`
                    : updateState.status === 'available'
                      ? `Neue Version v${updateState.availableVersion} verfügbar`
                      : updateState.status === 'up_to_date'
                        ? `Sondra AD v${APP_VERSION} ist aktuell`
                        : updateState.status === 'checking'
                          ? 'Suche nach neuen Versionen …'
                          : updateState.status === 'error'
                            ? 'Update-Prüfung fehlgeschlagen'
                            : `Installierte Version: v${APP_VERSION}`}
              </span>
              {updateState.error ? <span className="text-micro text-muted">{updateState.error}</span> : null}
            </div>
            <div className="flex flex-wrap items-center gap-[8px]">
              {updateState.status === 'downloaded' && window.sondraAd?.installUpdate ? (
                <Button size="sm" onClick={() => void window.sondraAd?.installUpdate?.()}>
                  Neu starten & installieren
                </Button>
              ) : updateState.status === 'available' && !updateState.supported ? (
                <a
                  href={RELEASES_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="press inline-flex items-center rounded-pill bg-ink px-[14px] py-[7px] text-micro font-semibold text-on-ink"
                >
                  Release öffnen
                </a>
              ) : (
                <Button
                  variant="quiet"
                  size="sm"
                  disabled={updateState.status === 'checking' || updateState.status === 'downloading' || checkingFallback}
                  onClick={() => void handleCheck()}
                >
                  {updateState.status === 'checking' || checkingFallback ? 'Prüft …' : 'Nach Updates suchen'}
                </Button>
              )}
            </div>
          </div>
          {updateState.status === 'downloading' ? <Progress value={updateState.progress} /> : null}
        </div>

        <div className="flex max-h-[55vh] flex-col gap-[16px] overflow-y-auto pr-[4px]">
          {RELEASE_NOTES.map((entry) => (
            <div key={entry.version} className="flex flex-col gap-[6px] border-t border-line pt-[14px] first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-baseline justify-between gap-[8px]">
                <h4 className="text-body font-semibold text-ink">
                  v{entry.version} — {entry.title}
                </h4>
                <span className="value text-micro text-muted">{entry.date}</span>
              </div>
              <ul className="flex list-disc flex-col gap-[4px] pl-[18px] text-small text-prose">
                {entry.items.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  )
}
