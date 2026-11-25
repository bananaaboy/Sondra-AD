import { useLayoutEffect, useRef, useState } from 'react'
import type { ThemeChoice } from '../lib/theme'
import type { PanelId } from '../types'
import { useAppStore } from '../state/appStore'
import { ThemeToggle } from './ThemeToggle'
import { Badge, Button } from './ui/primitives'

export function SondraMark({ className = 'h-[26px] w-[26px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={`shrink-0 fill-current ${className}`} aria-hidden>
      <rect x="9" y="5.35" width="13.99" height="3.3" rx="1.65" />
      <rect x="7.73" y="9.85" width="20.95" height="3.3" rx="1.65" />
      <rect x="4.6" y="14.35" width="22.8" height="3.3" rx="1.65" />
      <rect x="3.33" y="18.85" width="20.95" height="3.3" rx="1.65" />
      <rect x="9" y="23.35" width="13.99" height="3.3" rx="1.65" />
    </svg>
  )
}

export function DriveIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={`shrink-0 ${className}`} fill="none" aria-hidden>
      <path
        d="M4.6 12.6H4a3 3 0 01-.4-6 4.2 4.2 0 018.1-.9 3.2 3.2 0 01.3 6.4h-.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 13.6V8.4M5.9 10.3L8 8.2l2.1 2.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Logo({ onClick }: { onClick?: () => void }) {
  const setPanel = useAppStore((s) => s.setPanel)
  return (
    <h1 className="m-0 flex items-center gap-[8px] text-ink">
      <button
        type="button"
        onClick={() => (onClick ? onClick() : setPanel('uebersicht'))}
        className="press flex items-center gap-[8px] rounded-nav text-ink"
      >
        <SondraMark />
        <span className="font-wordmark text-[25px] font-light tracking-[-0.01em]">Sondra</span>
        <Badge tone="forest">AD</Badge>
      </button>
    </h1>
  )
}

export const PANELS: { id: PanelId; label: string; summary: string }[] = [
  { id: 'uebersicht', label: 'Übersicht', summary: 'Status, nächste Prüfung, aktive Downloads und Speicherstand' },
  { id: 'merkliste', label: 'Merkliste', summary: 'Serien überwachen, Stand abgleichen und Einzelregeln festlegen' },
  { id: 'warteschlange', label: 'Warteschlange', summary: 'Laufende Downloads, Wiederholungen und manuelle Adressen' },
  { id: 'speicher', label: 'Speicher & Archiv', summary: 'Löschgrenzen, Google-Drive-Kontingent und Inaktivitäts-Archiv' },
  { id: 'protokoll', label: 'Protokoll', summary: 'Lückenloses Verzeichnis aller Prüfungen, Hoster-Wechsel und Fehler' },
  { id: 'einstellungen', label: 'Einstellungen', summary: 'Sondra-Verbindung, Windows-Autostart und Download-Vorgaben' },
]

const TAB_CLASS =
  'press relative shrink-0 whitespace-nowrap px-[12px] pb-[10px] pt-[8px] text-small transition-colors duration-[var(--dur-fast)]'

