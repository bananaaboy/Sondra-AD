import { useEffect, useState } from 'react'
import changelog from '../changelog.json'
import { Dialog } from './ui/primitives'

export interface ReleaseEntry {
  version: string
  date: string
  items: string[]
}

export const RELEASES: ReleaseEntry[] = changelog.versions
export const APP_VERSION: string = RELEASES[0]?.version || '1.0.6'

const OPEN_EVENT = 'sondra-ad:was-ist-neu'
const SEEN_KEY = 'sondra-ad:gesehene-version'

export function openWhatsNew() {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

function dateLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('de-CH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function WhatsNewDialog() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(OPEN_EVENT, show)
    return () => window.removeEventListener(OPEN_EVENT, show)
  }, [])
  if (!open) return null
  return (
    <Dialog open onClose={() => setOpen(false)} title="Was ist neu" size="md">
      <ol className="flex max-h-[68vh] flex-col overflow-y-auto pr-[4px]">
        {RELEASES.map((release) => {
          const current = release.version === APP_VERSION
          return (
            <li
              key={release.version}
              className="flex max-w-none flex-col gap-[8px] border-t border-line py-[16px] first:border-t-0 first:pt-0"
            >
              <h3 className="flex flex-wrap items-baseline gap-x-[10px] gap-y-[2px]">
                <span className="value text-body font-semibold text-ink">{release.version}</span>
                <span className="text-small text-prose">{dateLabel(release.date)}</span>
                {current ? (
                  <span className="rounded-pill bg-ink px-[8px] py-[1px] text-micro font-semibold text-on-ink">
                    Diese Fassung
                  </span>
                ) : null}
              </h3>
              <ul className="flex flex-col gap-[6px] pl-[18px]">
                {release.items.map((item) => (
                  <li key={item} className="list-disc text-small leading-[1.5] text-prose marker:text-faint">
                    {item}
                  </li>
                ))}
              </ul>
            </li>
          )
        })}
      </ol>
    </Dialog>
  )
}

export function WhatsNewLine() {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    try {
      const seen = localStorage.getItem(SEEN_KEY)
      if (seen && seen !== APP_VERSION && RELEASES.some((release) => release.version === APP_VERSION)) {
        setShown(true)
      }
      if (!seen) localStorage.setItem(SEEN_KEY, APP_VERSION)
    } catch {}
  }, [])
  const release = RELEASES.find((entry) => entry.version === APP_VERSION)
  if (!shown || !release) return null
  const done = () => {
    setShown(false)
    try {
      localStorage.setItem(SEEN_KEY, APP_VERSION)
    } catch {}
  }
  return (
    <div
      role="status"
      className="shell flex flex-wrap items-center gap-x-[12px] gap-y-[4px] pt-[12px] text-small text-prose"
    >
      <span className="value font-semibold text-ink">Neu in {release.version}</span>
      <span className="min-w-0 flex-1 truncate">{release.items[0]}</span>
      <button
        type="button"
        onClick={() => {
          done()
          openWhatsNew()
        }}
        className="press text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
      >
        Alles, was neu ist
      </button>
      <button
        type="button"
        onClick={done}
        aria-label="Hinweis schliessen"
        className="press rounded-nav p-[2px] text-prose hover:text-ink"
      >
        <svg viewBox="0 0 16 16" className="size-[14px]" fill="none" aria-hidden>
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
