/**
 * Der Kalender – dieselben Regeln wie in Sondra (`src/lib/calendar.ts` in
 * bananaaboy/Sondra): eine Woche ab Montag, Tage als `YYYY-MM-DD`, Uhrzeiten als
 * `HH:MM` der Wanduhr, Serien nur mit selbst eingetragenem Sendetag (nie geschätzt)
 * und nur, solange sie geschaut werden, dazu eigene Termine mit Wiederholung,
 * Notiz und Erinnerung.
 *
 * Unterschied zu Sondra: Einträge und Sendetage liegen hier in `kalender.json`
 * im Datenordner von Sondra AD, und erinnert wird vom Hintergrunddienst – also
 * auch bei geschlossenem Fenster und auf einem Server.
 */

import fs from 'node:fs'
import path from 'node:path'

const pad = (n) => String(n).padStart(2, '0')

export function formatYmd(year, month, day) {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`
}

export function parseYmd(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? ''))
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const check = new Date(Date.UTC(y, m - 1, d))
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d ? { y, m, d } : null
}

export function addDays(ymd, n) {
  const parts = parseYmd(ymd)
  if (!parts) return ymd
  const moved = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + n))
  return formatYmd(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate())
}

/** 0 = Montag … 6 = Sonntag. */
export function weekdayOf(ymd) {
  const parts = parseYmd(ymd)
  if (!parts) return 0
  return (new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay() + 6) % 7
}

export function todayYmd(now = new Date()) {
  return formatYmd(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

export const isTime = (text) => typeof text === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(text)

export function startsAt(ymd, time) {
  const parts = parseYmd(ymd)
  const [hours, minutes] = isTime(time) ? time.split(':').map(Number) : [0, 0]
  return parts ? new Date(parts.y, parts.m - 1, parts.d, hours, minutes) : new Date(NaN)
}

export function occursOn(event, ymd) {
  if (ymd < event.date) return false
  if (event.repeat === 'daily') return true
  if (event.repeat === 'weekly') return weekdayOf(ymd) === weekdayOf(event.date)
  return ymd === event.date
}

const airsOn = (series, ymd) =>
  Boolean(series.airing) && (series.status ?? 'watching') === 'watching' && series.airing.weekday === weekdayOf(ymd)

export function itemsOn(ymd, events, series) {
  const own = events
    .filter((event) => occursOn(event, ymd))
    .map((event) => ({
      key: `event:${event.id}`,
      kind: 'event',
      id: event.id,
      title: event.title,
      date: ymd,
      ...(event.time ? { time: event.time } : {}),
      ...(event.endTime ? { endTime: event.endTime } : {}),
      ...(event.note ? { note: event.note } : {}),
      ...(event.remind !== undefined ? { remind: event.remind } : {}),
      repeat: event.repeat,
    }))
  const airing = series
    .filter((entry) => airsOn(entry, ymd))
    .map((entry) => ({
      key: `series:${entry.id}`,
      kind: 'series',
      id: entry.id,
      title: entry.title,
      date: ymd,
      ...(entry.airing?.time ? { time: entry.airing.time } : {}),
      ...(entry.airing?.remind !== undefined ? { remind: entry.airing.remind } : {}),
    }))
  return [...own, ...airing].sort(
    (a, b) => (a.time ?? '').localeCompare(b.time ?? '') || a.title.localeCompare(b.title, 'de'),
  )
}

export const REMIND_GRACE_MS = 30 * 60_000

/** Fällige, noch nicht gemeldete Erinnerungen – wie `dueReminders` in Sondra. */
export function dueReminders(now, events, series, told) {
  const today = todayYmd(now)
  const due = []
  for (const ymd of [addDays(today, -1), today, addDays(today, 1)]) {
    for (const item of itemsOn(ymd, events, series)) {
      if (item.remind === undefined || !isTime(item.time)) continue
      const key = `${item.key}@${ymd}`
      if (told[key] !== undefined) continue
      const at = startsAt(ymd, item.time)
      const from = at.getTime() - item.remind * 60_000
      if (now.getTime() < from || now.getTime() > at.getTime() + REMIND_GRACE_MS) continue
      due.push({
        key,
        title: item.kind === 'series' ? `Heute: ${item.title}` : item.title,
        body:
          item.remind === 0 || now.getTime() >= at.getTime()
            ? `Jetzt, ${item.time} Uhr`
            : `Um ${item.time} Uhr${item.remind >= 60 ? '' : `, in ${Math.max(1, Math.round((at.getTime() - now.getTime()) / 60_000))} Min.`}`,
        at: at.getTime(),
      })
    }
  }
  return due.sort((a, b) => a.at - b.at)
}

export const EVENTS_MAX = 500

export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw
  const title = typeof entry.title === 'string' ? entry.title.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 120) : ''
  if (!title || typeof entry.date !== 'string' || !parseYmd(entry.date)) return null
  const time = isTime(entry.time) ? entry.time : undefined
  const endTime = time && isTime(entry.endTime) && entry.endTime > time ? entry.endTime : undefined
  const repeat = entry.repeat === 'daily' || entry.repeat === 'weekly' ? entry.repeat : 'none'
  const note = typeof entry.note === 'string' ? entry.note.replace(/[\x00-\x08\x0b-\x1f]/g, ' ').trim().slice(0, 500) : ''
  return {
    id:
      typeof entry.id === 'string' && entry.id
        ? entry.id.slice(0, 60)
        : `kal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    date: entry.date,
    ...(time ? { time } : {}),
    ...(endTime ? { endTime } : {}),
    repeat,
    ...(note ? { note } : {}),
    ...(time &&
    typeof entry.remind === 'number' &&
    Number.isInteger(entry.remind) &&
    entry.remind >= 0 &&
    entry.remind <= 7 * 1440
      ? { remind: entry.remind }
      : {}),
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
  }
}

