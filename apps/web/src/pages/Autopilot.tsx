import { Badge, Card, ErrorBox, Loading, Notice, PageHeader, Stat } from '../components/ui'
import { useApi } from '../lib/api'
import type { Overview } from '../lib/types'

type Tiers = { tiers: { slug: string; name: string; daily_limit: number; weekly_limit: number }[]; active: string }

export default function Autopilot() {
  const ov = useApi<Overview>('/api/overview')
  const tiers = useApi<Tiers>('/api/tiers')
  const settings = useApi<{ values: Record<string, unknown> }>('/api/settings')
  if (ov.error) return <ErrorBox error={ov.error} />
  if (!ov.data || !tiers.data || !settings.data) return <Loading />
  const o = ov.data.outreach
  const gmail = String(settings.data.values['gmail.expectedAccount'])
  const address = String(settings.data.values['business.postalAddress'] ?? '')
  const enabledCats = ov.data.categories.filter((c) => c.enabled)

  return (
    <>
      <PageHeader title="Outreach Autopilot" subtitle="Control center for automated sending. Everything here is off and locked in Phase 1." />
      <div className="space-y-6">
        <Notice tone="green" title="Autopilot is OFF. Live sending is disabled.">
          This build contains no email-sending code. The ENABLE OUTREACH AUTOPILOT control, its confirmation screen and the PAUSE ALL OUTREACH button arrive in Phase 5,
          after the initial approval gate: 20 researched companies, reviewed drafts, Gmail draft and reply tests, a simulated campaign, and your explicit approval.
        </Notice>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Operating mode" value="Research only" hint="Draft & Review: Phase 3 · Autopilot: Phase 5" />
          <Stat label="Connected Gmail" value="None" hint={`Will only accept ${gmail}`} tone="muted" />
          <Stat label="Active tier" value={o.tier.name} hint={`${o.tier.daily_limit}/day · ${o.tier.weekly_limit}/week max`} />
          <Stat label="Eligible contacts" value={ov.data.prospects.verifiedAvailable} hint={`${ov.data.prospects.needsReview} need review`} />
          <Stat label="Scheduled messages" value={0} />
          <Stat label="Follow-ups" value="Off" hint="Enabled separately (Phase 5)" tone="muted" />
          <Stat label="Last Gmail sync" value="Never" tone="muted" />
          <Stat label="Enabled categories" value={`${enabledCats.length} of ${ov.data.categories.length}`} />
        </div>

        <Card title="Sending tiers (upper bounds, not targets)">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500"><tr><th className="py-1 text-left">Tier</th><th className="text-right">New emails / day</th><th className="text-right">New emails / week</th><th /></tr></thead>
            <tbody>
              {tiers.data.tiers.map((t) => (
                <tr key={t.slug} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-2">{t.name}</td><td className="text-right tabular-nums">{t.daily_limit}</td><td className="text-right tabular-nums">{t.weekly_limit}</td>
                  <td className="text-right">{t.slug === tiers.data!.active && <Badge tone="blue">Active</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-zinc-500">Tiers never increase automatically. Follow-ups count toward limits. Actual volume is also limited by Gmail, the law, eligibility, delivery errors and opt-outs.</p>
        </Card>

        <Card title="Compliance checklist before live sending">
          <ul className="space-y-2 text-sm">
            <li>{address ? '✅' : '⚠️'} Postal address for email footers {address ? 'is set' : <>is missing (<a className="text-brand-600 hover:underline" href="#/settings/business">add it</a>)</>}</li>
            <li>{ov.data.mediaKit ? '✅' : '⚠️'} Default media kit {ov.data.mediaKit ? `is v${ov.data.mediaKit.version}` : 'is missing'}</li>
            <li>⏳ Gmail connection and reply-detection tests (Phase 4)</li>
            <li>⏳ Opt-out link and processing, duplicate-send protection, simulated campaign (Phase 5)</li>
            <li>⏳ Your explicit approval of the first campaign</li>
          </ul>
        </Card>
      </div>
    </>
  )
}
