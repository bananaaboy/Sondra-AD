import { useEffect, useState } from 'react'
import { apiCall, useAppStore } from '../../state/appStore'
import { createQrMatrix } from '../../lib/qrSvg'
import type {
  AniworldLanguagePref,
  AudioFilePref,
  AudioOutputFormat,
  BacklogMode,
  DriveStatusInfo,
  SavedLinkStatus,
  StorageTarget,
  ToolsStatusInfo,
  VideoFilePref,
} from '../../types'
import { Button, Card, Dialog, Field, Notice, Reveal, SectionHead, Select, TextInput, Toggle } from '../ui/primitives'

type SettingsSection = 'verbindung' | 'downloads' | 'betrieb' | 'erweitert'

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'verbindung', label: 'Verbindung' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'betrieb', label: 'Betrieb' },
  { id: 'erweitert', label: 'Erweitert' },
]

export function SettingsPanel() {
  const config = useAppStore((s) => s.config)
  const drive = useAppStore((s) => s.drive)
  const tools = useAppStore((s) => s.tools)
  const runtimeMode = useAppStore((s) => s.runtimeMode)

  const updateConfig = useAppStore((s) => s.updateConfig)
  const bootstrap = useAppStore((s) => s.bootstrap)

  const [section, setSection] = useState<SettingsSection>('verbindung')
  const [authDialog, setAuthDialog] = useState<{ authUrl: string; redirectUri: string; mode: string } | null>(null)
  const [callbackInput, setCallbackInput] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [infoMsg, setInfoMsg] = useState<string | null>(null)

  const [customSondraDir, setCustomSondraDir] = useState('')
  const [pairPin, setPairPin] = useState('')
  const [exportedBundle, setExportedBundle] = useState('')
  const [importBundleText, setImportBundleText] = useState('')
  const [cookiesText, setCookiesText] = useState('')

  useEffect(() => {
    if (drive?.connected && authDialog) {
      setAuthDialog(null)
      setInfoMsg('Google Drive erfolgreich verbunden und mit Sondra synchronisiert.')
    }
  }, [drive?.connected, authDialog])

  useEffect(() => {
    if (!('BroadcastChannel' in window)) return undefined
    const channel = new BroadcastChannel('sondra-ad-drive')
    channel.onmessage = () => {
      setAuthDialog(null)
      void bootstrap()
    }
    return () => channel.close()
  }, [bootstrap])

  if (!config) return null

  const startGoogleSignIn = async (openInPopupOrSystem: boolean) => {
    setBusy('drive-start')
    setAuthError(null)
    setInfoMsg(null)
    try {
      const isDesktop = Boolean(window.sondraAd?.isDesktopApp)
      const res = await apiCall<{
        authUrl: string
        redirectUri: string
        mode: string
        drive: DriveStatusInfo
      }>('drive/start', {
        body: {
          origin: window.location.origin,
          openBrowser: isDesktop && openInPopupOrSystem,
        },
      })
      if (openInPopupOrSystem) {
        if (!isDesktop) {
          window.open(res.authUrl, 'sondra-ad-google', 'popup,width=540,height=700')
        }
        setInfoMsg('Anmeldung wurde im Browser geöffnet. Bitte dort bei Google bestätigen — Sondra AD verbindet sich danach automatisch.')
      } else {
        setAuthDialog({ authUrl: res.authUrl, redirectUri: res.redirectUri, mode: res.mode })
      }
    } catch (err) {
      setInfoMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const finishManualCallback = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!callbackInput.trim()) return
    setBusy('drive-callback')
    setAuthError(null)
    try {
      await apiCall('drive/callback', { body: { input: callbackInput.trim() } })
      setCallbackInput('')
      setAuthDialog(null)
      await bootstrap()
      setInfoMsg('Google Drive erfolgreich verbunden und mit Sondra synchronisiert.')
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleDisconnectDrive = async () => {
    setBusy('drive-disconnect')
    try {
      await apiCall('drive/disconnect', { body: {} })
      await bootstrap()
    } finally {
      setBusy(null)
    }
  }

  const handleImportLocalSondra = async () => {
    setBusy('sondra-import')
    setInfoMsg(null)
    try {
      const res = await apiCall<{
        imported: { dataDir: string; driveTokenImported: boolean; settingsImported: boolean; merklisteImported?: boolean }
      }>('sondra/import', { body: { customDir: customSondraDir.trim() } })
      await bootstrap()
      const parts = [`Verbunden mit ${res.imported.dataDir}`]
      if (res.imported.driveTokenImported) parts.push('Google-Drive-Anmeldung übernommen')
      if (res.imported.settingsImported) parts.push('Einstellungen & Cookies übernommen')
      if (res.imported.merklisteImported) parts.push('Merkliste zusammengeführt')
      setInfoMsg(parts.join(' · '))
    } catch (err) {
      setInfoMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleExportPairing = async () => {
    setBusy('pair-export')
    setInfoMsg(null)
    try {
      const res = await apiCall<{ bundle: string }>('pairing/export', { body: { passphrase: pairPin } })
      setExportedBundle(res.bundle)
    } catch (err) {
      setInfoMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleImportPairing = async () => {
    setBusy('pair-import')
    setInfoMsg(null)
    try {
      await apiCall('pairing/import', { body: { bundle: importBundleText, passphrase: pairPin } })
      setImportBundleText('')
      await bootstrap()
      setInfoMsg('Kopplungspaket erfolgreich übernommen.')
    } catch (err) {
      setInfoMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleUploadCookies = async () => {
    setBusy('cookies')
    try {
      await apiCall('cookies/upload', { body: { content: cookiesText } })
      setCookiesText('')
      await bootstrap()
      setInfoMsg('cookies.txt wurde hinterlegt.')
    } catch (err) {
      setInfoMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleInstallYtdlp = async () => {
    setBusy('ytdlp')
    setInfoMsg(null)
    try {
      const res = await apiCall<{ tools: ToolsStatusInfo }>('tools/install-ytdlp', { body: {} })
      useAppStore.setState({ tools: res.tools })
      setInfoMsg(`yt-dlp ${res.tools.ytdlpVersion || ''} ist einsatzbereit.`)
    } catch (err) {
      setInfoMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const pickDirectory = async (field: 'localDir' | 'localArchiveDir', title: string) => {
    if (!window.sondraAd?.pickFolder) return
    const picked = await window.sondraAd.pickFolder(title)
    if (picked) {
      await updateConfig({ [field]: picked })
    }
  }

  const toggleWatchStatus = (st: SavedLinkStatus) => {
    const set = new Set(config.watchStatuses || ['watching'])
    if (set.has(st)) {
      if (set.size > 1) set.delete(st)
    } else {
      set.add(st)
    }
    void updateConfig({ watchStatuses: [...set] })
  }

  const moveHoster = (index: number, delta: number) => {
    const list = [...(config.hosterPriority || [])]
    const target = index + delta
    if (target < 0 || target >= list.length) return
    const [item] = list.splice(index, 1)
    list.splice(target, 0, item)
    void updateConfig({ hosterPriority: list })
  }

  const qrMatrix = authDialog ? createQrMatrix(authDialog.authUrl) : null

  return (
    <div className="flex flex-col gap-[24px]">
      <div className="flex flex-col justify-between gap-[14px] sm:flex-row sm:items-end">
        <div className="flex flex-col gap-[4px]">
          <h2 className="display-md">Einstellungen</h2>
          <p className="text-small text-muted">
            Übersichtlich nach Bereich gegliedert — Änderungen werden sofort gespeichert.
          </p>
        </div>

        <div role="tablist" aria-label="Einstellungsbereiche" className="flex flex-wrap gap-[6px]">
          {SECTIONS.map((entry) => {
            const active = section === entry.id
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                data-settings-tab={entry.id}
                aria-selected={active}
                onClick={() => setSection(entry.id)}
                className={`press rounded-pill px-[14px] py-[7px] text-small font-medium ${
                  active ? 'bg-ink font-semibold text-on-ink' : 'bg-panel-soft text-prose hover:text-ink'
                }`}
              >
                {entry.label}
              </button>
            )
          })}
        </div>
      </div>

      {infoMsg ? <Notice tone="info">{infoMsg}</Notice> : null}

      {section === 'verbindung' ? (
        <section className="flex flex-col gap-[20px] border-t-2 border-rule pt-[20px]">
          <div className="grid grid-cols-1 gap-[16px] lg:grid-cols-2">
            <Card tone="mint" className="flex flex-col justify-between gap-[14px] p-[20px]">
              <div className="flex flex-col gap-[6px]">
                <p className="text-body font-semibold text-ink">
                  {drive?.connected ? 'Google Drive verbunden' : 'Google Drive'}
                </p>
                <p className="text-small text-prose">
                  {drive?.connected
                    ? `${drive.account?.email || 'Konto aktiv'} · teilt sich Ordner Sondra (${drive.lasting ? 'dauerhaft' : 'Sitzung'}).`
                    : drive?.configured
                      ? 'Zugriff ausschließlich auf den Ordner Sondra (drive.file) für Merkliste, Serien und Geräte.'
                      : 'Bitte unten Client-ID und Client-Secret (Desktop-App) eintragen, um Google Drive zu verbinden.'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-[8px]">
                <Button size="sm" disabled={busy !== null || !drive?.configured} onClick={() => void startGoogleSignIn(true)}>
                  {drive?.connected ? 'Neu verbinden' : 'Anmelden'}
                </Button>
                <Button variant="quiet" size="sm" disabled={busy !== null || !drive?.configured} onClick={() => void startGoogleSignIn(false)}>
                  QR-Code / Link
                </Button>
                {drive?.connected ? (
                  <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void handleDisconnectDrive()}>
                    Trennen
                  </Button>
                ) : null}
              </div>
            </Card>

            <Card tone="mint" className="flex flex-col justify-between gap-[14px] p-[20px]">
              <div className="flex flex-col gap-[6px]">
                <p className="text-body font-semibold text-ink">Lokale Sondra-App übernehmen</p>
                <p className="text-small text-prose">
                  {drive?.localSondra?.found
                    ? `Gefunden unter ${drive.localSondra.dataDir}. Übernimmt Anmeldung, Cookies und Merkliste mit einem Klick.`
                    : 'Liest Einstellungen und Merkliste direkt aus einer installierten Sondra-App auf diesem Rechner ein.'}
                </p>
                {!drive?.localSondra?.found ? (
                  <TextInput
                    placeholder="Optionaler Pfad zum Sondra-Ordner …"
                    value={customSondraDir}
                    onChange={(e) => setCustomSondraDir(e.target.value)}
                  />
                ) : null}
              </div>
              <div>
                <Button
                  variant="quiet"
                  size="sm"
                  disabled={busy !== null || (!drive?.localSondra?.found && !customSondraDir.trim())}
                  onClick={() => void handleImportLocalSondra()}
                >
                  {busy === 'sondra-import' ? 'Übernimmt …' : 'Aus Sondra übernehmen'}
                </Button>
              </div>
            </Card>
          </div>

          <Reveal label="Kopplungspaket für einen zweiten Rechner oder Server">
            <div className="grid grid-cols-1 gap-[16px] pt-[10px] lg:grid-cols-2">
              <div className="flex flex-col gap-[10px]">
                <Field label="Passwort (mind. 4 Zeichen)" hint="Verschlüsselt Anmeldung und Cookies mit AES-256.">
                  <TextInput
                    type="password"
                    placeholder="Kopplungscode"
                    value={pairPin}
                    onChange={(e) => setPairPin(e.target.value)}
                  />
                </Field>
                <div>
                  <Button variant="quiet" size="sm" disabled={pairPin.length < 4 || busy !== null} onClick={() => void handleExportPairing()}>
                    Paket erzeugen
                  </Button>
                </div>
                {exportedBundle ? (
                  <TextInput readOnly value={exportedBundle} onFocus={(e) => e.currentTarget.select()} />
                ) : null}
              </div>

              <div className="flex flex-col gap-[10px]">
                <Field label="Paket einspielen" hint="Passwort links eingeben und Pakettext hier einfügen.">
                  <TextInput
                    placeholder="SONDRA-AD-PAIR-1.…"
                    value={importBundleText}
                    onChange={(e) => setImportBundleText(e.target.value)}
                  />
                </Field>
                <div>
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={!importBundleText.trim() || pairPin.length < 4 || busy !== null}
                    onClick={() => void handleImportPairing()}
                  >
                    Importieren
                  </Button>
                </div>
              </div>
            </div>
          </Reveal>

          <Reveal
            defaultOpen={!drive?.configured}
            label="Eigene Google-OAuth-Client-Daten (Desktop-App)"
          >
            <div className="grid grid-cols-1 gap-[14px] pt-[10px] sm:grid-cols-2">
              <Field label="Client-ID (Desktop-App)">
                <TextInput
                  placeholder="…apps.googleusercontent.com"
                  value={config.googleClientId}
                  onChange={(e) => void updateConfig({ googleClientId: e.target.value })}
                />
              </Field>
              <Field label="Client-Secret">
                <TextInput
                  type="password"
                  placeholder="GOCSPX-…"
                  value={config.googleClientSecret}
                  onChange={(e) => void updateConfig({ googleClientSecret: e.target.value })}
                />
              </Field>
            </div>
          </Reveal>
        </section>
      ) : null}

      {section === 'downloads' ? (
        <section className="flex flex-col gap-[24px] border-t-2 border-rule pt-[20px]">
          <div className="grid grid-cols-1 gap-[16px] sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Bevorzugte Sprache">
              <Select
                value={config.language}
                onChange={(e) => void updateConfig({ language: e.target.value as AniworldLanguagePref })}
              >
                <option value="auto">Automatisch (Deutsch bevorzugt)</option>
                <option value="ger_sub">Deutsch Untertitel (Ger-Sub)</option>
                <option value="ger_dub">Deutsch Synchronisation (Ger-Dub)</option>
                <option value="eng_sub">Englisch Untertitel (Eng-Sub)</option>
              </Select>
            </Field>

            <Field label="Download-Modus">
              <Select
                value={config.mode}
                onChange={(e) => void updateConfig({ mode: e.target.value as 'video' | 'audio' })}
              >
                <option value="video">Video mit Ton</option>
                <option value="audio">Nur Tonspur</option>
              </Select>
            </Field>

            <Field label="Videoqualität">
              <Select
                value={config.videoPref}
                onChange={(e) => void updateConfig({ videoPref: e.target.value as VideoFilePref })}
              >
                <option value="best">Beste verfügbare</option>
                <option value="untouched">Original unverändert</option>
                <option value="1080p">1080p (Full HD)</option>
                <option value="720p">720p (HD)</option>
                <option value="480p">480p (Standard)</option>
                <option value="360p">360p (Kompakt)</option>
              </Select>
            </Field>

            <Field label="Tonqualität">
              <Select
                value={config.audioPref}
                onChange={(e) => void updateConfig({ audioPref: e.target.value as AudioFilePref })}
              >
                <option value="untouched">Original</option>
                <option value="high">Hoch (Standard)</option>
                <option value="lossless">Verlustfrei</option>
                <option value="medium">Mittel</option>
                <option value="low">Kompakt</option>
              </Select>
            </Field>

            <Field label="Tonformat (bei Nur Ton)">
              <Select
                value={config.audioFormat}
                onChange={(e) => void updateConfig({ audioFormat: e.target.value as AudioOutputFormat })}
              >
                <option value="original">Original</option>
                <option value="mp3">MP3</option>
                <option value="m4a">M4A (AAC)</option>
                <option value="flac">FLAC</option>
                <option value="opus">OPUS</option>
                <option value="wav">WAV</option>
              </Select>
            </Field>

            <Field label="Speicherziel">
              <Select
                value={config.storageTarget}
                onChange={(e) => void updateConfig({ storageTarget: e.target.value as StorageTarget })}
              >
                <option value="drive_only">Nur Google Drive (Temp sofort löschen)</option>
                <option value="drive_and_local">Google Drive + lokale Kopie</option>
                <option value="local_only">Nur lokal speichern</option>
              </Select>
            </Field>
          </div>

          <Toggle
            label="Auf Wunschsprache warten"
            hint="Wartet bei neuen Folgen automatisch, bis die gewählte Sprache verfügbar ist."
            checked={config.waitForPreferredLanguage}
            onChange={(val) => void updateConfig({ waitForPreferredLanguage: val })}
          />

          <div className="grid grid-cols-1 gap-[20px] border-t border-line pt-[18px] sm:grid-cols-2">
            <div className="flex flex-col gap-[8px]">
              <SectionHead rule={false}>Überwachte Merklisten-Status</SectionHead>
              <Toggle
                label="Am Schauen"
                checked={config.watchStatuses.includes('watching')}
                onChange={() => toggleWatchStatus('watching')}
              />
              <Toggle
                label="Später (Geplant)"
                checked={config.watchStatuses.includes('later')}
                onChange={() => toggleWatchStatus('later')}
              />
              <Toggle
                label="Fertig (bei neuer Staffel automatisch aufwecken)"
                checked={config.watchStatuses.includes('done')}
                onChange={() => toggleWatchStatus('done')}
              />
              <Toggle
                label="Pausiert"
                checked={config.watchStatuses.includes('paused')}
                onChange={() => toggleWatchStatus('paused')}
              />
            </div>

            <div className="flex flex-col gap-[14px]">
              <Field label="Standard-Nachlademodus">
                <Select
                  value={config.backlogMode}
                  onChange={(e) => void updateConfig({ backlogMode: e.target.value as BacklogMode })}
                >
                  <option value="from_current">Ungesehene ab aktuellem Stand + neue Releases</option>
                  <option value="new_only">Nur ab jetzt neu erscheinende Folgen</option>
                  <option value="all_unwatched">Alle ungesehenen Folgen</option>
                </Select>
              </Field>

              <Field
                label="Vorrats-Limit pro Serie (0 = unbegrenzt)"
                hint="Einzelne Staffeln lassen sich zusätzlich unter Merkliste → Regeln fein einstellen."
              >
                <TextInput
                  type="number"
                  min={0}
                  value={config.lookaheadLimit}
                  onChange={(e) => void updateConfig({ lookaheadLimit: Math.max(0, Number(e.target.value) || 0) })}
                />
              </Field>
            </div>
          </div>

          {config.storageTarget !== 'drive_only' ? (
            <div className="grid grid-cols-1 gap-[16px] border-t border-line pt-[18px] sm:grid-cols-2">
              <Field label="Lokaler Zielordner">
                <div className="flex gap-[8px]">
                  <TextInput
                    value={config.localDir}
                    onChange={(e) => void updateConfig({ localDir: e.target.value })}
                  />
                  {window.sondraAd?.pickFolder ? (
                    <Button variant="quiet" size="sm" onClick={() => void pickDirectory('localDir', 'Zielordner wählen')}>
                      Wählen
                    </Button>
                  ) : null}
                </div>
              </Field>

              <Field label="Lokaler Archiv-Ordner">
                <div className="flex gap-[8px]">
                  <TextInput
                    value={config.localArchiveDir}
                    onChange={(e) => void updateConfig({ localArchiveDir: e.target.value })}
                  />
                  {window.sondraAd?.pickFolder ? (
                    <Button variant="quiet" size="sm" onClick={() => void pickDirectory('localArchiveDir', 'Archiv-Ordner wählen')}>
                      Wählen
                    </Button>
                  ) : null}
                </div>
              </Field>
            </div>
          ) : null}
        </section>
      ) : null}

      {section === 'betrieb' ? (
        <section className="flex flex-col gap-[24px] border-t-2 border-rule pt-[20px]">
          <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
            <Toggle
              label="Mit Windows automatisch starten"
              hint="Startet lautlos im System-Tray."
              checked={config.autostartWindows}
              onChange={(val) => void updateConfig({ autostartWindows: val })}
            />
            {runtimeMode === 'desktop' ? (
              <Toggle
                label="Beim Schließen im System-Tray weiterlaufen"
                checked={config.closeToTray}
                onChange={(val) => void updateConfig({ closeToTray: val })}
              />
            ) : null}
            <Toggle
              label="Standby / Ruhezustand verhindern (24/7)"
              checked={config.preventSuspend}
              onChange={(val) => void updateConfig({ preventSuspend: val })}
            />
            <Toggle
              label="In Sondra unter „Geräte“ anzeigen"
              checked={config.registerInSondraDevices}
              onChange={(val) => void updateConfig({ registerInSondraDevices: val })}
            />
          </div>

          <div className="grid grid-cols-1 gap-[16px] border-t border-line pt-[18px] sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Prüfintervall">
              <Select
                value={String(config.checkIntervalMinutes)}
                onChange={(e) => void updateConfig({ checkIntervalMinutes: Number(e.target.value) })}
              >
                <option value="10">Alle 10 Min.</option>
                <option value="15">Alle 15 Min.</option>
                <option value="30">Alle 30 Min.</option>
                <option value="60">Stündlich</option>
                <option value="180">Alle 3 Std.</option>
                <option value="360">Alle 6 Std.</option>
              </Select>
            </Field>

            <Field label="Merklisten-Sync">
              <Select
                value={String(config.merkSyncIntervalMinutes)}
                onChange={(e) => void updateConfig({ merkSyncIntervalMinutes: Number(e.target.value) })}
              >
                <option value="2">Alle 2 Min.</option>
                <option value="5">Alle 5 Min.</option>
                <option value="15">Alle 15 Min.</option>
                <option value="30">Alle 30 Min.</option>
              </Select>
            </Field>

            <Field label="Gleichzeitige Downloads">
              <Select
                value={String(config.concurrency)}
                onChange={(e) => void updateConfig({ concurrency: Number(e.target.value) })}
              >
                <option value="1">1 (schonend)</option>
                <option value="2">2 gleichzeitig</option>
                <option value="3">3 gleichzeitig</option>
                <option value="4">4 gleichzeitig</option>
              </Select>
            </Field>

            <Field label="Bandbreite (KB/s, 0 = frei)">
              <TextInput
                type="number"
                min={0}
                step={500}
                value={config.maxBandwidthKbps}
                onChange={(e) => void updateConfig({ maxBandwidthKbps: Math.max(0, Number(e.target.value) || 0) })}
              />
            </Field>
          </div>

          <div className="flex flex-col gap-[14px] border-t border-line pt-[18px]">
            <SectionHead rule={false}>Benachrichtigungen</SectionHead>
            <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-3">
              <Toggle
                label="Windows-Meldungen"
                checked={config.desktopNotifications}
                onChange={(val) => void updateConfig({ desktopNotifications: val })}
              />
              <Toggle
                label="Bei fertigen Folgen"
                checked={config.notifyOnComplete}
                onChange={(val) => void updateConfig({ notifyOnComplete: val })}
              />
              <Toggle
                label="Bei Fehlern warnen"
                checked={config.notifyOnFailure}
                onChange={(val) => void updateConfig({ notifyOnFailure: val })}
              />
            </div>

            <Field label="Discord-Webhook (optional)">
              <TextInput
                placeholder="https://discord.com/api/webhooks/…"
                value={config.discordWebhookUrl}
                onChange={(e) => void updateConfig({ discordWebhookUrl: e.target.value })}
              />
            </Field>
          </div>
        </section>
      ) : null}

      {section === 'erweitert' ? (
        <section className="flex flex-col gap-[24px] border-t-2 border-rule pt-[20px]">
          <div className="flex flex-col gap-[8px]">
            <SectionHead rule={false}>Hoster-Reihenfolge (automatischer Fallback)</SectionHead>
            <div className="flex flex-wrap gap-[8px]">
              {(config.hosterPriority || []).map((hoster, idx) => (
                <div
                  key={hoster}
                  className="flex items-center gap-[6px] rounded-nav bg-panel-soft px-[10px] py-[6px] text-small text-ink"
                >
                  <span className="value text-micro text-muted">{idx + 1}.</span>
                  <span className="font-medium uppercase">{hoster}</span>
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => moveHoster(idx, -1)}
                    className="press px-[4px] text-muted hover:text-ink disabled:opacity-30"
                    title="Nach vorn"
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    disabled={idx === config.hosterPriority.length - 1}
                    onClick={() => moveHoster(idx, 1)}
                    className="press px-[4px] text-muted hover:text-ink disabled:opacity-30"
                    title="Nach hinten"
                  >
                    →
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-[16px] border-t border-line pt-[18px] sm:grid-cols-3">
            <Field label="Max. Wiederholungsversuche">
              <Select
                value={String(config.maxRetries)}
                onChange={(e) => void updateConfig({ maxRetries: Number(e.target.value) })}
              >
                <option value="3">3 Versuche</option>
                <option value="6">6 Versuche (Standard)</option>
                <option value="10">10 Versuche</option>
                <option value="-1">Unbegrenzt</option>
                <option value="0">Aus</option>
              </Select>
            </Field>

            <Field label="Erste Wartezeit (Minuten)">
              <TextInput
                type="number"
                min={1}
                max={120}
                value={config.retryBaseMinutes}
                onChange={(e) => void updateConfig({ retryBaseMinutes: Math.max(1, Number(e.target.value) || 5) })}
              />
            </Field>

            <Field label="Browser-Cookies (yt-dlp)">
              <Select
                value={config.browserCookies}
                onChange={(e) => void updateConfig({ browserCookies: e.target.value })}
              >
                <option value="">Keine</option>
                <option value="firefox">Firefox</option>
                <option value="edge">Microsoft Edge</option>
                <option value="chrome">Google Chrome</option>
                <option value="brave">Brave</option>
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
            <Toggle
              label="Bei Internet-Rückkehr sofort wiederholen"
              checked={config.autoRetryOnNetworkRestore}
              onChange={(val) => void updateConfig({ autoRetryOnNetworkRestore: val })}
            />
            <Toggle
              label="Hardware-Beschleunigung für FFmpeg (NVENC / AMF / QuickSync)"
              hint={tools?.gpuEncoder ? `Erkannt: ${tools.gpuEncoder}` : undefined}
              checked={config.useGpuEncoding}
              onChange={(val) => void updateConfig({ useGpuEncoding: val })}
            />
          </div>

          <div className="grid grid-cols-1 gap-[16px] border-t border-line pt-[18px] sm:grid-cols-3">
            <Field label="Netzwerkadapter">
              <Select
                value={config.bindAddress}
                onChange={(e) => void updateConfig({ bindAddress: e.target.value })}
              >
                {(tools?.adapters || [{ id: 'default', name: 'Automatisch' }]).map((ad) => (
                  <option key={ad.id} value={ad.id}>
                    {ad.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Gerätename in Sondra">
              <TextInput
                value={config.deviceName}
                onChange={(e) => void updateConfig({ deviceName: e.target.value })}
              />
            </Field>

            <Field label="Server-Zugangsschlüssel">
              <TextInput
                type="password"
                placeholder="Leer = lokal ohne Passwort"
                value={config.remoteAccessToken}
                onChange={(e) => void updateConfig({ remoteAccessToken: e.target.value })}
              />
            </Field>
          </div>

          <Reveal label="cookies.txt für kopflose Server hinterlegen">
            <div className="flex flex-col gap-[10px] pt-[8px]">
              <p className="text-small text-muted">
                {config.cookiesFile ? `Aktiv: ${config.cookiesFile}` : 'Noch keine cookies.txt gespeichert.'}
              </p>
              <textarea
                rows={4}
                placeholder="# Netscape HTTP Cookie File …"
                value={cookiesText}
                onChange={(e) => setCookiesText(e.target.value)}
                className="value w-full rounded-nav bg-raised p-[12px] text-small text-prose outline-none ring-1 ring-inset ring-rule focus:ring-ink"
              />
              <div>
                <Button variant="quiet" size="sm" disabled={busy !== null} onClick={() => void handleUploadCookies()}>
                  Cookies speichern
                </Button>
              </div>
            </div>
          </Reveal>

          <div className="flex flex-wrap items-center justify-between gap-[12px] border-t border-line pt-[14px]">
            <div className="flex flex-col">
              <span className="text-small font-semibold text-ink">Werkzeuge</span>
              <span className="value text-micro text-muted">
                yt-dlp: {tools?.ytdlpAvailable ? tools.ytdlpVersion || 'bereit' : 'nicht geladen'} · FFmpeg:{' '}
                {tools?.ffmpegAvailable ? tools.ffmpegPath : 'Nativ HLS'}
              </span>
            </div>
            <Button variant="quiet" size="sm" disabled={busy !== null} onClick={() => void handleInstallYtdlp()}>
              {busy === 'ytdlp' ? 'Lädt …' : tools?.ytdlpAvailable ? 'yt-dlp prüfen' : 'yt-dlp laden'}
            </Button>
          </div>
        </section>
      ) : null}

      <Dialog
        open={authDialog !== null}
        onClose={() => setAuthDialog(null)}
        title="Mit Google Drive verbinden (QR-Code / Server)"
        size="md"
      >
        {authDialog ? (
          <div className="flex flex-col gap-[18px]">
            <div className="grid grid-cols-1 items-center gap-[20px] sm:grid-cols-[160px_1fr]">
              {qrMatrix ? (
                <div className="mx-auto rounded-card bg-raised p-[12px] ring-1 ring-line">
                  <svg
                    viewBox={`0 0 ${qrMatrix.size} ${qrMatrix.size}`}
                    className="h-[136px] w-[136px] text-ink"
                    shapeRendering="crispEdges"
                  >
                    {qrMatrix.cells.map((row, r) =>
                      row.map((dark, c) =>
                        dark ? <rect key={`${r}-${c}`} x={c} y={r} width={1} height={1} fill="currentColor" /> : null,
                      ),
                    )}
                  </svg>
                </div>
              ) : null}

              <div className="flex flex-col gap-[8px]">
                <p className="text-small text-prose">
                  Auf demselben PC einfach <strong>„Im Browser öffnen“</strong> klicken — dann klappt die Rückmeldung automatisch.
                </p>
                <p className="text-micro text-muted">
                  Auf einem Handy oder zweiten Gerät: QR-Code scannen und bei Google zulassen. Danach zeigt das Handy kurz eine „127.0.0.1 nicht erreichbar“-Seite (das ist bei Google-Desktop-Anmeldungen normal). Kopiere diese komplette Adresse aus der Handy-Adresszeile und füge sie unten ein.
                </p>
                <TextInput readOnly value={authDialog.authUrl} onFocus={(e) => e.currentTarget.select()} />
                <div>
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => window.open(authDialog.authUrl, '_blank', 'noopener')}
                  >
                    Im Browser auf diesem PC öffnen
                  </Button>
                </div>
              </div>
            </div>

            <form onSubmit={(e) => void finishManualCallback(e)} className="flex flex-col gap-[10px] border-t border-line pt-[14px]">
              <SectionHead rule={false}>Rückgabe-Adresse vom Handy / zweiten Gerät einfügen</SectionHead>
              <div className="flex flex-col gap-[8px] sm:flex-row">
                <TextInput
                  placeholder="http://127.0.0.1:…/?state=…&code=…"
                  value={callbackInput}
                  onChange={(e) => setCallbackInput(e.target.value)}
                  className="flex-1"
                />
                <Button type="submit" size="sm" disabled={!callbackInput.trim() || busy === 'drive-callback'}>
                  Übernehmen
                </Button>
              </div>
              {authError ? <p className="text-small text-ink">! {authError}</p> : null}
            </form>
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}
