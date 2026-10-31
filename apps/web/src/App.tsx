import { useEffect, useState } from 'react'
import { cx } from './components/ui'
import { useRoute } from './lib/router'
import Overview from './pages/Overview'
import Discovery from './pages/Discovery'
import Prospects from './pages/Prospects'
import Autopilot from './pages/Autopilot'
import { Drafts, FollowUps, ReplyInbox, SentEmails } from './pages/Upcoming'
import Deals from './pages/Deals'
import Revenue from './pages/Revenue'
import MediaKitPage from './pages/MediaKit'
import Settings from './pages/Settings'

const NAV = [
  { id: 'overview', label: 'Overview', icon: '◎' },
  { id: 'discovery', label: 'Brand Discovery', icon: '⌕' },
  { id: 'prospects', label: 'Prospects', icon: '▤' },
  { id: 'autopilot', label: 'Outreach Autopilot', icon: '⏻' },
  { id: 'drafts', label: 'Email Drafts', icon: '✎' },
  { id: 'sent', label: 'Sent Emails', icon: '➤' },
  { id: 'replies', label: 'Reply Inbox', icon: '✉' },
  { id: 'follow-ups', label: 'Follow-ups', icon: '↻' },
  { id: 'deals', label: 'Deals', icon: '◆' },
  { id: 'revenue', label: 'Revenue Analytics', icon: '▲' },
  { id: 'media-kit', label: 'Media Kit', icon: '▣' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
] as const

type Theme = 'system' | 'light' | 'dark'

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('theme')
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches))
    apply()
    try {
      if (theme === 'system') localStorage.removeItem('theme')
      else localStorage.setItem('theme', theme)
    } catch { /* storage unavailable: theme still applies for this visit */ }
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
  return [theme, setTheme] as const
}

export default function App() {
  const { page, parts } = useRoute()
  const [theme, setTheme] = useTheme()
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => setMenuOpen(false), [page])

  const content = (() => {
    switch (page) {
      case 'discovery': return <Discovery />
      case 'prospects': return <Prospects openId={parts[0] ? Number(parts[0]) : null} />
      case 'autopilot': return <Autopilot />
      case 'drafts': return <Drafts />
      case 'sent': return <SentEmails />
      case 'replies': return <ReplyInbox />
      case 'follow-ups': return <FollowUps />
      case 'deals': return <Deals />
      case 'revenue': return <Revenue />
      case 'media-kit': return <MediaKitPage />
      case 'settings': return <Settings tab={parts[0]} />
      default: return <Overview />
    }
  })()

  return (
    <div className="min-h-screen lg:flex">
      <aside className={cx('fixed inset-y-0 left-0 z-30 w-64 shrink-0 border-r border-zinc-200 bg-white transition-transform dark:border-zinc-800 dark:bg-zinc-900 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
        menuOpen ? 'translate-x-0' : '-translate-x-full')}>
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2.5 px-5 py-5">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">IC</div>
            <div>
              <div className="text-sm font-semibold leading-tight">IronmanCarter</div>
              <div className="text-xs text-zinc-500">Sponsorship Outreach</div>
            </div>
          </div>
          <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="Main">
            {NAV.map((n) => (
              <a key={n.id} href={`#/${n.id}`}
                className={cx('mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium',
                  page === n.id || (page === '' && n.id === 'overview')
                    ? 'bg-brand-50 text-brand-700 dark:bg-brand-600/15 dark:text-brand-100'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800')}>
                <span className="w-4 text-center text-base leading-none opacity-70" aria-hidden>{n.icon}</span>
                {n.label}
              </a>
            ))}
          </nav>
          <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
            <div className="mb-2 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
              <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden /> No email sending in this build
            </div>
            <div className="flex rounded-lg bg-zinc-100 p-0.5 text-xs dark:bg-zinc-800" role="group" aria-label="Theme">
              {(['light', 'system', 'dark'] as const).map((t) => (
                <button key={t} onClick={() => setTheme(t)}
                  className={cx('flex-1 rounded-md px-2 py-1 capitalize', theme === t ? 'bg-white shadow-sm dark:bg-zinc-700' : 'text-zinc-500')}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>
      </aside>
      {menuOpen && <div className="fixed inset-0 z-20 bg-zinc-950/30 lg:hidden" onClick={() => setMenuOpen(false)} />}
      <div className="min-w-0 flex-1">
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-zinc-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden dark:border-zinc-800 dark:bg-zinc-900/90">
          <button onClick={() => setMenuOpen(true)} className="rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700" aria-label="Open menu">☰</button>
          <span className="text-sm font-semibold">IronmanCarter Outreach</span>
        </div>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{content}</main>
      </div>
    </div>
  )
}
