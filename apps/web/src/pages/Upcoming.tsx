// Screens whose machinery arrives in later phases. They show real (currently empty) state, not mock data.
import type { ReactNode } from 'react'
import { Badge, Card, Empty, ErrorBox, Loading, PageHeader } from '../components/ui'
import { useApi } from '../lib/api'
import type { ProspectListItem } from '../lib/types'
import { stageLabel } from '../../../../packages/core/stages'

function PhaseNote({ phase, children }: { phase: string; children: ReactNode }) {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <Badge tone="violet">{phase}</Badge>
        <div className="text-sm text-zinc-600 dark:text-zinc-400">{children}</div>
      </div>
    </Card>
  )
}

export function Drafts() {
  return (
    <>
      <PageHeader title="Email Drafts" subtitle="Personalized pitches waiting for your review." />
      <div className="space-y-4">
        <PhaseNote phase="Phase 3">AI-personalized drafts (100–150 words, using only verified research and your recorded analytics) appear here with a preview, the media kit attachment, and approve/reject controls.</PhaseNote>
        <Empty title="No drafts">Nothing has been drafted.</Empty>
      </div>
    </>
  )
}

export function SentEmails() {
  return (
    <>
      <PageHeader title="Sent Emails" subtitle="Every message sent, with its Gmail thread and the media kit version attached." />
      <div className="space-y-4">
        <PhaseNote phase="Phase 5">Sending is not built yet. This build contains no email-sending code, so nothing can be sent.</PhaseNote>
        <Empty title="No sent emails">0 emails have been sent.</Empty>
      </div>
    </>
  )
}

export function ReplyInbox() {
  return (
    <>
      <PageHeader title="Reply Inbox" subtitle="Replies to outreach threads, classified for you." />
      <div className="space-y-4">
        <PhaseNote phase="Phase 4">After Gmail is connected (read-only plus drafts), replies are matched to outreach threads and classified: interested, wants pricing, wants media kit, wants a meeting, needs info, not interested, opt-out, out-of-office or unclear. Suggested replies always wait for your approval.</PhaseNote>
        <Empty title="No replies">Gmail is not connected.</Empty>
      </div>
    </>
  )
}

export function FollowUps() {
  const { data, error } = useApi<ProspectListItem[]>('/api/prospects?sort=updated')
  const reminders = (data ?? []).filter((p) => p.next_follow_up_date).sort((a, b) => a.next_follow_up_date!.localeCompare(b.next_follow_up_date!))
  const today = new Date().toISOString().slice(0, 10)
  return (
    <>
      <PageHeader title="Follow-ups" subtitle="Manual reminders now; automatic follow-ups after sending exists and you enable them." />
      <div className="space-y-4">
        <PhaseNote phase="Phase 5">Automatic follow-ups (default 5 and 12 business days, maximum two) re-check the Gmail thread, opt-outs, negotiations, eligibility and sending limits before every send, and are cancelled by any reply.</PhaseNote>
        {error ? <ErrorBox error={error} /> : !data ? <Loading /> : reminders.length === 0 ? (
          <Empty title="No reminders">Set a follow-up reminder date in a company's Deal section.</Empty>
        ) : (
          <Card title="Reminders" padded={false}>
            <ul>
              {reminders.map((p) => (
                <li key={p.id} className="flex items-center justify-between border-b border-zinc-100 px-5 py-3 text-sm last:border-0 dark:border-zinc-800">
                  <a href={`#/prospects/${p.id}`} className="font-medium hover:underline">{p.company_name}</a>
                  <span className="flex items-center gap-2">
                    <Badge>{stageLabel(p.stage)}</Badge>
                    <Badge tone={p.next_follow_up_date! < today ? 'red' : p.next_follow_up_date === today ? 'amber' : 'gray'}>{p.next_follow_up_date}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  )
}
