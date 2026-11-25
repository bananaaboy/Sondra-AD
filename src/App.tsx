import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTheme } from './hooks/useTheme'
import { connectLiveEvents, setStoredToken, useAppStore } from './state/appStore'
import { Footer, Header } from './components/AppShell'
import { OverviewPanel } from './components/panels/OverviewPanel'
import { WatchlistPanel } from './components/panels/WatchlistPanel'
import { QueuePanel } from './components/panels/QueuePanel'
import { StorageArchivePanel } from './components/panels/StorageArchivePanel'
import { LogsPanel } from './components/panels/LogsPanel'
import { SettingsPanel } from './components/panels/SettingsPanel'
import { Button, Card, Field, Notice, TextInput } from './components/ui/primitives'

export function App() {
  const { choice, setChoice } = useTheme()
  const panel = useAppStore((s) => s.panel)
  const enterDirection = useAppStore((s) => s.enterDirection)
  const ready = useAppStore((s) => s.ready)
  const authRequired = useAppStore((s) => s.authRequired)
  const errorBanner = useAppStore((s) => s.errorBanner)
  const bootstrap = useAppStore((s) => s.bootstrap)

  const [tokenInput, setTokenInput] = useState('')

  useEffect(() => {
    void bootstrap()
    return connectLiveEvents()
  }, [bootstrap])

  const submitAccessToken = (e: React.FormEvent) => {
    e.preventDefault()
    setStoredToken(tokenInput.trim())
    void bootstrap()
  }

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-prose">
      <Header themeChoice={choice} onThemeChange={setChoice} />

      <main className="shell flex-1 pt-[24px] sm:pt-[32px]">
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
