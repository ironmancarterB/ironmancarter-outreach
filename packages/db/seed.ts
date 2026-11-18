// Default rows inserted on first run. INSERT OR IGNORE keeps any later edits made in the app.
import { normalizeDomain } from '../core/normalize'
import { BRAND_SEEDS } from './brandSeeds'
import { UGC_CATEGORIES, UGC_DEFAULT_SETTINGS, UGC_SEEDS } from '../ugc/seeds'
import { DEFAULT_TEMPLATES } from '../ugc/templateDefaults'
import { get, nowIso, run, tx, type DB } from './sql'

export const BUSINESS_EMAIL = 'ironmancarterbusiness@gmail.com'

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  'business.creatorName': 'IronmanCarter',
  'business.handle': 'ironmancarterttv',
  'business.email': BUSINESS_EMAIL,
  // Sign-off on every outbound sponsorship email. The compliance footer goes separately below it.
  'business.signature': 'Best,\nCarter',
  // Required in the footer of commercial email (CAN-SPAM) before live sending can be enabled.
  'business.postalAddress': '',
  'business.revenueGoalMonthlyUsd': 30000,
  'business.sponsorshipMilestonesUsd': [1000, 3000, 5000, 10000],

  // Outreach is locked down by default. Live sending is off until you enable it through the activation step.
  'outreach.mode': 'research_only',
  'outreach.autopilotEnabled': false,
  'outreach.liveSendingEnabled': false,
  'outreach.sendingTier': 'testing',
  'outreach.businessHours': { timezone: 'America/Los_Angeles', start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
  'outreach.followUps': { enabled: false, firstAfterBusinessDays: 5, secondAfterBusinessDays: 12, max: 2 },
  'outreach.researchFreshnessDays': 90,
  'outreach.autoEligibleJurisdictions': ['US'],
  // Safety ceilings for manual sending (never targets; unused capacity is never filled automatically).
  // Days skipped when counting business days for follow-ups (YYYY-MM-DD).
  'outreach.holidays': [],
  'outreach.dailyLimits': { newPerDay: 10, followUpsPerDay: 5, totalPerDay: 15 },
  // Autopilot (automatic sending). Switched on only through Outreach Controls; new first emails are hard-capped at 5 a day.
  'outreach.autopilot': { dryRun: true, newPerDay: 5, sendGapMinutes: 20, syncEveryMinutes: 15, maxErrorsPerDay: 3, maxBouncesPerWeek: 2 },
  'outreach.autopilotPause': { reason: null, at: null },
  // STOP ALL OUTREACH. While active, no send can start.
  'outreach.emergencyStop': { active: false, at: null, reason: null },

  'gmail.expectedAccount': BUSINESS_EMAIL,

  // $0 by default: mock provider, paid AI off, zero budget, no automatic fallback.
  'ai.provider': 'mock',
  'ai.paidEnabled': false,
  'ai.monthlyBudgetUsd': 0,
  'ai.ollama': { baseUrl: 'http://127.0.0.1:11434', model: 'gemma4:12b' },
  'ai.anthropic': { routineModel: 'claude-haiku-5-5', premiumModel: 'claude-sonnet-5-5' },
  'ai.cacheTtlDays': 30,

  // Polite research defaults: one request per site every 1.5 s, a few sites at a time.
  'research.maxPagesPerSite': 8,
  'research.requestDelayMs': 1500,
  'research.concurrency': 3,
  'research.useAiForConcepts': true,

  ...UGC_DEFAULT_SETTINGS,
}

export const CATEGORIES = [
  { slug: 'gaming-peripherals', name: 'Gaming Peripherals', description: 'Mice, keyboards, headsets, controllers, monitors, chairs, mousepads and accessories.' },
  { slug: 'pc-hardware', name: 'PC Hardware', description: 'Gaming PCs, GPUs, CPUs, components, cooling, storage, memory.' },
  { slug: 'gaming-software', name: 'Gaming Software', description: 'Companion apps, game analytics, streaming utilities and gaming tools.' },
  { slug: 'ai-tools', name: 'AI Tools and Applications', description: 'AI assistants, video and image generators, creative AI and AI productivity software.' },
  { slug: 'creator-software', name: 'Creator Software', description: 'Video editing, streaming software, thumbnails, creator analytics and automation.' },
  { slug: 'productivity-tech', name: 'Productivity and Technology', description: 'Productivity software, tech accessories, utilities, digital services and subscriptions.' },
  {
    slug: 'energy-drinks', name: 'Energy Drinks and Gaming Beverages',
    description: 'Energy drinks, gaming beverages, sports drinks and hydration brands with documented creator or esports programs.',
    compliance_note: 'Age-appropriate partnerships only. No campaigns aimed at minors and no unsupported health or performance claims.',
  },
  {
    slug: 'vpn-privacy', name: 'VPN and Digital Privacy', description: 'VPN providers, privacy software, cybersecurity and internet protection.',
    compliance_note: 'No unsupported claims about anonymity, privacy guarantees or security.',
  },
]

