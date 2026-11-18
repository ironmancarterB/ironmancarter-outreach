// Customizable UGC email templates. {{variables}} are filled only from researched facts, your settings or a
// deal you recorded; a variable that cannot be filled stays in the text, and the pitch checks block it.
// The signature ("Best,\nCarter" by default) and the compliance footer are always added separately.
import { all, get, logActivity, nowIso, run, type DB } from '../db'
import { AppError, invalid, notFound } from '../core/errors'

import { DEFAULT_TEMPLATES, type TemplateKind } from './templateDefaults'

export { DEFAULT_TEMPLATES, type TemplateKind }

export interface EmailTemplate {
  slug: string
  campaign_type: 'sponsorship' | 'ugc'
  kind: TemplateKind
  name: string
  subject: string | null
  body: string
  default_subject: string | null
  default_body: string
  sort_order: number
  updated_at: string
}

export const listTemplates = (db: DB) => all<EmailTemplate>(db, 'SELECT * FROM email_templates ORDER BY sort_order')

export function getTemplate(db: DB, slug: string) {
  const t = get<EmailTemplate>(db, 'SELECT * FROM email_templates WHERE slug = ?', slug)
  if (!t) throw notFound('Template')
  return t
}

const KNOWN_VARS = new Set(['greeting', 'company', 'brand_line', 'concepts', 'portfolio_line', 'original_date', 'concept_short', 'contact_name',
  'deliverables', 'price_1', 'price_3', 'price_5', 'price_monthly', 'revisions'])

export function updateTemplate(db: DB, slug: string, input: { subject?: unknown; body?: unknown; reset?: unknown }) {
  const t = getTemplate(db, slug)
  if (input.reset === true) {
    run(db, 'UPDATE email_templates SET subject = default_subject, body = default_body, updated_at = ? WHERE slug = ?', nowIso(), slug)
    logActivity(db, 'template.reset', `Reset the "${t.name}" template to its default`)
    return getTemplate(db, slug)
  }
  const body = input.body === undefined ? t.body : String(input.body ?? '').replace(/\r\n/g, '\n').trim()
  const subject = input.subject === undefined ? t.subject : String(input.subject ?? '').trim() || null
  if (!body) throw invalid('A template cannot be empty')
  if (body.length > 3000) throw invalid('Keep templates under 3,000 characters')
  if (t.kind === 'initial' && !subject) throw invalid('A first email needs a subject')
  const unknown = [...`${subject ?? ''}\n${body}`.matchAll(/\{\{\s*([a-z_0-9]+)\s*\}\}/gi)].map((m) => m[1]).filter((v) => !KNOWN_VARS.has(v))
  if (unknown.length) throw new AppError(400, 'unknown_variable', `Unknown variable(s): ${[...new Set(unknown)].map((v) => `{{${v}}}`).join(', ')}. Available: ${[...KNOWN_VARS].map((v) => `{{${v}}}`).join(', ')}`)
  run(db, 'UPDATE email_templates SET subject = ?, body = ?, updated_at = ? WHERE slug = ?', subject, body, nowIso(), slug)
  logActivity(db, 'template.updated', `Edited the "${t.name}" template`)
  return getTemplate(db, slug)
}

// Fills {{variables}}. A variable whose value is an empty string removes its line (or paragraph) cleanly;
// a variable with no value at all (undefined) is left in place so the checks catch it.
export function renderTemplate(text: string, vars: Record<string, string | undefined>) {
  const out = text.replace(/\{\{\s*([a-z_0-9]+)\s*\}\}/gi, (whole, name: string) => {
    const v = vars[name]
    return v === undefined ? whole : v
  })
  return out
    .split('\n').map((l) => l.replace(/[ \t]+$/g, '').replace(/ {2,}/g, ' ')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
