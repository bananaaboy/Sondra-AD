/**
 * „Kalender“ – derselbe Kalender wie in Sondra (`src/components/panels/CalendarPanel.tsx`
 * in bananaaboy/Sondra): die Woche auf einen Blick, Serien mit eigenem Sendetag und
 * eigene Termine mit Datum, Uhrzeit, Wiederholung und Erinnerung.
 *
 * Sieben Spalten am Rechner, eine Liste von Tagen auf dem Handy – dieselben Einträge,
 * derselbe Klick: ein Tag öffnet einen neuen Eintrag, ein Eintrag öffnet sich selbst.
 * Gespeichert und erinnert wird vom Hintergrunddienst von Sondra AD.
 */

import { useEffect, useMemo, useState } from 'react'

import {
  addDays,
  dayHeading,
  dayLong,
  isTime,
  itemsOn,
  REMIND_OPTIONS,
  REPEAT_OPTIONS,
  todayYmd,
  weekDates,
  weekLabel,
  weekStart,
  WEEKDAYS_LONG,
  type Airing,
  type CalEvent,
  type DayItem,
  type Repeat,
} from '../../lib/calendar'
import { useAppStore } from '../../state/appStore'
import type { SavedLinkItem } from '../../types'
import { Button, Dialog, Field, Select, TextInput } from '../ui/primitives'

type CalendarSeries = SavedLinkItem & { airing?: Airing }

/** Wie `positionLabel` in Sondra (`src/lib/merkRows.ts`). */
function positionLabel(season: number, episode: number | null, kind: 'series' | 'list' = 'series'): string {
  if (kind === 'list') return episode ? `Nr. ${episode}` : 'ganze Liste'
  if (season === 0) return episode ? `Film ${episode}` : 'Alle Filme'
  return episode ? `Staffel ${season}, Folge ${episode}` : `Staffel ${season}, alle Folgen`
}

