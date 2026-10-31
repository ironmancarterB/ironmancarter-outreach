// Which settings the dashboard may change, how each is validated, and which are locked in this phase.
import { AppError, invalid } from '../../../packages/core/errors'
import { normalizeEmail } from '../../../packages/core/normalize'
import { ANTHROPIC_PRICES } from '../../../packages/ai/pricing'

type Validator = (v: unknown) => unknown

const bool: Validator = (v) => {
  if (typeof v !== 'boolean') throw invalid('Expected true or false')
  return v
}
const num = (min: number, max: number): Validator => (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw invalid(`Expected a number from ${min} to ${max}`)
  return v
}
const str = (max: number, allowEmpty = true): Validator => (v) => {
  if (typeof v !== 'string') throw invalid('Expected text')
  const s = v.trim()
  if (!allowEmpty && !s) throw invalid('Cannot be empty')
  if (s.length > max) throw invalid(`Too long (max ${max})`)
  return s
}
const email: Validator = (v) => {
  const e = normalizeEmail(typeof v === 'string' ? v : null)
  if (!e) throw invalid('Not a valid email address')
  return e
}
const time = (v: unknown, field: string) => {
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw invalid(`${field} must be HH:MM`)
  return v
}
const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}
const obj = (v: unknown) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('Expected an object')
  return v as Record<string, unknown>
}

// Locked settings and the reason shown when someone tries to change them.
export const LOCKED: Record<string, string> = {
  'outreach.autopilotEnabled': 'Autopilot (automatic sending) is not authorized. Every email is sent by you, one at a time.',
  'outreach.liveSendingEnabled': 'Live sending is switched on only through the activation step in Outreach Controls, after its checklist passes and you confirm it.',
  'outreach.mode': 'The operating mode is fixed; sending is manual only.',
  'outreach.sendingTier': 'Sending tiers change only with your explicit approval.',
  'outreach.emergencyStop': 'Use the STOP ALL OUTREACH and Resume controls in Outreach Controls.',
}

export const VALIDATORS: Record<string, Validator> = {
  'business.creatorName': str(80, false),
  'business.handle': str(80, false),
  'business.email': email,
  'business.signature': (v) => {
    const s = (str(200, false)(v) as string).replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim()
    if (s.split('\n').length > 6) throw invalid('Keep the signature to 6 lines or fewer')
    if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(s) && !/ironmancarterbusiness@gmail\.com/i.test(s)) throw invalid('The signature may only contain your own business email')
    return s
  },
  'business.postalAddress': str(300),
  'business.revenueGoalMonthlyUsd': num(0, 10_000_000),
  'business.sponsorshipMilestonesUsd': (v) => {
    if (!Array.isArray(v) || !v.length || v.length > 10) throw invalid('Expected 1 to 10 amounts')
    return v.map((x) => num(0, 10_000_000)(x) as number).sort((a, b) => a - b)
  },
  'gmail.expectedAccount': email,
  'outreach.businessHours': (v) => {
    const o = obj(v)
    if (typeof o.timezone !== 'string' || !isTimeZone(o.timezone)) throw invalid('Unknown time zone')
    const start = time(o.start, 'Start'), end = time(o.end, 'End')
    if (start >= end) throw invalid('Start must be before end')
    if (!Array.isArray(o.days) || !o.days.length || o.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw invalid('Days must be 0 (Sun) to 6 (Sat)')
    return { timezone: o.timezone, start, end, days: [...new Set(o.days as number[])].sort() }
  },
  'outreach.followUps': (v) => {
    const o = obj(v)
    if (o.enabled === true) throw new AppError(409, 'locked', 'Automatic follow-up sending is not authorized. Follow-ups wait in the queue for your review and manual send.')
    const first = num(1, 30)(o.firstAfterBusinessDays) as number
    const second = num(1, 60)(o.secondAfterBusinessDays) as number
    if (second <= first) throw invalid('The second follow-up must come after the first')
    const max = num(0, 2)(o.max) as number
    return { enabled: false, firstAfterBusinessDays: first, secondAfterBusinessDays: second, max: Math.round(max) }
  },
  'outreach.researchFreshnessDays': num(1, 365),
  'outreach.holidays': (v) => {
    if (!Array.isArray(v) || v.length > 100 || v.some((d) => typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d))) throw invalid('Expected up to 100 dates (YYYY-MM-DD)')
    return [...new Set(v as string[])].sort()
  },
  'outreach.dailyLimits': (v) => {
    const o = obj(v)
    const newPerDay = num(0, 50)(o.newPerDay) as number
    const followUpsPerDay = num(0, 25)(o.followUpsPerDay) as number
    const totalPerDay = num(0, 75)(o.totalPerDay) as number
    return { newPerDay: Math.round(newPerDay), followUpsPerDay: Math.round(followUpsPerDay), totalPerDay: Math.round(totalPerDay) }
  },
  'outreach.autoEligibleJurisdictions': (v) => {
    if (!Array.isArray(v) || v.some((j) => typeof j !== 'string' || !/^[A-Za-z]{2}$/.test(j))) throw invalid('Expected 2-letter country codes')
    return [...new Set((v as string[]).map((j) => j.toUpperCase()))]
  },
  'ai.provider': (v) => {
    if (v === 'anthropic') throw new AppError(409, 'locked', 'The paid Anthropic API needs your approval, verified pricing and a budget before it can be selected.')
    if (v !== 'mock' && v !== 'ollama') throw invalid('Provider must be mock or ollama')
    return v
  },
  'ai.paidEnabled': (v) => {
    if (bool(v) === true) throw new AppError(409, 'locked', 'Paid AI stays off until you approve it, prices are verified and the integration is installed.')
    return false
  },
  'ai.monthlyBudgetUsd': num(0, 1000),
  'ai.ollama': (v) => {
    const o = obj(v)
    const baseUrl = str(200, false)(o.baseUrl) as string
    let host = ''
    try {
      host = new URL(baseUrl).hostname
    } catch {
      throw invalid('Ollama URL is not valid')
    }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw invalid('Ollama must run on this computer (localhost)')
    return { baseUrl, model: str(100, false)(o.model) }
  },
  'ai.anthropic': (v) => {
    const o = obj(v)
    for (const k of ['routineModel', 'premiumModel']) {
      if (typeof o[k] !== 'string' || !Object.hasOwn(ANTHROPIC_PRICES, o[k] as string)) throw invalid(`${k} must be one of ${Object.keys(ANTHROPIC_PRICES).join(', ')}`)
    }
    return { routineModel: o.routineModel, premiumModel: o.premiumModel }
  },
  'ai.cacheTtlDays': num(1, 365),
  'research.maxPagesPerSite': num(2, 15),
  'research.requestDelayMs': num(1000, 10_000),
  'research.concurrency': num(1, 5),
  'research.useAiForConcepts': bool,
}

export function validateSetting(key: string, value: unknown): unknown {
  if (LOCKED[key]) throw new AppError(409, 'locked', LOCKED[key])
  const v = VALIDATORS[key]
  if (!v) throw invalid(`Unknown or read-only setting: ${key}`)
  try {
    return v(value)
  } catch (err) {
    if (err instanceof AppError) {
      err.message = `${key}: ${err.message}`
      throw err
    }
    throw err
  }
}