export const SENDING_TIERS = [
  { slug: 'testing', name: 'Testing', daily: 5, weekly: 25 },
  { slug: 'initial_launch', name: 'Initial Launch', daily: 15, weekly: 75 },
  { slug: 'expansion', name: 'Expansion', daily: 25, weekly: 125 },
  { slug: 'established', name: 'Established', daily: 40, weekly: 200 },
]

const PACKAGE_NOTE = 'Exploratory range, not a guaranteed market rate. Usage rights, paid ads, whitelisting and exclusivity are never included unless quoted separately.'

export const PACKAGES = [
  { slug: 'single-short', name: 'Single Sponsored Short', deliverables: 'one sponsored short-form video on YouTube Shorts, Instagram Reels or TikTok', min: 50000, max: 75000, unit: 'flat', recurring: false },
  { slug: 'three-video', name: 'Three-Video Campaign', deliverables: 'three sponsored short-form videos across platforms', min: 135000, max: 200000, unit: 'flat', recurring: false },
  { slug: 'monthly', name: 'Monthly Partnership', deliverables: 'recurring short-form integrations each month', min: 200000, max: 300000, unit: 'per_month', recurring: true },
  { slug: 'three-month', name: 'Three-Month Partnership', deliverables: 'three months of recurring content with custom deliverables', min: null, max: null, unit: 'custom', recurring: true },
]

type Metric = {
  platform: string; key: string; label: string; value: number; unit?: string; approx?: boolean
  period?: string; start?: string; end?: string; asOf: string; source: string; notes?: string
}

const KIT = 'Media kit (2026)'
const BRIEF = 'October 2026 analytics brief'
const KIT_PERIOD = { start: '2026-08-01', end: '2026-10-29' }

// Figures supplied by IronmanCarter. Never invent or adjust these; edit them in Settings → Creator analytics.
export const CREATOR_METRICS: Metric[] = [
  { platform: 'instagram', key: 'followers', label: 'Followers', value: 6575, asOf: '2026-10-29', source: KIT, notes: 'The October brief listed approximately 6,522 at an earlier date.' },
  { platform: 'instagram', key: 'views_90d', label: 'Views', value: 7933413, period: '90 days', ...KIT_PERIOD, asOf: '2026-10-29', source: KIT },
  { platform: 'instagram', key: 'views_30d', label: 'Views', value: 2906664, period: '30 days', asOf: '2026-10-29', source: BRIEF },
  { platform: 'instagram', key: 'interactions_90d', label: 'Interactions', value: 537095, approx: true, period: '90 days', ...KIT_PERIOD, asOf: '2026-10-29', source: KIT },
  { platform: 'instagram', key: 'net_followers_90d', label: 'Net follower growth', value: 1507, period: '90 days', ...KIT_PERIOD, asOf: '2026-10-29', source: KIT },
  { platform: 'instagram', key: 'non_follower_views_90d', label: 'Views from non-followers', value: 98.5, unit: 'percent', period: '90 days', ...KIT_PERIOD, asOf: '2026-10-29', source: KIT },
  { platform: 'instagram', key: 'audience_18_34', label: 'Audience ages 18–34', value: 84.7, unit: 'percent', asOf: '2026-10-29', source: KIT },
  { platform: 'instagram', key: 'audience_male', label: 'Male audience', value: 88.7, unit: 'percent', asOf: '2026-10-29', source: KIT },
  { platform: 'instagram', key: 'audience_us', label: 'United States audience', value: 18.9, unit: 'percent', asOf: '2026-10', source: BRIEF },
  { platform: 'youtube', key: 'subscribers', label: 'Subscribers', value: 2078, approx: true, asOf: '2026-10-29', source: KIT },
  { platform: 'youtube', key: 'views_90d', label: 'Views', value: 4188116, period: '90 days', ...KIT_PERIOD, asOf: '2026-10-29', source: KIT },
  { platform: 'youtube', key: 'views_28d', label: 'Views', value: 1602221, period: '28 days', asOf: '2026-10-29', source: BRIEF },
  { platform: 'youtube', key: 'watch_hours_90d', label: 'Watch hours', value: 17900, unit: 'hours', approx: true, period: '90 days', asOf: '2026-10', source: BRIEF },
  { platform: 'youtube', key: 'audience_18_34', label: 'Audience ages 18–34', value: 81.8, unit: 'percent', asOf: '2026-10-29', source: KIT },
  { platform: 'youtube', key: 'audience_male', label: 'Male audience', value: 95.9, unit: 'percent', asOf: '2026-10-29', source: KIT },
  { platform: 'tiktok', key: 'followers', label: 'Followers', value: 4370, approx: true, asOf: '2026-10-29', source: KIT },
  { platform: 'tiktok', key: 'post_views_60d', label: 'Post views', value: 476900, approx: true, period: '60 days', asOf: '2026-10', source: BRIEF },
  { platform: 'tiktok', key: 'likes_60d', label: 'Likes', value: 30800, approx: true, period: '60 days', asOf: '2026-10', source: BRIEF },
  { platform: 'tiktok', key: 'shares_60d', label: 'Shares', value: 6900, approx: true, period: '60 days', asOf: '2026-10', source: BRIEF },
  { platform: 'tiktok', key: 'audience_male', label: 'Male audience', value: 80, unit: 'percent', approx: true, asOf: '2026-10', source: BRIEF },
  { platform: 'twitch', key: 'followers', label: 'Followers', value: 1223, approx: true, asOf: '2026-10-29', source: KIT },
  { platform: 'twitch', key: 'avg_viewers_30d', label: 'Average concurrent viewers', value: 6.6, unit: 'average', period: '30 days', asOf: '2026-10', source: BRIEF },
  { platform: 'twitch', key: 'hours_streamed_30d', label: 'Hours streamed', value: 69, unit: 'hours', approx: true, period: '30 days', asOf: '2026-10', source: BRIEF },
  {
    platform: 'combined', key: 'ig_yt_views_90d', label: 'Instagram + YouTube views', value: 12121529, period: '90 days', ...KIT_PERIOD,
    asOf: '2026-10-29', source: KIT, notes: 'Sum of platform-reported views. Not deduplicated unique viewers.',
  },
]

