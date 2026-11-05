// Applies the verified-email rules to brands already on record, and prints what qualifies and why the rest do not.
// Safe to run again. Reads DNS (free), marks old research batches, and suppresses addresses that already hard-bounced.
// Never changes a brand, a review decision, a contact or a stage, and never contacts anyone.
import { all, migrate, openDb, run } from '../packages/db'
import { config, dbPath } from '../apps/server/src/config'
import { bouncedRecipient, bounceSeverity, EXCLUSION_LABELS, leadMetrics, listLeads, type ExclusionCode } from '../packages/crm/leads'
import { addSuppression } from '../packages/crm/suppressions'
import { checkDueMailDomains } from '../packages/research/mailDomain'

const db = openDb(dbPath(config.dataDir))
migrate(db)

let checked = 0
for (let n = await checkDueMailDomains(db, { limit: 50 }); n > 0; n = await checkDueMailDomains(db, { limit: 50 })) checked += n

let bounced = 0
for (const m of all<{ gmail_thread_id: string; body_text: string | null }>(db, `SELECT t.gmail_thread_id, m.body_text FROM email_messages m JOIN email_threads t ON t.id = m.thread_id WHERE m.kind = 'bounce'`)) {
  const recipient = bouncedRecipient(db, m.gmail_thread_id)
  if (recipient && bounceSeverity(m.body_text ?? '') === 'permanent') { addSuppression(db, 'email', recipient, 'Hard bounce: the mail server rejected this address', 'bounce'); bounced++ }
}

const leads = listLeads(db)
const byId = new Map(leads.map((l) => [l.id, l]))
for (const c of all<{ id: number; prospect_id: number | null }>(db, "SELECT id, prospect_id FROM research_candidates WHERE status = 'done' AND qualified IS NULL")) {
  const l = c.prospect_id ? byId.get(c.prospect_id) : undefined
  run(db, 'UPDATE research_candidates SET qualified = ?, exclusion_reason = ? WHERE id = ?', l?.has_qualifying_email ? 1 : 0, l?.has_qualifying_email ? null : l?.exclusion?.label ?? 'No longer on record', c.id)
}
run(db, "UPDATE research_candidates SET qualified = 0 WHERE qualified IS NULL AND status IN ('duplicate', 'unreachable', 'blocked', 'failed')")

const metrics = leadMetrics(db)
console.log(`Mail domains checked: ${checked}. Hard bounces found: ${bounced}.`)
console.log('Domain results:', all(db, 'SELECT status, count(*) AS n FROM mail_domains GROUP BY status'))
console.log('Problem domains:', all(db, "SELECT domain, status, detail FROM mail_domains WHERE status != 'ok'"))
console.log({ ...metrics, excluded: undefined })
console.log('\nExcluded, by reason:')
for (const [code, n] of Object.entries(metrics.excluded).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${EXCLUSION_LABELS[code as ExclusionCode]}`)
console.log('\nActionable:')
for (const l of leads.filter((x) => x.actionable)) console.log(`  ${l.company_name.padEnd(22)} ${String(l.email).padEnd(32)} ${String(l.confidence).padEnd(7)} ${l.outreach_status.padEnd(15)} ${l.needs_before_send.join('; ')}`)
console.log('\nHave a qualifying email, excluded for another reason:', leads.filter((x) => !x.actionable && x.has_qualifying_email).length)
const unverifiedWithAddress = leads.filter((x) => x.exclusion?.code === 'unverified_email')
console.log('Only unverified addresses:', unverifiedWithAddress.map((l) => `${l.company_name} (${l.email})`).join(', ') || 'none')
db.close()