const episodeKindOf = (url: string): 'series' | 'list' => (/[?&]list=|\/playlist\b|\/sets\//i.test(url) ? 'list' : 'series')

/** Auswahl in einer Reihe, wie `ChoiceRow` in Sondra. */
function ChoiceRow<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; title?: string }[]
  onChange: (next: T) => void
}) {
  return (
    <div role="radiogroup" className="inline-flex flex-wrap gap-[4px] self-start rounded-pill bg-panel-soft p-[3px]">
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={`press rounded-pill px-[12px] py-[5px] text-small font-medium ${
              active ? 'bg-ink text-on-ink' : 'text-prose hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** Ticks each half minute, so „heute“ moves on at midnight with the page open. */
function useToday(): string {
  const [today, setToday] = useState(() => todayYmd())
  useEffect(() => {
    const timer = window.setInterval(() => setToday(todayYmd()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return today
}

const nextLabel = (item: SavedLinkItem) => positionLabel(item.season, item.episode, episodeKindOf(item.url))

/** One entry of a day, a button: the time in the face of things entered, then the name. */
function Entry({ item, series, onOpen }: { item: DayItem; series: CalendarSeries | undefined; onOpen: () => void }) {
  const isSeries = item.kind === 'series'
  const sub = isSeries ? (series ? nextLabel(series) : '') : item.note
  return (
    <button
      type="button"
      onClick={onOpen}
      className="press rise flex w-full min-w-0 flex-col gap-[2px] rounded-nav bg-panel-soft px-[10px] py-[8px] text-left ring-1 ring-inset ring-line transition-colors duration-[var(--dur-fast)] hover:bg-panel-mid"
    >
      <span className="flex min-w-0 items-baseline gap-[8px]">
        {item.time ? (
          <span className="value shrink-0 text-micro text-ink">
            {item.time}
            {item.endTime ? `–${item.endTime}` : ''}
          </span>
        ) : null}
        <span className="min-w-0 truncate text-small font-semibold text-ink" title={item.title}>
          {item.title}
        </span>
      </span>
      {sub ? (
        <span className="truncate text-micro text-prose" title={sub}>
          {isSeries ? `Nächste: ${sub}` : sub}
        </span>
      ) : null}
      {item.remind !== undefined || item.repeat === 'weekly' || item.repeat === 'daily' ? (
        <span className="text-micro text-muted">
          {[item.repeat === 'weekly' ? 'jede Woche' : item.repeat === 'daily' ? 'jeden Tag' : null, item.remind !== undefined ? 'mit Erinnerung' : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
      ) : null}
    </button>
  )
}

/* -- The form -------------------------------------------------------------------- */

type Draft =
  | { mode: 'event'; id?: string; title: string; date: string; time: string; endTime: string; repeat: Repeat; remind: string; note: string }
  | { mode: 'series'; id: string; weekday: number; time: string; remind: string }

const remindValue = (remind: number | undefined) => (remind === undefined ? '' : String(remind))
const remindOf = (value: string) => (value === '' ? undefined : Number(value))

function EntryDialog({ draft, onClose, series, onOpenSeries }: { draft: Draft | null; onClose: () => void; series: CalendarSeries[]; onOpenSeries: (id: string) => void }) {
  const saveCalendarEvent = useAppStore((state) => state.saveCalendarEvent)
  const deleteCalendarEvent = useAppStore((state) => state.deleteCalendarEvent)
  const setSeriesAiring = useAppStore((state) => state.setSeriesAiring)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<Draft | null>(draft)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => {
    setForm(draft)
    setProblem(null)
    setConfirmDelete(false)
  }, [draft])

  if (!form) return <Dialog open={false} onClose={onClose} title="Eintrag" size="md">{null}</Dialog>

  const isSeries = form.mode === 'series'
  const editing = (form.mode === 'event' && Boolean(form.id)) || (isSeries && Boolean(series.find((s) => s.id === form.id)?.airing))
  const patch = (next: Partial<Extract<Draft, { mode: 'event' }>> & Partial<Extract<Draft, { mode: 'series' }>>) => setForm({ ...form, ...next } as Draft)

  const switchMode = (mode: 'event' | 'series') => {
    if (mode === form.mode) return
    setProblem(null)
    setForm(
      mode === 'event'
        ? { mode: 'event', title: '', date: todayYmd(), time: '', endTime: '', repeat: 'none', remind: '', note: '' }
        : { mode: 'series', id: series[0]?.id ?? '', weekday: 0, time: '', remind: '' },
    )
  }

  const submit = async () => {
    if (busy) return
    if (form.mode === 'event') {
      if (!form.title.trim()) return setProblem('Geben Sie dem Eintrag einen Namen.')
      if (!form.date) return setProblem('Wählen Sie ein Datum.')
      if (form.remind !== '' && !isTime(form.time)) return setProblem('Für eine Erinnerung braucht der Eintrag eine Uhrzeit.')
      if (form.endTime && isTime(form.time) && form.endTime <= form.time) return setProblem('Das Ende liegt vor dem Anfang.')
      setBusy(true)
      try {
        await saveCalendarEvent({
          id: form.id,
          title: form.title,
          date: form.date,
          time: isTime(form.time) ? form.time : undefined,
          endTime: isTime(form.endTime) ? form.endTime : undefined,
          repeat: form.repeat,
          note: form.note,
          remind: remindOf(form.remind),
        })
      } catch {
        setBusy(false)
        return setProblem('Der Eintrag konnte nicht gespeichert werden.')
      }
      setBusy(false)
    } else {
      if (!form.id) return setProblem('Wählen Sie eine Serie.')
      if (form.remind !== '' && !isTime(form.time)) return setProblem('Für eine Erinnerung braucht die Serie eine Sendezeit.')
      setBusy(true)
      try {
        await setSeriesAiring(form.id, {
          weekday: form.weekday,
          ...(isTime(form.time) ? { time: form.time } : {}),
          ...(remindOf(form.remind) !== undefined ? { remind: remindOf(form.remind) } : {}),
        })
      } catch {
        setBusy(false)
        return setProblem('Der Sendetag konnte nicht gespeichert werden.')
      }
      setBusy(false)
    }
    onClose()
  }

  const remove = async () => {
    try {
      if (form.mode === 'event' && form.id) await deleteCalendarEvent(form.id)
      if (form.mode === 'series') await setSeriesAiring(form.id, null)
    } catch {
      return setProblem('Das hat nicht geklappt. Bitte noch einmal versuchen.')
    }
    onClose()
  }

  return (
    <Dialog open onClose={onClose} title={editing ? 'Eintrag ändern' : 'Neuer Eintrag'} size="md">
      <form
        className="flex flex-col gap-[16px]"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {!editing ? (
          <ChoiceRow
            value={form.mode}
            options={[
              { value: 'event', label: 'Termin' },
              { value: 'series', label: 'Serie, die jede Woche läuft', title: 'Eine Serie der Merkliste mit ihrem Sendetag' },
            ]}
            onChange={switchMode}
          />
        ) : null}

        {form.mode === 'event' ? (
          <div className="grid grid-cols-1 gap-x-[32px] gap-y-[4px] sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2">
              <TextInput autoFocus autoComplete="off" maxLength={120} value={form.title} onChange={(e) => patch({ title: e.target.value })} />
            </Field>
            <Field label="Datum">
              <TextInput type="date" value={form.date} onChange={(e) => patch({ date: e.target.value })} />
            </Field>
            <Field label="Wiederholen">
              <Select value={form.repeat} onChange={(e) => patch({ repeat: e.target.value as Repeat })}>
                {REPEAT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Uhrzeit (leer: ganztägig)">
              <TextInput type="time" value={form.time} onChange={(e) => patch({ time: e.target.value, ...(e.target.value ? {} : { remind: '', endTime: '' }) })} />
            </Field>
            <Field label="Ende (leer: offen)">
              <TextInput type="time" disabled={!form.time} value={form.endTime} onChange={(e) => patch({ endTime: e.target.value })} />
            </Field>
            <Field label="Erinnerung" hint={form.time ? undefined : 'Dafür braucht der Eintrag eine Uhrzeit.'}>
              <Select disabled={!form.time} value={form.remind} onChange={(e) => patch({ remind: e.target.value })}>
                {REMIND_OPTIONS.map((o) => (
                  <option key={String(o.value)} value={o.value === null ? '' : String(o.value)}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Notiz">
              <TextInput autoComplete="off" maxLength={500} value={form.note} onChange={(e) => patch({ note: e.target.value })} />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-x-[32px] gap-y-[4px] sm:grid-cols-2">
            <Field label="Serie" className="sm:col-span-2" hint={series.length === 0 ? 'Die Merkliste hat noch keine Serie.' : 'Sie erscheint jede Woche an diesem Tag, solange Sie sie schauen.'}>
              <Select disabled={editing} value={form.id} onChange={(e) => patch({ id: e.target.value })}>
                {series.length === 0 ? <option value="">–</option> : null}
                {series.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Wochentag">
              <Select value={String(form.weekday)} onChange={(e) => patch({ weekday: Number(e.target.value) })}>
                {WEEKDAYS_LONG.map((name, index) => (
                  <option key={name} value={index}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Sendezeit (leer: unbekannt)">
              <TextInput type="time" value={form.time} onChange={(e) => patch({ time: e.target.value, ...(e.target.value ? {} : { remind: '' }) })} />
            </Field>
            <Field label="Erinnerung" hint={form.time ? undefined : 'Dafür braucht die Serie eine Sendezeit.'} className="sm:col-span-2">
              <Select disabled={!form.time} value={form.remind} onChange={(e) => patch({ remind: e.target.value })}>
                {REMIND_OPTIONS.map((o) => (
                  <option key={String(o.value)} value={o.value === null ? '' : String(o.value)}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}

        {problem ? (
          <p role="alert" className="m-0 text-small font-medium leading-[1.5] text-ink">
            <span aria-hidden className="mr-[8px] inline-block size-[8px] rounded-pill align-middle ring-2 ring-inset ring-ink" />
            {problem}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px]">
          <Button type="submit" disabled={busy || (isSeries && series.length === 0)}>
            {editing ? 'Speichern' : 'Eintragen'}
          </Button>
          <Button type="button" variant="quiet" onClick={onClose}>
            Abbrechen
          </Button>
          {editing && form.mode === 'series' ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onClose()
                onOpenSeries(form.id)
              }}
            >
              Zur Serie
            </Button>
          ) : null}
          {editing ? (
            confirmDelete ? (
              <Button type="button" variant="ghost" onClick={() => void remove()}>
                Wirklich {isSeries ? 'aus dem Kalender nehmen' : 'löschen'}?
              </Button>
            ) : (
              <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)}>
                {isSeries ? 'Aus dem Kalender nehmen' : 'Löschen'}
              </Button>
            )
          ) : null}
        </div>
      </form>
    </Dialog>
  )
}

/* -- The week ----------------------------------------------------------------------- */

export function CalendarPanel() {
  const calendar = useAppStore((state) => state.calendar)
  const merkItems = useAppStore((state) => state.merkItems)
  const setPanel = useAppStore((state) => state.setPanel)
  const events = calendar.events
  const list = useMemo<CalendarSeries[]>(
    () => merkItems.map((item) => (calendar.airing[item.id] ? { ...item, airing: calendar.airing[item.id] } : item)),
    [merkItems, calendar.airing],
  )
  const today = useToday()
  const [start, setStart] = useState(() => weekStart(todayYmd()))
  const [draft, setDraft] = useState<Draft | null>(null)

  const watched = useMemo(() => list.filter((item) => (item.status ?? 'watching') === 'watching'), [list])
  const days = weekDates(start)
  const byId = useMemo(() => new Map(list.map((item) => [item.id, item])), [list])
  const week = days.map((ymd) => ({ ymd, items: itemsOn(ymd, events, list) }))
  const total = week.reduce((sum, day) => sum + day.items.length, 0)
  const isThisWeek = start === weekStart(today)

  const addOn = (ymd: string) => setDraft({ mode: 'event', title: '', date: ymd, time: '', endTime: '', repeat: 'none', remind: '', note: '' })
  const open = (item: DayItem) => {
    if (item.kind === 'series') {
      const entry = byId.get(item.id)
      const airing = entry?.airing
      setDraft({ mode: 'series', id: item.id, weekday: airing?.weekday ?? 0, time: airing?.time ?? '', remind: remindValue(airing?.remind) })
      return
    }
    const event = events.find((entry) => entry.id === item.id) as CalEvent | undefined
    if (event) setDraft({ mode: 'event', id: event.id, title: event.title, date: event.date, time: event.time ?? '', endTime: event.endTime ?? '', repeat: event.repeat, remind: remindValue(event.remind), note: event.note ?? '' })
  }
  const openSeries = (_id: string) => {
    setPanel('merkliste')
  }

  return (
    <div className="flex flex-col gap-[20px]">
      <header className="flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[10px]">
        <div className="flex min-w-0 flex-col gap-[2px]">
          <h2 className="m-0 text-subheading font-semibold text-ink">Kalender</h2>
          <p className="m-0 text-small text-prose" aria-live="polite">
            {weekLabel(start)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-[8px]">
          <Button size="sm" variant="quiet" aria-label="Eine Woche zurück" onClick={() => setStart(addDays(start, -7))}>
            ‹
          </Button>
          <Button size="sm" variant="quiet" disabled={isThisWeek} onClick={() => setStart(weekStart(today))}>
            Heute
          </Button>
          <Button size="sm" variant="quiet" aria-label="Eine Woche weiter" onClick={() => setStart(addDays(start, 7))}>
            ›
          </Button>
          <Button size="sm" onClick={() => addOn(isThisWeek ? today : start)}>
            Eintrag
          </Button>
        </div>
      </header>

      {/* On a desk seven columns, on a phone one list of days. */}
      <div className="grid grid-cols-1 gap-x-[12px] gap-y-[4px] md:grid-cols-7">
        {week.map(({ ymd, items }) => {
          const isToday = ymd === today
          return (
            <section key={ymd} aria-label={dayLong(ymd)} className={`flex min-w-0 flex-col gap-[8px] border-t pt-[10px] ${isToday ? 'border-ink' : 'border-line'} md:min-h-[200px]`}>
              <div className="flex items-baseline justify-between gap-[8px]">
                <h3 className={`m-0 text-small ${isToday ? 'font-semibold text-ink' : 'font-medium text-prose'}`}>
                  {dayHeading(ymd)}
                  {isToday ? <span className="ml-[6px] text-micro font-normal text-muted">heute</span> : null}
                </h3>
                <button
                  type="button"
                  aria-label={`Eintrag am ${dayLong(ymd)}`}
                  onClick={() => addOn(ymd)}
                  className="press grid size-[24px] place-items-center rounded-nav text-muted transition-colors hover:bg-panel-soft hover:text-ink"
                >
                  <svg viewBox="0 0 16 16" className="size-[14px]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                    <path d="M8 3.4v9.2M3.4 8h9.2" />
                  </svg>
                </button>
              </div>
              <div className="flex flex-col gap-[6px] pb-[8px] md:pb-0">
                {items.map((item) => (
                  <Entry key={item.key} item={item} series={item.kind === 'series' ? byId.get(item.id) : undefined} onOpen={() => open(item)} />
                ))}
              </div>
            </section>
          )
        })}
      </div>

      {total === 0 ? (
        <div className="flex max-w-[34em] flex-col gap-[10px] rounded-card bg-panel-soft p-[16px]">
          <p className="m-0 text-body font-semibold text-ink">Diese Woche ist leer.</p>
          <p className="m-0 text-small leading-[1.55] text-prose">
            Tragen Sie einen Termin ein — mit Uhrzeit und, wenn Sie wollen, einer Erinnerung — oder sagen Sie, an welchem Tag eine Ihrer Serien läuft.
          </p>
          <div className="flex flex-wrap gap-[8px]">
            <Button size="sm" onClick={() => addOn(isThisWeek ? today : start)}>
              Termin eintragen
            </Button>
            {watched.length > 0 ? (
              <Button size="sm" variant="quiet" onClick={() => setDraft({ mode: 'series', id: watched[0].id, weekday: 0, time: '', remind: '' })}>
                Serie mit Sendetag
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <footer className="flex flex-col gap-[6px] border-t border-line pt-[12px]">
        <p className="m-0 max-w-[34em] text-small leading-[1.5] text-muted">
          Erinnerungen kommen, solange Sondra AD läuft — auch mit geschlossenem Fenster. Ihre Einträge liegen in Sondra AD auf diesem Gerät und werden nicht mit anderen Geräten abgeglichen.
        </p>
        <button
          type="button"
          onClick={() => setPanel('einstellungen')}
          className="press self-start rounded-nav text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
        >
          Benachrichtigungen aufs Handy einrichten
        </button>
        {total > 0 && watched.length > 0 && !list.some((item) => item.airing) ? (
          <p className="m-0 text-small text-muted">
            Serien erscheinen hier, wenn Sie ihnen einen Sendetag geben —{' '}
            <button
              type="button"
              onClick={() => setDraft({ mode: 'series', id: watched[0].id, weekday: 0, time: '', remind: '' })}
              className="press rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
            >
              Sendetag eintragen
            </button>
            .
          </p>
        ) : null}
      </footer>

      <EntryDialog draft={draft} onClose={() => setDraft(null)} series={watched.length > 0 ? watched : list} onOpenSeries={openSeries} />
    </div>
  )
}
