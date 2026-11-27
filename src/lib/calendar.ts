/**
 * Der Kalender – übernommen aus Sondra (`src/lib/calendar.ts` in bananaaboy/Sondra),
 * damit beide Apps denselben Kalender zeigen: die Woche auf einen Blick, Serien mit
 * selbst eingetragenem Sendetag (nie geschätzt) und eigene Termine mit Datum,
 * Uhrzeit, Wiederholung und Erinnerung.
 *
 * Daten sind Kalendertage `YYYY-MM-DD`, jeder Schritt wird am Datum gemacht, nie in
 * Millisekunden – auch in der Woche der Zeitumstellung. Wochen beginnen am Montag.
 *
 * Anders als in Sondra liegen Einträge und Sendetage im Hintergrunddienst
 * (`engine/calendar.mjs`), der auch die Erinnerungen auslöst.
 */

/** Wöchentlicher Sendeplatz: Wochentag (0 = Montag … 6 = Sonntag), Uhrzeit falls bekannt, Erinnerung in Minuten vorher. */
export interface Airing {
  weekday: number
  time?: string
  remind?: number
}

export type Repeat = 'none' | 'daily' | 'weekly'

export interface CalEvent {
  id: string
  title: string
  /** The first (or only) day, `YYYY-MM-DD`. */
  date: string
  time?: string
  endTime?: string
  repeat: Repeat
  note?: string
  /** Minutes before `time` (0 = at the time); needs a time. */
  remind?: number
  updatedAt: number
}

/** What the Kalender needs of a series: not the whole entry. */
export interface AiringSeries {
  id: string
  title: string
  airing?: Airing
  status?: string
}

/** One line of a day: an event of the person's or a series that comes out. */
export interface DayItem {
  /** Unique for the day: `event:<id>` or `series:<id>`. */
  key: string
  kind: 'event' | 'series'
  /** The event's or the series' id. */
  id: string
  title: string
  date: string
  time?: string
  endTime?: string
  note?: string
  remind?: number
  repeat?: Repeat
}

export const WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
export const WEEKDAYS_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag']
const MONTHS_LONG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
const MONTHS_SHORT = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.']

export const REMIND_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Keine' },
  { value: 0, label: 'Zur Uhrzeit' },
  { value: 10, label: '10 Minuten vorher' },
  { value: 30, label: '30 Minuten vorher' },
  { value: 60, label: '1 Stunde vorher' },
  { value: 1440, label: '1 Tag vorher' },
]

export const REPEAT_OPTIONS: { value: Repeat; label: string }[] = [
  { value: 'none', label: 'Einmalig' },
  { value: 'daily', label: 'Jeden Tag' },
  { value: 'weekly', label: 'Jede Woche' },
]

/* -- Dates ------------------------------------------------------------------ */

const pad = (n: number) => String(n).padStart(2, '0')

