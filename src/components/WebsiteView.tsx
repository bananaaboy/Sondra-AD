import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import type { ThemeChoice } from '../lib/theme'
import {
  MICROSOFT_STORE,
  RELEASES_URL,
  REPO_URL,
  SONDRA_STUDIO_URL,
  WINDOWS_PORTABLE,
  WINDOWS_PORTABLE_ARM64,
  WINDOWS_SETUP,
  WINDOWS_SETUP_ARM64,
  onWindowsArm,
} from '../lib/downloads'
import { Logo } from './AppShell'
import { ThemeToggle } from './ThemeToggle'
import { Card, Notice } from './ui/primitives'

type SiteTab = 'downloads' | 'datenschutz' | 'lizenzen' | 'einrichtung'

const SITE_TABS: { id: SiteTab; label: string; hash: string }[] = [
  { id: 'downloads', label: 'Downloads', hash: '' },
  { id: 'datenschutz', label: 'Datenschutz', hash: '#datenschutz' },
  { id: 'lizenzen', label: 'Lizenzen', hash: '#lizenzen' },
  { id: 'einrichtung', label: 'Einrichtung & Hilfe', hash: '#einrichtung' },
]

const TAB_ORDER: SiteTab[] = ['downloads', 'datenschutz', 'lizenzen', 'einrichtung']

function siteTabFromHash(hash: string): SiteTab {
  const clean = hash.replace(/^#/, '').trim().toLowerCase()
  if (clean === 'datenschutz') return 'datenschutz'
  if (clean === 'lizenzen' || clean === 'lizenz') return 'lizenzen'
  if (clean === 'einrichtung' || clean === 'hilfe') return 'einrichtung'
  return 'downloads'
}

function DownloadIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={`${className} shrink-0`} fill="none" aria-hidden>
      <path
        d="M8 2.5v7.5M4.8 6.8 8 10l3.2-3.2M3 13h10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function StoreIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`${className} shrink-0`} fill="none" aria-hidden>
      <path d="M3.5 6.5h13l-1 10h-11z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M7 6.5V5a3 3 0 0 1 6 0v1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M7.5 9.5h2v2h-2zM10.5 9.5h2v2h-2zM7.5 12.5h2v2h-2zM10.5 12.5h2v2h-2z" fill="currentColor" />
    </svg>
  )
}

function SetupIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`${className} shrink-0`} fill="none" aria-hidden>
      <path d="M4 3.5h8l4 4v9H4z M12 3.5v4h4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path
        d="M10 9v5M7.8 11.8 10 14l2.2-2.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function StickIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`${className} shrink-0`} fill="none" aria-hidden>
      <rect x="5.5" y="7.5" width="9" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M7.5 7.5v-5h5v5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M9 4.6h.01M11 4.6h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function ServerIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`${className} shrink-0`} fill="none" aria-hidden>
      <rect x="3" y="3.5" width="14" height="5.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="3" y="11" width="14" height="5.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6" cy="6.25" r="0.8" fill="currentColor" />
      <circle cx="6" cy="13.75" r="0.8" fill="currentColor" />
    </svg>
  )
}

function Bars() {
  const bars: [number, number, number][] = [
    [9, 5.35, 13.99],
    [7.73, 9.85, 20.95],
    [4.6, 14.35, 22.8],
    [3.33, 18.85, 20.95],
    [9, 23.35, 13.99],
  ]
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden
      className="pointer-events-none absolute -bottom-[10%] -right-[34%] h-[110%] w-auto fill-current opacity-[0.06] transition-transform duration-[420ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:-translate-x-[12px]"
    >
      {bars.map(([x, y, w], index) => (
        <rect
          key={y}
          x={x}
          y={y}
          width={w}
          height="3.3"
          rx="1.65"
          className="bar-in"
          style={{ ['--delay' as string]: `${120 + index * 70}ms` }}
        />
      ))}
    </svg>
  )
}

