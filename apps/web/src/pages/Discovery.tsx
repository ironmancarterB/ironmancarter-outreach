import { Badge, Card, ErrorBox, Loading, Notice, PageHeader } from '../components/ui'
import { useApi } from '../lib/api'
import type { Overview } from '../lib/types'

export default function Discovery() {
  const { data, error } = useApi<Overview>('/api/overview')
  return (
    <>
      <PageHeader title="Brand Discovery" subtitle="Research batches of 20, 50, 100, 200 or 500 brands across your eight categories." />
      <div className="space-y-6">
        <Notice title="Arrives in Phase 2 (after your approval)">
          Discovery will find official websites, partnership pages and published partnership contacts, record the exact source URL for every fact, score fit, and
          skip anything already in the CRM. It never guesses email formats, never scrapes personal data and never bypasses site restrictions. Contact-form-only brands go
          to a manual queue. Research runs on the free mock or local Ollama provider unless you approve paid AI.
        </Notice>
        <Card title="Categories" actions={<a href="#/settings/categories" className="text-xs font-medium text-brand-600 hover:underline">Manage →</a>}>
          {error ? <ErrorBox error={error} /> : !data ? <Loading /> : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {data.categories.map((c) => (
                <li key={c.id} className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
                  <span>{c.name} {!c.enabled && <Badge>Disabled</Badge>}</span>
                  <span className="tabular-nums text-zinc-500">{c.prospects} in CRM</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  )
}