export function PanelTabs() {
  const panel = useAppStore((s) => s.panel)
  const setPanel = useAppStore((s) => s.setPanel)
  const queue = useAppStore((s) => s.queue)
  const listRef = useRef<HTMLDivElement>(null)
  const [rule, setRule] = useState<{ left: number; width: number; glide: boolean } | null>(null)

  const activeJobs = queue.filter((q) => q.status === 'downloading' || q.status === 'uploading' || q.status === 'queued').length
  const problemJobs = queue.filter((q) => q.status === 'retrying' || q.status === 'failed').length

  useLayoutEffect(() => {
    const update = () => {
      const tab = listRef.current?.querySelector<HTMLElement>('[data-tab][aria-current="page"]')
      if (!tab) return
      const inset = tab === listRef.current?.firstElementChild ? 0 : 12
      const left = tab.offsetLeft + inset
      const width = Math.max(0, tab.offsetWidth - inset - 12)
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
  }, [panel, activeJobs, problemJobs])

  return (
    <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div ref={listRef} data-tabrow className="relative flex min-w-max items-end">
        {PANELS.map((entry, idx) => {
          const active = entry.id === panel
          const count = entry.id === 'warteschlange' ? activeJobs + problemJobs : 0
          return (
            <button
              key={entry.id}
              type="button"
              data-tab
              data-panel={entry.id}
              aria-current={active ? 'page' : undefined}
              onClick={() => setPanel(entry.id)}
              title={entry.summary}
              className={`${TAB_CLASS} ${idx === 0 ? 'pl-0' : ''} flex items-center gap-[6px] ${
                active ? 'font-semibold text-ink' : 'text-prose hover:text-ink'
              }`}
            >
              <span>{entry.label}</span>
              {count > 0 ? (
                <span className="value rounded-pill bg-panel-soft px-[6px] py-[1px] text-micro font-medium text-ink">
                  {count}
                </span>
              ) : null}
            </button>
          )
        })}
        {rule ? (
          <span
            aria-hidden
            data-tabrule
            className={`pointer-events-none absolute bottom-[-2px] left-0 h-[2px] w-[1px] origin-left bg-ink ${
              rule.glide ? 'transition-transform duration-[var(--dur-slow)] ease-[var(--ease-settle)]' : ''
            }`}
            style={{ transform: `translateX(${rule.left}px) scaleX(${rule.width})` }}
          />
        ) : null}
      </div>
    </div>
  )
}

export function Header({
  themeChoice,
  onThemeChange,
}: {
  themeChoice: ThemeChoice
  onThemeChange: (choice: ThemeChoice) => void
}) {
  const drive = useAppStore((s) => s.drive)
  const checking = useAppStore((s) => s.checking)
  const checkNow = useAppStore((s) => s.checkNow)
  const setPanel = useAppStore((s) => s.setPanel)

  const driveConnected = Boolean(drive?.connected)

  return (
    <header className="sticky top-0 z-30 border-b-2 border-rule bg-canvas/95 backdrop-blur-md">
      <div className="shell flex items-center justify-between gap-[8px] pt-[10px] sm:gap-[16px] sm:pt-[12px]">
        <Logo />
        <div className="flex min-w-0 items-center gap-[6px] sm:gap-[8px]">
          <button
            type="button"
            onClick={() => setPanel('einstellungen')}
            title={
              driveConnected
                ? `Google Drive verbunden${drive?.account?.email ? ` (${drive.account.email})` : ''}`
                : 'Bei Google anmelden, um mit Sondra zu synchronisieren'
            }
            className="press flex shrink-0 items-center gap-[8px] rounded-nav px-[8px] py-[8px] text-small text-ink ring-1 ring-inset ring-rule hover:bg-panel-soft sm:px-[12px]"
          >
            <DriveIcon />
            <span className="sr-only sm:not-sr-only">{driveConnected ? 'Drive' : 'Drive anmelden'}</span>
          </button>

          <Button
            variant="quiet"
            size="sm"
            disabled={checking}
            onClick={() => void checkNow()}
          >
            <svg viewBox="0 0 16 16" className={`size-[14px] ${checking ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7" />
              <path d="M13.4 2.2v2.6h-2.6" />
            </svg>
            <span className="hidden sm:inline">{checking ? 'Prüft …' : 'Jetzt prüfen'}</span>
          </Button>

          {typeof window !== 'undefined' && window.sondraAd?.isDesktopApp ? (
            <button
              type="button"
              onClick={() => void window.sondraAd?.hideToTray()}
              title="In den System-Tray minimieren"
              aria-label="In den System-Tray minimieren"
              className="press flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-nav text-ink hover:bg-panel-soft sm:h-[32px] sm:w-[32px]"
            >
              <svg viewBox="0 0 16 16" className="size-[14px]" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 12.5h10M8 3v7M5.2 7.2 8 10l2.8-2.8" />
              </svg>
            </button>
          ) : null}

          <ThemeToggle choice={themeChoice} onChange={onThemeChange} />
        </div>
      </div>

      <nav aria-label="Bereiche" className="shell mt-[8px] sm:mt-[12px]">
        <PanelTabs />
      </nav>
    </header>
  )
}

export function Footer() {
  const runtimeMode = useAppStore((s) => s.runtimeMode)
  const drive = useAppStore((s) => s.drive)
  const tools = useAppStore((s) => s.tools)

  return (
    <footer className="shell mt-[40px] flex flex-col gap-[10px] border-t border-line py-[24px] text-small text-muted">
      <div className="flex flex-wrap items-center justify-between gap-[16px]">
        <p className="max-w-[60ch] leading-[1.6]">
          Sondra AD · Dauerbetrieb für Laptop und Server ({runtimeMode === 'desktop' ? 'Desktop-App mit System-Tray' : 'Hintergrund-Server'}).
        </p>
        <p className="value text-micro text-muted">
          v1.0.2 · yt-dlp: {tools?.ytdlpAvailable ? tools.ytdlpVersion || 'bereit' : 'wird bei Bedarf geladen'} · FFmpeg:{' '}
          {tools?.ffmpegAvailable ? (tools.gpuEncoder ? `GPU (${tools.gpuEncoder})` : 'System') : 'Nativ HLS'} ·{' '}
          {drive?.connected ? 'Google Drive verbunden' : 'Lokal'}
        </p>
      </div>
      <p className="flex flex-wrap gap-x-[16px] gap-y-[4px]">
        <a className="text-ink underline underline-offset-[3px] hover:no-underline" href="./datenschutz.html">
          Datenschutz
        </a>
        <a className="text-ink underline underline-offset-[3px] hover:no-underline" href="./lizenz.html">
          Lizenzen
        </a>
      </p>
    </footer>
  )
}
