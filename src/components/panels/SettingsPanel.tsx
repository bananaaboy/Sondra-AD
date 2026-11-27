import { useState } from 'react'
import { apiCall, useAppStore } from '../../state/appStore'
import type {
  AniworldLanguagePref,
  AudioFilePref,
  AudioOutputFormat,
  BacklogMode,
  DownloadWindowMode,
  DriveStatusInfo,
  LocalNamingScheme,
  SavedLinkStatus,
  ShutdownAction,
  StorageTarget,
  ToolsStatusInfo,
  VideoFilePref,
} from '../../types'
import { Button, Card, Dialog, Field, Notice, Reveal, SectionHead, Select, TextInput, Toggle } from '../ui/primitives'

type SettingsSection = 'verbindung' | 'downloads' | 'betrieb' | 'erweitert'
type PushServiceTab = 'discord' | 'telegram' | 'ntfy' | 'pushover'

const LANG_LABELS: Record<string, string> = {
  ger_dub: 'Ger-Dub',
  ger_sub: 'Ger-Sub',
  eng_sub: 'Eng-Sub',
}

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
  const shutdownState = useAppStore((s) => s.shutdownState)

  const updateConfig = useAppStore((s) => s.updateConfig)
  const bootstrap = useAppStore((s) => s.bootstrap)
  const testPushNotifications = useAppStore((s) => s.testPushNotifications)
  const testWebdav = useAppStore((s) => s.testWebdav)

  const [section, setSection] = useState<SettingsSection>('verbindung')
  const [pushTab, setPushTab] = useState<PushServiceTab>('discord')
  const [pairDialogMode, setPairDialogMode] = useState<'import' | 'export' | null>(null)
  const [pairError, setPairError] = useState<string | null>(null)
  const [copiedBundle, setCopiedBundle] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [infoMsg, setInfoMsg] = useState<string | null>(null)

  const [customSondraDir, setCustomSondraDir] = useState('')
  const [pairPin, setPairPin] = useState('')
  const [exportedBundle, setExportedBundle] = useState('')
  const [importBundleText, setImportBundleText] = useState('')
  const [cookiesText, setCookiesText] = useState('')

  if (!config) return null

  const moveLangPriority = (index: number, delta: -1 | 1) => {
    const list = [...(config.languagePriority?.length ? config.languagePriority : (['ger_dub', 'ger_sub', 'eng_sub'] as AniworldLanguagePref[]))]
    const target = index + delta
    if (target < 0 || target >= list.length) return
    const [item] = list.splice(index, 1)
    list.splice(target, 0, item)
    void updateConfig({ languagePriority: list })
  }

  const handleTestPush = async () => {
    setBusy('test-push')
    setInfoMsg(null)
    try {
      const results = await testPushNotifications()
      if (results.length === 0) {
        setInfoMsg('Kein Push-Dienst eingetragen. Bitte zuerst mindestens einen Dienst konfigurieren.')
      } else {
        const summary = results.map((r) => `${r.channel}: ${r.ok ? 'OK' : r.error || `HTTP ${r.status}`}`).join(' · ')
        setInfoMsg(`Test-Meldung gesendet (${summary}).`)
      }
    } catch (err) {
      setInfoMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleTestWebdav = async () => {
    setBusy('test-webdav')
    setInfoMsg(null)
    try {
      const res = await testWebdav()
      setInfoMsg(res.ok ? `WebDAV erreichbar (${res.url || config.webdavUrl}).` : 'WebDAV-Verbindung fehlgeschlagen.')
    } catch (err) {
      setInfoMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const startGoogleSignIn = async () => {
    setBusy('drive-start')
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
          openBrowser: isDesktop,
        },
      })
      if (!isDesktop) {
        window.open(res.authUrl, 'sondra-ad-google', 'popup,width=540,height=700')
      }
      setInfoMsg('Anmeldung wurde im Browser geöffnet. Bitte dort bei Google bestätigen — Sondra AD verbindet sich danach automatisch.')
    } catch (err) {
      setInfoMsg(err instanceof Error ? err.message : String(err))
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
    setPairError(null)
    setCopiedBundle(false)
    try {
      const res = await apiCall<{ bundle: string }>('pairing/export', { body: { passphrase: pairPin } })
      setExportedBundle(res.bundle)
    } catch (err) {
      setPairError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleCopyBundle = async () => {
    if (!exportedBundle) return
    try {
      await navigator.clipboard.writeText(exportedBundle)
      setCopiedBundle(true)
      setTimeout(() => setCopiedBundle(false), 2000)
    } catch {}
  }

  const handleImportPairing = async () => {
    setBusy('pair-import')
    setPairError(null)
    try {
      await apiCall('pairing/import', { body: { bundle: importBundleText, passphrase: pairPin } })
      setImportBundleText('')
      setPairPin('')
      setPairDialogMode(null)
      await bootstrap()
      setInfoMsg('Kopplungspaket erfolgreich übernommen — Google Drive ist verbunden.')
    } catch (err) {
      setPairError(err instanceof Error ? err.message : String(err))
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
                <Button size="sm" disabled={busy !== null || !drive?.configured} onClick={() => void startGoogleSignIn()}>
                  {drive?.connected ? 'Neu verbinden' : 'Im Browser anmelden'}
                </Button>
                <Button
                  variant="quiet"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => {
                    setPairError(null)
                    setExportedBundle('')
                    setPairDialogMode(drive?.connected ? 'export' : 'import')
                  }}
                >
                  Mit anderem Gerät koppeln
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
                <option value="drive_and_local">Google Drive + Lokal / NAS</option>
                <option value="local_only">Nur Lokal / NAS (SMB-Pfad möglich)</option>
                <option value="webdav_only">Nur WebDAV</option>
                <option value="drive_and_webdav">Google Drive + WebDAV</option>
              </Select>
            </Field>
          </div>

          <div className="flex flex-col gap-[12px] border-t border-line pt-[18px]">
            <SectionHead rule={false}>Sprach-Priorität & Auto-Upgrade</SectionHead>
            <div className="flex flex-wrap items-center gap-[8px]">
              {(config.languagePriority?.length
                ? config.languagePriority
                : (['ger_dub', 'ger_sub', 'eng_sub'] as AniworldLanguagePref[])
              ).map((lang, idx, arr) => (
                <div
                  key={lang}
                  className="flex items-center gap-[6px] rounded-nav bg-panel-soft px-[10px] py-[6px] text-small text-ink"
                >
                  <span className="value text-micro text-muted">{idx + 1}.</span>
                  <span className="font-medium">{LANG_LABELS[lang] || lang}</span>
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => moveLangPriority(idx, -1)}
                    className="press px-[4px] text-muted hover:text-ink disabled:opacity-30"
                    title="Höhere Priorität"
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    disabled={idx === arr.length - 1}
                    onClick={() => moveLangPriority(idx, 1)}
                    className="press px-[4px] text-muted hover:text-ink disabled:opacity-30"
                    title="Niedrigere Priorität"
                  >
                    →
                  </button>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-2">
              <Toggle
                label="Auf Wunschsprache warten"
                hint="Wartet bei neuen Folgen automatisch, bis die gewählte Sprache verfügbar ist."
                checked={config.waitForPreferredLanguage}
                onChange={(val) => void updateConfig({ waitForPreferredLanguage: val })}
              />
              <Toggle
                label="Auto-Upgrade auf bessere Sprache"
                hint="Lädt zunächst eine verfügbare Sprache und ersetzt die Datei später automatisch durch eine höher priorisierte."
                checked={Boolean(config.autoUpgradeLanguage)}
                onChange={(val) => void updateConfig({ autoUpgradeLanguage: val })}
              />
            </div>
          </div>

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
                hint="Einzelne Staffeln & Speicherbudgets lassen sich unter Merkliste → Regeln einstellen."
              >
                <TextInput
                  type="number"
                  min={0}
                  value={config.lookaheadLimit}
                  onChange={(e) => void updateConfig({ lookaheadLimit: Math.max(0, Number(e.target.value) || 0) })}
                />
              </Field>

              <Toggle
                label="Bei zu wenig freiem Speicher automatisch pausieren"
                hint={`Stoppt Downloads, wenn lokal weniger als ${config.minFreeLocalGb} GB frei sind.`}
                checked={Boolean(config.pauseOnLowSpace)}
                onChange={(val) => void updateConfig({ pauseOnLowSpace: val })}
              />
            </div>
          </div>

          {config.storageTarget === 'local_only' || config.storageTarget === 'drive_and_local' ? (
            <div className="grid grid-cols-1 gap-[16px] border-t border-line pt-[18px] sm:grid-cols-2">
              <Field label="Lokaler Ordner / NAS-Pfad (SMB)" hint="Auch Netzwerkpfade wie \\\\NAS\\Medien\\Anime sind möglich.">
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

              <Field label="Ordnerstruktur">
                <Select
                  value={config.localNamingScheme || 'sondra'}
                  onChange={(e) => void updateConfig({ localNamingScheme: e.target.value as LocalNamingScheme })}
                >
                  <option value="sondra">Sondra (Serie / Staffel 1 / …)</option>
                  <option value="jellyfin">Jellyfin & Plex (Serie / Season 01 / …)</option>
                </Select>
              </Field>

              <Field label="Lokaler Archiv-Ordner" className="sm:col-span-2">
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

          {config.storageTarget === 'webdav_only' || config.storageTarget === 'drive_and_webdav' ? (
            <div className="flex flex-col gap-[14px] border-t border-line pt-[18px]">
              <div className="flex flex-wrap items-center justify-between gap-[8px]">
                <SectionHead rule={false}>WebDAV-Ziel (NAS / Nextcloud)</SectionHead>
                <Button
                  variant="quiet"
                  size="sm"
                  disabled={busy !== null || !config.webdavUrl?.trim()}
                  onClick={() => void handleTestWebdav()}
                >
                  {busy === 'test-webdav' ? 'Prüft …' : 'Verbindung testen'}
                </Button>
              </div>
              <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
                <Field label="WebDAV-URL">
                  <TextInput
                    placeholder="https://nas.local/remote.php/dav/files/name"
                    value={config.webdavUrl || ''}
                    onChange={(e) => void updateConfig({ webdavUrl: e.target.value })}
                  />
                </Field>
                <Field label="Zielpfad">
                  <TextInput
                    placeholder="/Sondra"
                    value={config.webdavBasePath || '/Sondra'}
                    onChange={(e) => void updateConfig({ webdavBasePath: e.target.value })}
                  />
                </Field>
                <Field label="Benutzername">
                  <TextInput
                    value={config.webdavUsername || ''}
                    onChange={(e) => void updateConfig({ webdavUsername: e.target.value })}
                  />
                </Field>
                <Field label="Passwort / App-Passwort">
                  <TextInput
                    type="password"
                    value={config.webdavPassword || ''}
                    onChange={(e) => void updateConfig({ webdavPassword: e.target.value })}
                  />
                </Field>
              </div>
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
            <SectionHead rule={false}>Download-Zeitfenster / Nachtmodus</SectionHead>
            <Toggle
              label="Downloads zeitlich steuern (z. B. nachts volle Leitung, tagsüber gedrosselt)"
              hint="Schont die Leitung beim Gaming oder Streaming."
              checked={Boolean(config.downloadWindowEnabled)}
              onChange={(val) => void updateConfig({ downloadWindowEnabled: val })}
            />
            {config.downloadWindowEnabled ? (
              <div className="grid grid-cols-1 gap-[14px] pt-[2px] sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Volle Leitung ab">
                  <TextInput
                    type="time"
                    value={config.downloadWindowStart || '23:00'}
                    onChange={(e) => void updateConfig({ downloadWindowStart: e.target.value || '23:00' })}
                  />
                </Field>
                <Field label="Bis">
                  <TextInput
                    type="time"
                    value={config.downloadWindowEnd || '07:00'}
                    onChange={(e) => void updateConfig({ downloadWindowEnd: e.target.value || '07:00' })}
                  />
                </Field>
                <Field label="Außerhalb des Fensters">
                  <Select
                    value={config.downloadWindowMode || 'throttle_outside'}
                    onChange={(e) => void updateConfig({ downloadWindowMode: e.target.value as DownloadWindowMode })}
                  >
                    <option value="throttle_outside">Bandbreite drosseln</option>
                    <option value="pause_outside">Downloads pausieren</option>
                  </Select>
                </Field>
                {config.downloadWindowMode !== 'pause_outside' ? (
                  <Field label="Limit tagsüber (KB/s)">
                    <TextInput
                      type="number"
                      min={50}
                      step={250}
                      value={config.daytimeMaxBandwidthKbps ?? 1500}
                      onChange={(e) =>
                        void updateConfig({ daytimeMaxBandwidthKbps: Math.max(50, Number(e.target.value) || 1500) })
                      }
                    />
                  </Field>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-[14px] border-t border-line pt-[18px]">
            <SectionHead rule={false}>Geplantes Herunterfahren</SectionHead>
            <Toggle
              label="Gerät zu einer bestimmten Uhrzeit automatisch herunterfahren"
              hint="Startet zur gewählten Uhrzeit einen 60-Sekunden-Countdown, der jederzeit abgebrochen werden kann."
              checked={Boolean(config.scheduledShutdownEnabled)}
              onChange={(val) => void updateConfig({ scheduledShutdownEnabled: val })}
            />
            {config.scheduledShutdownEnabled ? (
              <div className="flex flex-col gap-[14px] pt-[2px]">
                <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
                  <Field label="Uhrzeit">
                    <TextInput
                      type="time"
                      value={config.scheduledShutdownTime || '03:00'}
                      onChange={(e) => void updateConfig({ scheduledShutdownTime: e.target.value || '03:00' })}
                    />
                  </Field>
                  <Field label="Aktion">
                    <Select
                      value={config.scheduledShutdownAction || 'shutdown'}
                      onChange={(e) => void updateConfig({ scheduledShutdownAction: e.target.value as ShutdownAction })}
                    >
                      <option value="shutdown">Herunterfahren</option>
                      <option value="sleep">Energiesparmodus</option>
                      <option value="hibernate">Ruhezustand</option>
                    </Select>
                  </Field>
                </div>
                <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-2">
                  <Toggle
                    label="Laufende Downloads & Uploads erst fertigstellen"
                    checked={Boolean(config.scheduledShutdownWaitForDownloads)}
                    onChange={(val) => void updateConfig({ scheduledShutdownWaitForDownloads: val })}
                  />
                  <Toggle
                    label="Jeden Tag wiederholen"
                    checked={Boolean(config.scheduledShutdownRepeatDaily)}
                    onChange={(val) => void updateConfig({ scheduledShutdownRepeatDaily: val })}
                  />
                </div>
                {shutdownState?.scheduledAt ? (
                  <p className="text-micro text-muted">
                    Nächster geplanter Zeitpunkt:{' '}
                    <span className="value text-ink">
                      {new Date(shutdownState.scheduledAt).toLocaleString('de-DE', {
                        weekday: 'short',
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-[14px] border-t border-line pt-[18px]">
            <div className="flex flex-wrap items-center justify-between gap-[8px]">
              <SectionHead rule={false}>Benachrichtigungen & Handy-Push</SectionHead>
              <Button variant="quiet" size="sm" disabled={busy !== null} onClick={() => void handleTestPush()}>
                {busy === 'test-push' ? 'Sendet …' : 'Test-Meldung senden'}
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-2 lg:grid-cols-4">
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
              <Toggle
                label="Erinnerungen aus dem Kalender"
                checked={config.notifyOnReminder !== false}
                onChange={(val) => void updateConfig({ notifyOnReminder: val })}
              />
            </div>

            <div className="flex flex-wrap gap-[6px] pt-[2px]">
              {(
                [
                  ['discord', 'Discord', Boolean(config.discordWebhookUrl)],
                  ['telegram', 'Telegram', Boolean(config.telegramBotToken && config.telegramChatId)],
                  ['ntfy', 'ntfy', Boolean(config.ntfyUrl)],
                  ['pushover', 'Pushover', Boolean(config.pushoverAppToken && config.pushoverUserKey)],
                ] as const
              ).map(([id, label, configured]) => {
                const active = pushTab === id
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setPushTab(id)}
                    className={`press rounded-pill px-[12px] py-[5px] text-micro font-medium ${
                      active ? 'bg-ink text-on-ink' : 'bg-panel-soft text-prose hover:text-ink'
                    }`}
                  >
                    {label}
                    {configured ? ' · aktiv' : ''}
                  </button>
                )
              })}
            </div>

            {pushTab === 'discord' ? (
              <Field label="Discord-Webhook (optional)">
                <TextInput
                  placeholder="https://discord.com/api/webhooks/…"
                  value={config.discordWebhookUrl}
                  onChange={(e) => void updateConfig({ discordWebhookUrl: e.target.value })}
                />
              </Field>
            ) : null}

            {pushTab === 'telegram' ? (
              <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
                <Field label="Telegram Bot-Token">
                  <TextInput
                    type="password"
                    placeholder="123456:ABC-DEF…"
                    value={config.telegramBotToken || ''}
                    onChange={(e) => void updateConfig({ telegramBotToken: e.target.value })}
                  />
                </Field>
                <Field label="Telegram Chat-ID">
                  <TextInput
                    placeholder="z. B. 987654321"
                    value={config.telegramChatId || ''}
                    onChange={(e) => void updateConfig({ telegramChatId: e.target.value })}
                  />
                </Field>
              </div>
            ) : null}

            {pushTab === 'ntfy' ? (
              <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
                <Field label="ntfy-Themen-URL">
                  <TextInput
                    placeholder="https://ntfy.sh/mein-sondra-thema"
                    value={config.ntfyUrl || ''}
                    onChange={(e) => void updateConfig({ ntfyUrl: e.target.value })}
                  />
                </Field>
                <Field label="Zugriffs-Token (optional)">
                  <TextInput
                    type="password"
                    placeholder="tk_…"
                    value={config.ntfyToken || ''}
                    onChange={(e) => void updateConfig({ ntfyToken: e.target.value })}
                  />
                </Field>
              </div>
            ) : null}

            {pushTab === 'pushover' ? (
              <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
                <Field label="Pushover App-Token">
                  <TextInput
                    type="password"
                    value={config.pushoverAppToken || ''}
                    onChange={(e) => void updateConfig({ pushoverAppToken: e.target.value })}
                  />
                </Field>
                <Field label="Pushover User-Key">
                  <TextInput
                    type="password"
                    value={config.pushoverUserKey || ''}
                    onChange={(e) => void updateConfig({ pushoverUserKey: e.target.value })}
                  />
                </Field>
              </div>
            ) : null}
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
        open={pairDialogMode !== null}
        onClose={() => setPairDialogMode(null)}
        title="Mit anderem Gerät koppeln"
        size="md"
      >
        {pairDialogMode ? (
          <div className="flex flex-col gap-[18px]">
            <div className="flex flex-wrap gap-[6px]">
              <button
                type="button"
                onClick={() => {
                  setPairError(null)
                  setPairDialogMode('import')
                }}
                className={`press rounded-pill px-[12px] py-[6px] text-small font-medium ${
                  pairDialogMode === 'import' ? 'bg-ink font-semibold text-on-ink' : 'bg-panel-soft text-prose hover:text-ink'
                }`}
              >
                Auf diesem Gerät einspielen
              </button>
              <button
                type="button"
                onClick={() => {
                  setPairError(null)
                  setPairDialogMode('export')
                }}
                className={`press rounded-pill px-[12px] py-[6px] text-small font-medium ${
                  pairDialogMode === 'export' ? 'bg-ink font-semibold text-on-ink' : 'bg-panel-soft text-prose hover:text-ink'
                }`}
              >
                Für Server / anderen PC erstellen
              </button>
            </div>

            {pairDialogMode === 'import' ? (
              <div className="flex flex-col gap-[14px]">
                <p className="text-small text-prose">
                  Überträgt eine bestehende Google-Drive-Anmeldung samt Einstellungen verschlüsselt von deinem Hauptrechner — ganz ohne Browser-Anmeldung auf diesem Gerät.
                </p>
                <Field label="Kopplungspaket">
                  <TextInput
                    placeholder="SONDRA-AD-PAIR-1.…"
                    value={importBundleText}
                    onChange={(e) => setImportBundleText(e.target.value)}
                    autoFocus
                  />
                </Field>
                <Field label="Passwort (mind. 4 Zeichen)">
                  <TextInput
                    type="password"
                    placeholder="Dasselbe Passwort wie beim Erstellen"
                    value={pairPin}
                    onChange={(e) => setPairPin(e.target.value)}
                  />
                </Field>
                {pairError ? <p className="text-small text-ink">! {pairError}</p> : null}
                <div className="flex justify-end gap-[10px] border-t border-line pt-[14px]">
                  <Button variant="quiet" size="sm" onClick={() => setPairDialogMode(null)}>
                    Abbrechen
                  </Button>
                  <Button
                    size="sm"
                    disabled={!importBundleText.trim() || pairPin.length < 4 || busy !== null}
                    onClick={() => void handleImportPairing()}
                  >
                    {busy === 'pair-import' ? 'Verbindet …' : 'Verbinden'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-[14px]">
                <p className="text-small text-prose">
                  Verpackt deine aktuelle Google-Drive-Anmeldung, Cookies und Grundeinstellungen AES-256-verschlüsselt für einen Server oder zweiten Laptop.
                </p>
                <Field label="Eigenes Passwort zum Schützen (mind. 4 Zeichen)">
                  <TextInput
                    type="password"
                    placeholder="Passwort wählen"
                    value={pairPin}
                    onChange={(e) => setPairPin(e.target.value)}
                    autoFocus
                  />
                </Field>
                <div>
                  <Button
                    size="sm"
                    disabled={pairPin.length < 4 || busy !== null}
                    onClick={() => void handleExportPairing()}
                  >
                    {busy === 'pair-export' ? 'Erzeugt …' : 'Kopplungspaket erzeugen'}
                  </Button>
                </div>
                {exportedBundle ? (
                  <div className="flex flex-col gap-[8px] border-t border-line pt-[12px]">
                    <Field label="Fertiges Kopplungspaket">
                      <div className="flex gap-[8px]">
                        <TextInput readOnly value={exportedBundle} onFocus={(e) => e.currentTarget.select()} />
                        <Button variant="quiet" size="sm" onClick={() => void handleCopyBundle()}>
                          {copiedBundle ? 'Kopiert' : 'Kopieren'}
                        </Button>
                      </div>
                    </Field>
                  </div>
                ) : null}
                {pairError ? <p className="text-small text-ink">! {pairError}</p> : null}
              </div>
            )}
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}
