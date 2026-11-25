import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTheme } from './hooks/useTheme'
import { connectLiveEvents, setStoredToken, useAppStore } from './state/appStore'
import { Footer, Header } from './components/AppShell'
import { WebsiteView } from './components/WebsiteView'
import { OverviewPanel } from './components/panels/OverviewPanel'
import { WatchlistPanel } from './components/panels/WatchlistPanel'
import { QueuePanel } from './components/panels/QueuePanel'
import { StorageArchivePanel } from './components/panels/StorageArchivePanel'
import { LogsPanel } from './components/panels/LogsPanel'
import { SettingsPanel } from './components/panels/SettingsPanel'
import { Button, Card, Field, Notice, TextInput } from './components/ui/primitives'

function ShutdownBanner() {
  const shutdownState = useAppStore((s) => s.shutdownState)
  const cancelPendingShutdown = useAppStore((s) => s.cancelPendingShutdown)
  const [now, setNow] = useState(() => Date.now())

  const active = Boolean(shutdownState?.countdownEndsAt || shutdownState?.waitingForDownloads)

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])

  if (!active || !shutdownState) return null

  const label =
    shutdownState.action === 'sleep'
      ? 'Energiesparmodus'
      : shutdownState.action === 'hibernate'
        ? 'Ruhezustand'
        : 'Herunterfahren'

  const secLeft = shutdownState.countdownEndsAt
    ? Math.max(0, Math.ceil((shutdownState.countdownEndsAt - now) / 1000))
    : null

  return (
    <div className="mb-[20px]">
      <Notice
        tone="warn"
        title={
          shutdownState.waitingForDownloads
            ? `Geplantes ${label} wartet auf laufende Downloads`
            : `${label} in ${secLeft} Sekunden`
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-[12px]">
          <p>
            {shutdownState.waitingForDownloads
              ? 'Sobald alle laufenden Downloads und Uploads fertig sind, startet ein 60-Sekunden-Countdown.'
              : 'Klicke auf Abbrechen, damit der Rechner eingeschaltet bleibt.'}
          </p>
          <Button size="sm" variant="quiet" onClick={() => void cancelPendingShutdown()}>
            {label} abbrechen
          </Button>
        </div>
      </Notice>
    </div>
  )
}

export function App() {
  const { choice, setChoice } = useTheme()
  const surfaceMode = useAppStore((s) => s.surfaceMode)
  const panel = useAppStore((s) => s.panel)
  const enterDirection = useAppStore((s) => s.enterDirection)
  const ready = useAppStore((s) => s.ready)
  const authRequired = useAppStore((s) => s.authRequired)
  const errorBanner = useAppStore((s) => s.errorBanner)
  const bootstrap = useAppStore((s) => s.bootstrap)

  const [tokenInput, setTokenInput] = useState('')

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    if (surfaceMode !== 'app' || !ready) return
    return connectLiveEvents()
  }, [surfaceMode, ready])

  const submitAccessToken = (e: React.FormEvent) => {
    e.preventDefault()
    setStoredToken(tokenInput.trim())
    void bootstrap()
  }

  if (surfaceMode === 'website') {
    return <WebsiteView themeChoice={choice} onThemeChange={setChoice} />
  }

  if (surfaceMode === 'loading') {
    return <div className="min-h-screen bg-canvas" />
  }

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-prose">
      <Header themeChoice={choice} onThemeChange={setChoice} />

      <main className="shell flex-1 pt-[24px] sm:pt-[32px]">
        <ShutdownBanner />
        {authRequired ? (
          <Card tone="mint" className="mx-auto max-w-[460px] p-[24px]">
            <form onSubmit={submitAccessToken} className="flex flex-col gap-[14px]">
              <h2 className="display-sm">Server-Zugangsschlüssel</h2>
              <Field
                label="Zugangsschlüssel eingeben"
                hint="Dieser Sondra-AD-Server ist für den Netzwerkzugriff geschützt."
              >
                <TextInput
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  autoFocus
                />
              </Field>
              <Button type="submit" size="sm">
                Verbinden
              </Button>
            </form>
          </Card>
        ) : !ready && errorBanner ? (
          <Notice tone="error" title="Verbindung zum lokalen Sondra-AD-Dienst fehlgeschlagen">
            <p>{errorBanner}</p>
            <div className="mt-[12px]">
              <Button size="sm" variant="quiet" onClick={() => void bootstrap()}>
                Erneut versuchen
              </Button>
            </div>
          </Notice>
        ) : (
          <div
            key={panel}
            style={{ '--enter-x': `${enterDirection}px` } as CSSProperties}
            className="panel-root rise"
          >
            {panel === 'uebersicht' ? <OverviewPanel /> : null}
            {panel === 'merkliste' ? <WatchlistPanel /> : null}
            {panel === 'warteschlange' ? <QueuePanel /> : null}
            {panel === 'speicher' ? <StorageArchivePanel /> : null}
            {panel === 'protokoll' ? <LogsPanel /> : null}
            {panel === 'einstellungen' ? <SettingsPanel /> : null}
          </div>
        )}
      </main>

      <Footer />
    </div>
  )
}