export function seed(db: DB) {
  const now = nowIso()
  tx(db, () => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      run(db, 'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)', key, JSON.stringify(value), now)
    }
    CATEGORIES.forEach((c, i) => {
      run(db, `INSERT OR IGNORE INTO categories (slug, name, description, compliance_note, sort_order) VALUES (?, ?, ?, ?, ?)`,
        c.slug, c.name, c.description, c.compliance_note ?? null, i + 1)
    })
    SENDING_TIERS.forEach((t, i) => {
      run(db, 'INSERT OR IGNORE INTO sending_tiers (slug, name, daily_limit, weekly_limit, sort_order) VALUES (?, ?, ?, ?, ?)',
        t.slug, t.name, t.daily, t.weekly, i + 1)
    })
    for (const m of CREATOR_METRICS) {
      run(db, `INSERT OR IGNORE INTO creator_metrics
        (platform, metric_key, label, value, unit, approximate, period_label, period_start, period_end, as_of, source, notes, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.platform, m.key, m.label, m.value, m.unit ?? 'count', m.approx ? 1 : 0, m.period ?? null, m.start ?? null,
        m.end ?? null, m.asOf, m.source, m.notes ?? null, now)
    }
    // Packages exist from migration 003 onward. Exploratory ranges from the brief, not market rates.
    if (get(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sponsorship_packages'")) {
      PACKAGES.forEach((p, i) => {
        run(db, `INSERT OR IGNORE INTO sponsorship_packages (slug, name, deliverables, price_min_cents, price_max_cents, price_unit, recurring, sort_order, notes, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, p.slug, p.name, p.deliverables, p.min, p.max, p.unit, p.recurring ? 1 : 0, i + 1, PACKAGE_NOTE, now)
      })
    }
    // UGC campaign (migration 009): its own categories, candidates and templates. A domain already in the
    // sponsorship pool is skipped by INSERT OR IGNORE, so no company is seeded into both campaigns.
    const hasUgc = !!get(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'email_templates'")
    if (hasUgc) {
      UGC_CATEGORIES.forEach((c, i) => {
        run(db, `INSERT OR IGNORE INTO categories (slug, name, description, priority, sort_order, campaign_type) VALUES (?, ?, ?, ?, ?, 'ugc')`,
          c.slug, c.name, c.description, c.priority, 100 + i)
      })
      for (const t of DEFAULT_TEMPLATES) {
        run(db, `INSERT OR IGNORE INTO email_templates (slug, campaign_type, kind, name, subject, body, default_subject, default_body, sort_order, updated_at)
          VALUES (?, 'ugc', ?, ?, ?, ?, ?, ?, ?, ?)`, t.slug, t.kind, t.name, t.subject, t.body, t.subject, t.body, t.sort_order, now)
      }
    }
    // The candidate pool only exists from migration 002 onward.
    if (get(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'candidate_pool'")) {
      for (const [slug, brands] of Object.entries(hasUgc ? { ...BRAND_SEEDS, ...UGC_SEEDS } : BRAND_SEEDS)) {
        const cat = get<{ id: number }>(db, 'SELECT id FROM categories WHERE slug = ?', slug)
        if (!cat) continue
        for (const [name, website] of brands) {
          const domain = normalizeDomain(website)
          if (!domain) continue
          run(db, `INSERT OR IGNORE INTO candidate_pool (company_name, website, domain, category_id, origin, added_at, updated_at)
            VALUES (?, ?, ?, ?, 'seed', ?, ?)`, name, website, domain, cat.id, now, now)
        }
      }
    }
  })
}