function MainWay({
  href,
  onClick,
  icon,
  title,
  facts,
  children,
  action,
}: {
  href: string
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void
  icon: ReactNode
  title: string
  facts: string
  children: ReactNode
  action: string
}) {
  return (
    <a
      href={href}
      rel="noopener"
      onClick={onClick}
      className="press group relative flex min-h-[260px] flex-col overflow-hidden rounded-card bg-ink p-[24px] text-left text-on-ink sm:p-[28px]"
    >
      <Bars />
      <span className="relative flex items-center gap-[12px]">
        {icon}
        <span className="value text-small opacity-80">{facts}</span>
      </span>
      <span className="relative mt-[28px] flex max-w-[38ch] flex-col gap-[8px]">
        <span className="text-heading-sm font-semibold tracking-[-0.02em]">{title}</span>
        <span className="text-body">{children}</span>
      </span>
      <span className="relative mt-auto pt-[24px]">
        <span className="inline-flex items-center gap-[10px] rounded-nav bg-on-ink px-[20px] py-[12px] text-body font-semibold text-ink transition-transform duration-[130ms] group-hover:translate-x-[4px]">
          <DownloadIcon className="h-[18px] w-[18px]" />
          {action}
        </span>
      </span>
    </a>
  )
}

function OtherWay({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <li className="flex max-w-none flex-col gap-[10px] border-t border-line py-[14px] text-ink sm:flex-row sm:items-center sm:gap-[16px]">
      <span className="flex min-w-0 flex-1 items-start gap-[14px]">
        <span className="mt-[2px] text-prose">{icon}</span>
        <span className="flex min-w-0 flex-col gap-[2px]">
          <span className="text-body font-semibold">{title}</span>
          <span className="text-small text-prose">{children}</span>
        </span>
      </span>
      {action ? <span className="shrink-0 self-start pl-[38px] sm:self-auto sm:pl-0">{action}</span> : null}
    </li>
  )
}

const SMALL_ACTION =
  'press inline-flex items-center gap-[8px] rounded-nav px-[14px] py-[8px] text-small font-semibold text-ink ring-1 ring-inset ring-rule hover:bg-panel-soft'

function DefenderDialog({
  open,
  downloadUrl,
  portable,
  onClose,
}: {
  open: boolean
  downloadUrl: string
  portable: boolean
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  if (!open) return null

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose()
      }}
      className="m-auto max-h-[calc(100dvh-32px)] w-[min(580px,calc(100vw-32px))] overflow-hidden overflow-y-auto rounded-[20px] bg-raised p-0 text-prose shadow-2xl ring-1 ring-rule/40 backdrop:bg-ink/60 backdrop:backdrop-blur-[3px]"
    >
      <div className="flex flex-col gap-[20px] p-[24px] sm:p-[32px]">
        <div className="flex items-start justify-between gap-[16px]">
          <h3 className="m-0 text-subheading font-semibold text-ink">Warum Windows warnt</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schliessen"
            className="press -mr-[8px] -mt-[4px] flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-pill text-muted hover:bg-panel-soft hover:text-ink"
          >
            <svg viewBox="0 0 16 16" className="h-[16px] w-[16px]" fill="none" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <figure className="m-0 flex flex-col gap-[4px] rounded-card bg-panel-soft p-[16px]">
          <blockquote className="m-0 text-body font-semibold text-ink">
            „Der Computer wurde durch Windows geschützt“
          </blockquote>
          <figcaption className="text-small text-prose">
            Microsoft Defender SmartScreen hat den Start einer unbekannten App verhindert.
          </figcaption>
        </figure>

        <p className="m-0 text-small leading-[1.55] text-prose">
          Die Warnung sagt nichts über den Inhalt der Datei. Windows kennt den Herausgeber nicht, weil die direkte{' '}
          <span className="value">.exe</span>-Datei nicht mit einem kostenpflichtigen Code-Signing-Zertifikat versehen
          ist. Neue Programme stuft SmartScreen deshalb vorsorglich als „unbekannt“ ein.
        </p>

        <div className="flex flex-col gap-[8px] border-t border-line pt-[12px]">
          <p className="m-0 text-small font-semibold text-ink">
            {portable ? 'So starten Sie Sondra AD' : 'So starten Sie die Installation'}
          </p>
          <ol className="m-0 list-decimal space-y-[4px] pl-[20px] text-small text-prose">
            <li>
              Im Fenster auf <strong className="font-semibold text-ink">„Weitere Informationen“</strong> klicken.
            </li>
            <li>
              Danach unten rechts auf <strong className="font-semibold text-ink">„Trotzdem ausführen“</strong>.
            </li>
          </ol>
          {MICROSOFT_STORE ? (
            <p className="m-0 text-small leading-[1.55] text-muted">
              Über den{' '}
              <a href={MICROSOFT_STORE} target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2">
                Microsoft Store
              </a>{' '}
              installiert sich Sondra AD direkt signiert und ohne SmartScreen-Abfrage.
            </p>
          ) : null}
        </div>

        <div className="mt-[8px] flex flex-wrap items-center gap-[12px]">
          <a
            href={downloadUrl}
            onClick={() => {
              setTimeout(onClose, 100)
            }}
            className="press inline-flex items-center gap-[8px] rounded-nav bg-ink px-[20px] py-[12px] text-body font-semibold text-on-ink hover:bg-ink-hover"
          >
            <DownloadIcon />
            {portable ? 'Portable laden' : 'Setup laden'}
          </a>
          <button
            type="button"
            onClick={onClose}
            className="press rounded-nav px-[16px] py-[12px] text-body text-ink ring-1 ring-inset ring-rule hover:bg-panel-soft"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </dialog>
  )
}

