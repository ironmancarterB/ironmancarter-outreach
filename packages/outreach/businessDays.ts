// Business-day arithmetic in your business time zone (Settings → Sending & compliance). Weekends are not
// business days unless you make them so; holidays you list are skipped. No external time-zone library.
import { getSetting, type DB } from '../db'

export interface BusinessCalendar {
  timezone: string
  start: string          // HH:MM local time follow-ups become due
  days: number[]         // 0 = Sunday … 6 = Saturday
  holidays: string[]     // YYYY-MM-DD
}

export function calendar(db: DB): BusinessCalendar {
  const h = getSetting<{ timezone: string; start: string; days: number[] }>(db, 'outreach.businessHours')
  return { timezone: h.timezone, start: h.start, days: h.days, holidays: getSetting<string[]>(db, 'outreach.holidays') }
}

function parts(date: Date, timezone: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]))
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) }
}

// Offset of the time zone from UTC at a given instant, in milliseconds.
const offsetMs = (date: Date, timezone: string) => {
  const p = parts(date, timezone)
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000
}

// The instant when the wall clock in `timezone` shows the given local date and time (handles DST changes).
export function zonedTime(y: number, m: number, d: number, h: number, mi: number, timezone: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi)
  let t = guess - offsetMs(new Date(guess), timezone)
  t = guess - offsetMs(new Date(t), timezone)
  return new Date(t)
}

// Calendar day in the time zone, e.g. for daily sending limits.
export function dayKey(date: Date, timezone: string) {
  const p = parts(date, timezone)
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

const weekday = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay()

export function isBusinessDay(key: string, cal: BusinessCalendar) {
  const [y, m, d] = key.split('-').map(Number)
  return cal.days.includes(weekday(y, m, d)) && !cal.holidays.includes(key)
}

// n business days after the local date of `from`, at the calendar's start time.
export function addBusinessDays(from: Date, n: number, cal: BusinessCalendar): Date {
  if (!cal.days.length) throw new Error('No business days are configured')
  const p = parts(from, cal.timezone)
  let date = new Date(Date.UTC(p.y, p.m - 1, p.d))
  let left = n
  for (let guard = 0; left > 0; guard++) {
    if (guard > 3660) throw new Error('Could not find enough business days')
    date = new Date(date.getTime() + 86_400_000)
    if (isBusinessDay(date.toISOString().slice(0, 10), cal)) left--
  }
  const [h, mi] = cal.start.split(':').map(Number)
  return zonedTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h, mi, cal.timezone)
}