/** Sendetag einer Serie, wie `normalizeAiring` in Sondra (0 = Montag). */
export function normalizeAiring(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const { weekday, time, remind } = raw
  if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return undefined
  const clock = isTime(time) ? time : undefined
  return {
    weekday,
    ...(clock ? { time: clock } : {}),
    ...(clock && typeof remind === 'number' && Number.isInteger(remind) && remind >= 0 && remind <= 7 * 1440
      ? { remind }
      : {}),
  }
}

const DAY_MS = 24 * 60 * 60_000

export function createCalendarStore({ dataDir, store }) {
  const file = path.join(dataDir, 'kalender.json')
  let state = { events: [], airing: {}, told: {}, migrated: false }

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    state = {
      events: Array.isArray(parsed?.events)
        ? parsed.events.map(normalizeEvent).filter(Boolean).slice(0, EVENTS_MAX)
        : [],
      airing: Object.fromEntries(
        Object.entries(parsed?.airing && typeof parsed.airing === 'object' ? parsed.airing : {})
          .map(([id, a]) => [id, normalizeAiring(a)])
          .filter(([, a]) => a),
      ),
      told: parsed?.told && typeof parsed.told === 'object' ? parsed.told : {},
      migrated: Boolean(parsed?.migrated),
    }
  } catch {}

  const save = () => {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
      fs.renameSync(tmp, file)
    } catch {}
  }
  const changed = () => {
    save()
    store.events.emit('change', { type: 'calendar' })
  }

  // Einmalig: der fest eingestellte „Ausstrahlungstag“ des alten Wochenplans
  // (JavaScript-Zählung, 0 = Sonntag) wird zum Sendetag des Kalenders (0 = Montag).
  // Geschätzte Tage werden bewusst nicht übernommen – Sondra schätzt nie.
  if (!state.migrated) {
    const overrides = store.getConfig().seriesOverrides || {}
    for (const [id, ov] of Object.entries(overrides)) {
      const old = ov?.airDay
      if (typeof old === 'number' && Number.isInteger(old) && old >= 0 && old <= 6 && !state.airing[id]) {
        state.airing[id] = { weekday: (old + 6) % 7 }
      }
    }
    state.migrated = true
    save()
  }

  function seriesList() {
    return store.getMerkItems().map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status ?? 'watching',
      ...(state.airing[item.id] ? { airing: state.airing[item.id] } : {}),
    }))
  }

  function snapshot() {
    return { events: state.events.map((e) => ({ ...e })), airing: { ...state.airing } }
  }

  function saveEvent(raw) {
    const entry = normalizeEvent({ ...raw, updatedAt: Date.now() })
    if (!entry) return null
    const others = state.events.filter((existing) => existing.id !== entry.id)
    if (others.length >= EVENTS_MAX) return null
    state.events = [...others, entry]
    changed()
    return entry
  }

  function deleteEvent(id) {
    const before = state.events.length
    state.events = state.events.filter((entry) => entry.id !== id)
    if (state.events.length !== before) changed()
  }

  function setAiring(seriesId, raw) {
    const id = String(seriesId || '')
    if (!id) return null
    const airing = raw ? normalizeAiring(raw) : undefined
    if (raw && !airing) return null
    if (airing) state.airing[id] = airing
    else delete state.airing[id]
    changed()
    return airing ?? null
  }

  /** Eine Runde: meldet fällige Erinnerungen einmal je Termin-Vorkommen. */
  function takeDueReminders(now = new Date()) {
    const nowMs = now.getTime()
    state.told = Object.fromEntries(Object.entries(state.told).filter(([, at]) => typeof at === 'number' && nowMs - at < 7 * DAY_MS))
    const due = dueReminders(now, state.events, seriesList(), state.told)
    if (due.length === 0) return []
    for (const entry of due) state.told[entry.key] = nowMs
    save()
    return due
  }

  return { snapshot, seriesList, saveEvent, deleteEvent, setAiring, takeDueReminders }
}