const THIRD_PARTY_LICENSES: { name: string; license: string; purpose: string }[] = [
  { name: 'React & React DOM', license: 'MIT', purpose: 'Benutzeroberfläche' },
  { name: 'Zustand', license: 'MIT', purpose: 'Lokale Zustandsverwaltung' },
  { name: 'Electron & Chromium', license: 'MIT / BSD-3-Clause', purpose: 'Windows-App, System-Tray und Standby-Schutz' },
  { name: 'qrcode-generator', license: 'MIT', purpose: 'Lokale QR-Code-Zeichnung für die Server-Anmeldung' },
  { name: 'youtubei.js', license: 'MIT', purpose: 'Direkte Metadaten- und Spur-Auflösung' },
  { name: 'yt-dlp (optional)', license: 'Unlicense', purpose: 'Externer Medien-Abruf auf dem eigenen Gerät' },
  { name: 'FFmpeg (optional)', license: 'LGPL v2.1+ / GPL v2+', purpose: 'Lokale HLS-Zusammenführung und Archiv-Komprimierung' },
  { name: 'Public Sans, Courier Prime, Cormorant Garamond', license: 'SIL Open Font License 1.1', purpose: 'Selbst gehostete Schriften im Anwendungsbündel' },
]

export function WebsiteView({
  themeChoice,
  onThemeChange,
}: {
  themeChoice: ThemeChoice
  onThemeChange: (choice: ThemeChoice) => void
}) {
  const [tab, setTab] = useState<SiteTab>(() =>
    typeof window !== 'undefined' ? siteTabFromHash(window.location.hash) : 'downloads',
  )
  const [enterDir, setEnterDir] = useState(0)
  const [arm, setArm] = useState(false)
  const [defender, setDefender] = useState<{ url: string; portable: boolean } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [rule, setRule] = useState<{ left: number; width: number; glide: boolean } | null>(null)

  useEffect(() => {
    void onWindowsArm().then(setArm)
    const onPop = () => {
      setTab(siteTabFromHash(window.location.hash))
      setEnterDir(0)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const selectTab = (next: SiteTab) => {
    if (next === tab) return
    const dir = TAB_ORDER.indexOf(next) > TAB_ORDER.indexOf(tab) ? 20 : -20
    const entry = SITE_TABS.find((t) => t.id === next)
    if (typeof window !== 'undefined' && entry) {
      const nextUrl = entry.hash
        ? `${window.location.pathname}${window.location.search}${entry.hash}`
        : `${window.location.pathname}${window.location.search}`
      window.history.pushState(null, '', nextUrl)
    }
    setEnterDir(dir)
    setTab(next)
  }

  useLayoutEffect(() => {
    const update = () => {
      const activeEl = listRef.current?.querySelector<HTMLElement>('[data-site-tab][aria-current="page"]')
      if (!activeEl) return
      const inset = activeEl === listRef.current?.firstElementChild ? 0 : 12
      const left = activeEl.offsetLeft + inset
      const width = Math.max(0, activeEl.offsetWidth - inset - 12)
      setRule((before) =>
        before && before.left === left && before.width === width
          ? before
          : { left, width, glide: before !== null },
      )
    }
    update()
    const observer = new ResizeObserver(update)
    if (listRef.current) observer.observe(listRef.current)
    void document.fonts?.ready.then(update)
    return () => observer.disconnect()
  }, [tab])

  const primarySetup = arm ? WINDOWS_SETUP_ARM64 : WINDOWS_SETUP
  const secondarySetup = arm ? WINDOWS_SETUP : WINDOWS_SETUP_ARM64
  const primaryPortable = arm ? WINDOWS_PORTABLE_ARM64 : WINDOWS_PORTABLE

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-prose">
      <header className="sticky top-0 z-30 border-b-2 border-rule bg-canvas/95 backdrop-blur-md">
        <div className="shell flex items-center justify-between gap-[8px] pt-[10px] sm:gap-[16px] sm:pt-[12px]">
          <Logo onClick={() => selectTab('downloads')} />
          <div className="flex items-center gap-[8px]">
            <a
              href={SONDRA_STUDIO_URL}
              target="_blank"
              rel="noreferrer"
              className="press hidden rounded-nav px-[12px] py-[8px] text-small text-ink ring-1 ring-inset ring-rule hover:bg-panel-soft sm:inline-flex"
            >
              Zu Sondra
            </a>
            <ThemeToggle choice={themeChoice} onChange={onThemeChange} />
          </div>
        </div>

        <nav aria-label="Website-Navigation" className="shell mt-[8px] sm:mt-[12px]">
          <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div ref={listRef} className="relative flex min-w-max items-end">
              {SITE_TABS.map((entry, idx) => {
                const active = entry.id === tab
                return (
                  <button
                    key={entry.id}
                    type="button"
                    data-site-tab
                    data-panel={entry.id}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => selectTab(entry.id)}
                    className={`press relative shrink-0 whitespace-nowrap px-[12px] pb-[10px] pt-[8px] text-small transition-colors duration-[var(--dur-fast)] ${
                      idx === 0 ? 'pl-0' : ''
                    } ${active ? 'font-semibold text-ink' : 'text-prose hover:text-ink'}`}
                  >
                    {entry.label}
                  </button>
                )
              })}
              {rule ? (
                <span
                  aria-hidden
                  className={`pointer-events-none absolute bottom-[-2px] left-0 h-[2px] w-[1px] origin-left bg-ink ${
                    rule.glide ? 'transition-transform duration-[var(--dur-slow)] ease-[var(--ease-settle)]' : ''
                  }`}
                  style={{ transform: `translateX(${rule.left}px) scaleX(${rule.width})` }}
                />
              ) : null}
            </div>
          </div>
        </nav>
      </header>

      <main className="shell flex-1 pt-[28px] sm:pt-[36px]">
        <div
          key={tab}
          style={{ '--enter-x': `${enterDir}px` } as CSSProperties}
          className="rise flex flex-col gap-[32px]"
        >
          {tab === 'downloads' ? (
            <>
              <div className="flex flex-col gap-[10px]">
                <h2 className="display-md">Sondra AD für Windows</h2>
                <p className="max-w-[68ch] text-body text-muted">
                  Automatischer Hintergrund-Downloader für die Sondra-Merkliste. Läuft unterbrechungsfrei als
                  Windows-App im System-Tray mit Windows-Autostart und Standby-Schutz — erhältlich für den Microsoft
                  Store und direkt als <span className="value text-ink">.exe</span>.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-[14px] md:grid-cols-[1.35fr_1fr]">
                <MainWay
                  href={primarySetup}
                  onClick={(event) => {
                    event.preventDefault()
                    setDefender({ url: primarySetup, portable: false })
                  }}
                  icon={<SetupIcon className="h-[28px] w-[28px]" />}
                  title="Setup für Windows (.exe)"
                  facts={arm ? '.exe · Arm64 · Windows 10 und 11' : '.exe · x64 · Windows 10 und 11'}
                  action="Setup herunterladen"
                >
                  Installiert Sondra AD mit Startmenü-Eintrag, startet auf Wunsch automatisch minimiert mit Windows und
                  überwacht Ihre Sondra-Merkliste rund um die Uhr im Hintergrund.
                </MainWay>

                {MICROSOFT_STORE ? (
                  <a
                    href={MICROSOFT_STORE}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="press group flex flex-col rounded-card bg-panel-soft p-[24px] text-left text-ink hover:bg-panel-mid sm:p-[28px]"
                  >
                    <span className="flex items-center gap-[12px]">
                      <StoreIcon className="h-[28px] w-[28px]" />
                      <span className="value text-small text-prose">.msix · Windows Store</span>
                    </span>
                    <span className="mt-[28px] flex flex-col gap-[8px]">
                      <span className="text-heading-sm font-semibold tracking-[-0.02em]">Microsoft Store</span>
                      <span className="text-body text-prose">
                        Installiert sich ohne SmartScreen-Warnung von Windows, Updates kommen automatisch über den
                        Store.
                      </span>
                    </span>
                    <span className="mt-auto pt-[24px]">
                      <span className="inline-flex items-center gap-[10px] rounded-nav bg-ink px-[20px] py-[12px] text-body font-semibold text-on-ink group-hover:bg-ink-hover">
                        Im Microsoft Store öffnen
                      </span>
                    </span>
                  </a>
                ) : (
                  <div className="flex flex-col rounded-card bg-panel-soft p-[24px] text-ink sm:p-[28px]">
                    <span className="flex items-center gap-[12px]">
                      <StoreIcon className="h-[28px] w-[28px]" />
                      <span className="value text-small text-prose">.msix · Windows 10 und 11</span>
                    </span>
                    <span className="mt-[28px] flex flex-col gap-[8px]">
                      <span className="text-heading-sm font-semibold tracking-[-0.02em]">Microsoft Store</span>
                      <span className="text-body text-prose">
                        Geprüftes MSIX-Paket für Windows 10 und 11 ohne SmartScreen-Abfrage und mit automatischen
                        Store-Updates.
                      </span>
                    </span>
                    <span className="mt-auto pt-[24px] text-small font-semibold text-prose">
                      In Vorbereitung — bis zur Freigabe direkt über das Windows-Setup oder die portable .exe nutzbar
                    </span>
                  </div>
                )}
              </div>

              <ul className="m-0 flex list-none flex-col border-b border-line p-0">
                <OtherWay
                  icon={<StickIcon className="h-[24px] w-[24px]" />}
                  title="Portable Fassung (.exe)"
                  action={
                    <a
                      href={primaryPortable}
                      rel="noopener"
                      onClick={(event) => {
                        event.preventDefault()
                        setDefender({ url: primaryPortable, portable: true })
                      }}
                      className={SMALL_ACTION}
                    >
                      <DownloadIcon />
                      Herunterladen
                    </a>
                  }
                >
                  Eine einzelne <span className="value">.exe</span> ohne Installation — ideal für Laptop, Server oder
                  USB-Stick. Alle Einstellungen, Datenbanken und Protokolle liegen daneben im Ordner{' '}
                  <span className="value">Sondra-AD-Daten</span>.
                </OtherWay>

                <OtherWay
                  icon={<SetupIcon className="h-[24px] w-[24px]" />}
                  title={arm ? 'Setup für x64-Prozessoren (.exe)' : 'Setup für Arm-Prozessoren (.exe)'}
                  action={
                    <a
                      href={secondarySetup}
                      rel="noopener"
                      onClick={(event) => {
                        event.preventDefault()
                        setDefender({ url: secondarySetup, portable: false })
                      }}
                      className={SMALL_ACTION}
                    >
                      <DownloadIcon />
                      Herunterladen
                    </a>
                  }
                >
                  {arm
                    ? 'Für Windows-Rechner mit Intel- oder AMD-Prozessor.'
                    : 'Natives Arm64-Paket für Windows-Geräte mit Snapdragon- oder anderem Arm-Prozessor.'}
                </OtherWay>

                <OtherWay
                  icon={<ServerIcon className="h-[24px] w-[24px]" />}
                  title="Alle Releases & Server-Quellcode"
                  action={
                    <a href={RELEASES_URL} target="_blank" rel="noreferrer" className={SMALL_ACTION}>
                      Alle Versionen
                    </a>
                  }
                >
                  Versionsarchiv mit Prüfsummen sowie Node.js-Hintergrunddienst für kopflose Heimserver und VPS.
                </OtherWay>
              </ul>

              <section className="flex flex-col gap-[16px] border-t border-rule pt-[24px]">
                <h3 className="display-sm">Was die Sondra-AD-App übernimmt</h3>
                <div className="grid grid-cols-1 gap-[16px] md:grid-cols-3">
                  <Card tone="mint" className="p-[20px]">
                    <p className="text-body font-semibold text-ink">Nahtlose Sondra-Verbindung</p>
                    <p className="mt-[6px] text-small text-prose">
                      Übernimmt Anmeldung, Cookies und Merkliste auf Wunsch mit einem Klick aus Ihrer installierten
                      Sondra-App und legt Episoden fertig sortiert unter{' '}
                      <span className="value">Sondra/Serien/&lt;Titel&gt;/Staffel &lt;n&gt;</span> in Google Drive ab.
                    </p>
                  </Card>

                  <Card tone="mint" className="p-[20px]">
                    <p className="text-body font-semibold text-ink">Neue Staffeln & Hoster-Fallback</p>
                    <p className="mt-[6px] text-small text-prose">
                      Prüft Ihre Merkliste im eingestellten Takt auf neue Staffeln und Folgen, wartet optional auf Ihre
                      Wunschsprache, wechselt bei Fehlern automatisch den Hoster und wiederholt abgebrochene Downloads.
                    </p>
                  </Card>

                  <Card tone="mint" className="p-[20px]">
                    <p className="text-body font-semibold text-ink">Speichergrenzen & Archiv</p>
                    <p className="mt-[6px] text-small text-prose">
                      Räumt ab frei wählbaren Speichergrenzen zuerst gesehene Episoden auf, schützt ungesehene Folgen
                      und verschiebt, komprimiert oder lagert lange ungenutzte Serien automatisch ins Archiv aus.
                    </p>
                  </Card>
                </div>
              </section>
            </>
          ) : null}

          {tab === 'datenschutz' ? (
            <div className="flex max-w-[74ch] flex-col gap-[24px]">
              <div className="flex flex-col gap-[8px]">
                <h2 className="display-md">Datenschutz</h2>
                <p className="text-body text-muted">
                  Sondra AD arbeitet lokal auf Ihrem eigenen Gerät — ohne Telemetrie, ohne Werbe- oder Analyse-Tracker
                  und ohne eigenes Nutzerkonto.
                </p>
              </div>

              <Notice tone="info">
                Diese Website lädt keinerlei externe Schriften, Skripte oder Analyse-Dienste. Es werden keine Cookies zu
                Werbe- oder Trackingzwecken gesetzt.
              </Notice>

              <div className="flex flex-col gap-[18px] border-t border-rule pt-[20px]">
                <h3 className="display-sm">1. Betrieb der Website</h3>
                <p className="text-body text-prose">
                  Die Website von Sondra AD dient ausschließlich der Bereitstellung der Installationsdateien, der
                  Dokumentation sowie der Datenschutz- und Lizenzhinweise. Sämtliche Schriftarten (Public Sans, Courier
                  Prime, Cormorant Garamond) und Symbole sind lokal eingebettet; es erfolgt keine Verbindung zu Google
                  Fonts oder externen Content-Delivery-Netzwerken. Beim Herunterladen einer Installationsdatei von
                  GitHub Releases gelten für den Dateiabruf die Datenschutzbestimmungen von GitHub.
                </p>
              </div>

              <div className="flex flex-col gap-[18px] border-t border-line pt-[20px]">
                <h3 className="display-sm">2. Lokale Datenhaltung in der App</h3>
                <p className="text-body text-prose">
                  In der Windows-App und im lokalen Server-Dienst werden Einstellungen, die synchronisierte SQLite-Merkliste,
                  die Download-Warteschlange sowie das Ereignisprotokoll (<span className="value">logs.jsonl</span>)
                  ausschließlich lokal auf Ihrem Rechner gespeichert (unter <span className="value">%APPDATA%\Sondra AD</span>{' '}
                  bzw. bei der portablen Fassung im Ordner <span className="value">Sondra-AD-Daten</span>).
                  Anmeldeschlüssel werden über die Betriebssystem-Schlüsselverwaltung (Windows DPAPI) verschlüsselt
                  hinterlegt.
                </p>
              </div>

              <div className="flex flex-col gap-[18px] border-t border-line pt-[20px]">
                <h3 className="display-sm">3. Verbindung mit Google Drive</h3>
                <p className="text-body text-prose">
                  Sofern Sie Google Drive verbinden, fordert Sondra AD ausschließlich den eingeschränkten
                  Berechtigungsumfang <span className="value">https://www.googleapis.com/auth/drive.file</span> an.
                  Damit kann die Anwendung nur Dateien und Ordner sehen und verwalten, die von Sondra oder Sondra AD
                  selbst im Ordner <span className="value">Sondra</span> Ihres Google Drive angelegt wurden (Merkliste,
                  Serien, Archiv und Geräte-Eintrag). Auf Ihre übrigen privaten Dateien in Google Drive hat Sondra AD
                  keinen Zugriff. Die Übertragung erfolgt direkt zwischen Ihrem Gerät und den Servern von Google.
                </p>
              </div>

              <div className="flex flex-col gap-[18px] border-t border-line pt-[20px]">
                <h3 className="display-sm">4. Automatische Prüfungen, Downloads & Benachrichtigungen</h3>
                <p className="text-body text-prose">
                  Prüfungen auf neue Staffeln und Episoden sowie Medien-Downloads werden unmittelbar von Ihrem eigenen
                  Rechner über Ihre Internetverbindung ausgeführt. Es steht kein Vermittlungsserver von Sondra
                  dazwischen. Wenn Sie optional eine Discord-Webhook-Adresse hinterlegen, sendet Ihr Gerät
                  Statusmeldungen direkt an die von Ihnen eingetragene Webhook-URL.
                </p>
              </div>

              <p className="border-t border-line pt-[16px] text-small text-muted">
                Eigenständige Druckfassung:{' '}
                <a className="text-ink underline underline-offset-[3px] hover:no-underline" href="./datenschutz.html">
                  datenschutz.html öffnen
                </a>
              </p>
            </div>
          ) : null}

          {tab === 'lizenzen' ? (
            <div className="flex max-w-[78ch] flex-col gap-[24px]">
              <div className="flex flex-col gap-[8px]">
                <h2 className="display-md">Lizenzen & Quellcode</h2>
                <p className="text-body text-muted">
                  Sondra AD ist freie, quelloffene Software unter der MIT-Lizenz.
                </p>
              </div>

              <Card tone="mint" className="p-[20px] sm:p-[24px]">
                <div className="flex flex-wrap items-center justify-between gap-[12px] border-b border-line pb-[12px]">
                  <p className="text-body font-semibold text-ink">MIT-Lizenz · Sondra AD</p>
                  <a
                    href={REPO_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-small font-medium text-ink underline underline-offset-[3px] hover:no-underline"
                  >
                    Quellcode auf GitHub
                  </a>
                </div>
                <pre className="value mt-[14px] overflow-x-auto whitespace-pre-wrap text-micro leading-[1.6] text-prose">{`Copyright (c) 2026 Lizge Navajeetharan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`}</pre>
              </Card>

              <div className="flex flex-col gap-[12px] border-t border-rule pt-[20px]">
                <h3 className="display-sm">Verwendete quelloffene Bestandteile</h3>
                <p className="text-small text-muted">
                  In der installierten Windows-Anwendung liegen sämtliche Lizenztexte zusätzlich im Programmordner unter{' '}
                  <span className="value">LIZENZ.txt</span>, <span className="value">LICENSE.electron.txt</span>,{' '}
                  <span className="value">LICENSES.chromium.html</span> und <span className="value">lizenzen/</span>{' '}
                  bereit.
                </p>

                <div className="divide-y divide-line border-y border-line">
                  {THIRD_PARTY_LICENSES.map((item) => (
                    <div
                      key={item.name}
                      className="flex flex-col justify-between gap-[4px] py-[12px] sm:flex-row sm:items-baseline sm:gap-[16px]"
                    >
                      <div>
                        <p className="text-body font-semibold text-ink">{item.name}</p>
                        <p className="text-small text-muted">{item.purpose}</p>
                      </div>
                      <span className="value shrink-0 text-small text-ink">{item.license}</span>
                    </div>
                  ))}
                </div>
              </div>

              <p className="text-small text-muted">
                Eigenständige Lizenzseite:{' '}
                <a className="text-ink underline underline-offset-[3px] hover:no-underline" href="./lizenz.html">
                  lizenz.html öffnen
                </a>
              </p>
            </div>
          ) : null}

          {tab === 'einrichtung' ? (
            <div className="flex max-w-[74ch] flex-col gap-[24px]">
              <div className="flex flex-col gap-[8px]">
                <h2 className="display-md">Einrichtung & Hilfe</h2>
                <p className="text-body text-muted">
                  In wenigen Schritten zur automatischen Synchronisation mit Sondra und zum Dauerbetrieb unter Windows
                  oder auf einem Server.
                </p>
              </div>

              <div className="flex flex-col gap-[12px] border-t border-rule pt-[20px]">
                <h3 className="display-sm">1. Windows-App installieren und mit Sondra verbinden</h3>
                <ol className="m-0 list-decimal space-y-[8px] pl-[20px] text-body text-prose">
                  <li>
                    Laden Sie <strong className="font-semibold text-ink">Sondra-AD-Setup.exe</strong> (oder die App aus
                    dem Microsoft Store) herunter und starten Sie Sondra AD.
                  </li>
                  <li>
                    Ist <strong className="font-semibold text-ink">Sondra</strong> auf demselben Windows-Rechner bereits
                    eingerichtet, klicken Sie unter <em>Einstellungen → Aus Sondra übernehmen</em>: Google-Drive-Anmeldung,
                    Merkliste und Cookie-Einstellungen werden sofort übernommen.
                  </li>
                  <li>
                    Alternativ melden Sie sich direkt per Knopfdruck bei Google Drive an. Sondra AD liest danach
                    automatisch <span className="value">Sondra/Merkliste/Sondra-Merkliste.sqlite</span> ein.
                  </li>
                </ol>
              </div>

              <div className="flex flex-col gap-[12px] border-t border-line pt-[20px]">
                <h3 className="display-sm">2. Dauerbetrieb im System-Tray & Windows-Autostart</h3>
                <p className="text-body text-prose">
                  Standardmäßig startet Sondra AD beim Anmelden in Windows lautlos minimiert im System-Tray
                  (<span className="value">--minimized</span>) und verhindert während laufender Überwachung das
                  Einschlafen des Dienstes. Beim Schließen des Fensters läuft der Hintergrunddienst im Tray weiter; ein
                  Rechtsklick auf das Tray-Symbol erlaubt jederzeit eine Sofortprüfung, das Pausieren oder das
                  vollständige Beenden.
                </p>
              </div>

              <div className="flex flex-col gap-[12px] border-t border-line pt-[20px]">
                <h3 className="display-sm">3. Kopfloser Laptop oder Server</h3>
                <p className="text-body text-prose">
                  Soll Sondra AD auf einem separaten Heimserver oder VPS ohne Bildschirm laufen, kannst du auf deinem
                  Hauptrechner unter <em>Einstellungen → Verbindung → Mit anderem Gerät koppeln</em> ein
                  passwortgeschütztes Kopplungspaket (<span className="value">SONDRA-AD-PAIR-1.</span>, AES-256-GCM)
                  erzeugen und auf dem Server einspielen — ganz ohne Browser-Anmeldung auf dem Server.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </main>

      <footer className="shell mt-[44px] flex flex-col gap-[10px] border-t border-line py-[24px] text-small text-muted">
        <div className="flex flex-wrap items-center justify-between gap-[16px]">
          <p className="max-w-[60ch] leading-[1.6]">
            Sondra AD · Automatischer Hintergrund-Downloader für Windows (Microsoft Store & .exe) und Server.
          </p>
          <p className="value text-micro text-muted">v1.0.4 · keine Cookies · kein Tracking · MIT-Lizenz</p>
        </div>
        <p className="flex flex-wrap gap-x-[16px] gap-y-[4px]">
          <button
            type="button"
            onClick={() => selectTab('downloads')}
            className="text-ink underline underline-offset-[3px] hover:no-underline"
          >
            Downloads
          </button>
          <button
            type="button"
            onClick={() => selectTab('datenschutz')}
            className="text-ink underline underline-offset-[3px] hover:no-underline"
          >
            Datenschutz
          </button>
          <button
            type="button"
            onClick={() => selectTab('lizenzen')}
            className="text-ink underline underline-offset-[3px] hover:no-underline"
          >
            Lizenzen
          </button>
          <button
            type="button"
            onClick={() => selectTab('einrichtung')}
            className="text-ink underline underline-offset-[3px] hover:no-underline"
          >
            Einrichtung & Hilfe
          </button>
          <a
            className="text-ink underline underline-offset-[3px] hover:no-underline"
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
          >
            GitHub Releases
          </a>
        </p>
      </footer>

      <DefenderDialog
        open={Boolean(defender)}
        downloadUrl={defender?.url ?? ''}
        portable={defender?.portable ?? false}
        onClose={() => setDefender(null)}
      />
    </div>
  )
}