export function formatYmd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`
}

/** A date as `{ y, m, d }`, or `null` for anything that is not a real calendar day. */
export function parseYmd(text: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const check = new Date(Date.UTC(y, m - 1, d))
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d ? { y, m, d } : null
}

/** `n` days on, on the calendar — not 24 hours on the clock. */
export function addDays(ymd: string, n: number): string {
  const parts = parseYmd(ymd)
  if (!parts) return ymd
  const moved = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + n))
  return formatYmd(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate())
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(ymd: string): number {
  const parts = parseYmd(ymd)
  if (!parts) return 0
  return (new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay() + 6) % 7
}

/** The Monday of the week a date is in. */
export function weekStart(ymd: string): string {
  return addDays(ymd, -weekdayOf(ymd))
}

export function weekDates(start: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(start, index))
}

/** Today on this wall's clock. */
export function todayYmd(now: Date = new Date()): string {
  return formatYmd(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

export const isTime = (text: unknown): text is string => typeof text === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(text)

/** The moment a date and a clock time name on this wall: 18:00 stays 18:00 in the week the clocks change. */
export function startsAt(ymd: string, time: string): Date {
  const parts = parseYmd(ymd)
  const [hours, minutes] = isTime(time) ? time.split(':').map(Number) : [0, 0]
  return parts ? new Date(parts.y, parts.m - 1, parts.d, hours, minutes) : new Date(NaN)
}

/** „Mo 24“. */
export const dayHeading = (ymd: string) => `${WEEKDAYS_SHORT[weekdayOf(ymd)]} ${parseYmd(ymd)?.d ?? ''}`

/** „Montag, 24. November 2026“. */
export function dayLong(ymd: string): string {
  const parts = parseYmd(ymd)
  return parts ? `${WEEKDAYS_LONG[weekdayOf(ymd)]}, ${parts.d}. ${MONTHS_LONG[parts.m - 1]} ${parts.y}` : ymd
}

/** „24.–30. November 2026“, „30. Nov. – 5. Dez. 2026“, across a year too. */
export function weekLabel(start: string): string {
  const a = parseYmd(start)
  const b = parseYmd(addDays(start, 6))
  if (!a || !b) return start
  if (a.y === b.y && a.m === b.m) return `${a.d}.–${b.d}. ${MONTHS_LONG[a.m - 1]} ${a.y}`
  if (a.y === b.y) return `${a.d}. ${MONTHS_SHORT[a.m - 1]} – ${b.d}. ${MONTHS_SHORT[b.m - 1]} ${a.y}`
  return `${a.d}. ${MONTHS_SHORT[a.m - 1]} ${a.y} – ${b.d}. ${MONTHS_SHORT[b.m - 1]} ${b.y}`
}

/* -- What lies on a day ------------------------------------------------------- */

/** True when an event takes place on a date. */
export function occursOn(event: Pick<CalEvent, 'date' | 'repeat'>, ymd: string): boolean {
  if (ymd < event.date) return false
  if (event.repeat === 'daily') return true
  if (event.repeat === 'weekly') return weekdayOf(ymd) === weekdayOf(event.date)
  return ymd === event.date
}

/** A series is in the Kalender while it is being watched and has a day. */
const airsOn = (series: AiringSeries, ymd: string) =>
  Boolean(series.airing) && (series.status ?? 'watching') === 'watching' && series.airing!.weekday === weekdayOf(ymd)

/** Everything on one day, the entries without a time first, then by the clock. */
export function itemsOn(ymd: string, events: CalEvent[], series: AiringSeries[]): DayItem[] {
  const own: DayItem[] = events
    .filter((event) => occursOn(event, ymd))
    .map((event) => ({
      key: `event:${event.id}`,
      kind: 'event' as const,
      id: event.id,
      title: event.title,
      date: ymd,
      ...(event.time ? { time: event.time } : {}),
      ...(event.endTime ? { endTime: event.endTime } : {}),
      ...(event.note ? { note: event.note } : {}),
      ...(event.remind !== undefined ? { remind: event.remind } : {}),
      repeat: event.repeat,
    }))
  const airing: DayItem[] = series
    .filter((entry) => airsOn(entry, ymd))
    .map((entry) => ({
      key: `series:${entry.id}`,
      kind: 'series' as const,
      id: entry.id,
      title: entry.title,
      date: ymd,
      ...(entry.airing?.time ? { time: entry.airing.time } : {}),
      ...(entry.airing?.remind !== undefined ? { remind: entry.airing.remind } : {}),
    }))
  return [...own, ...airing].sort((a, b) => (a.time ?? '').localeCompare(b.time ?? '') || a.title.localeCompare(b.title, 'de'))
}

/* -- What the engine keeps ------------------------------------------------------ */

export interface CalendarSnapshot {
  events: CalEvent[]
  airing: Record<string, Airing>
}

export const EMPTY_CALENDAR: CalendarSnapshot = { events: [], airing: {} }

/** Die Merkliste, wie der Kalender sie braucht: jede Serie mit ihrem Sendetag. */
export function merkItemsForCalendar(
  items: { id: string; title: string; status?: string }[],
  airing: Record<string, Airing>,
): AiringSeries[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    ...(airing[item.id] ? { airing: airing[item.id] } : {}),
  }))
}
