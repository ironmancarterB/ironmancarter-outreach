import { describe, expect, it } from 'vitest'
import { all, get, getSetting, migrate } from '../packages/db'
import { freshDb } from './helpers'

describe('database foundation', () => {
  it('applies migrations once and is idempotent', () => {
    const db = freshDb()
    expect(migrate(db)).toEqual([])
    expect(all<{ version: number }>(db, 'SELECT version FROM schema_migrations ORDER BY version')).toEqual([{ version: 1 }, { version: 2 }])
  })

  it('seeds safe defaults: no sending, no paid AI, $0 budget', () => {
    const db = freshDb()
    expect(getSetting(db, 'business.email')).toBe('ironmancarterbusiness@gmail.com')
    expect(getSetting(db, 'gmail.expectedAccount')).toBe('ironmancarterbusiness@gmail.com')
    expect(getSetting(db, 'outreach.autopilotEnabled')).toBe(false)
    expect(getSetting(db, 'outreach.liveSendingEnabled')).toBe(false)
    expect(getSetting(db, 'outreach.mode')).toBe('research_only')
    expect(getSetting(db, 'outreach.sendingTier')).toBe('testing')
    expect(getSetting(db, 'ai.provider')).toBe('mock')
    expect(getSetting(db, 'ai.paidEnabled')).toBe(false)
    expect(getSetting(db, 'ai.monthlyBudgetUsd')).toBe(0)
  })

  it('never stores the misspelled business address', () => {
    const db = freshDb()
    const blob = JSON.stringify(all(db, 'SELECT value FROM settings'))
    expect(blob.toLowerCase()).not.toContain('caerter')
  })

  it('seeds eight categories and four sending tiers', () => {
    const db = freshDb()
    expect(all(db, 'SELECT * FROM categories')).toHaveLength(8)
    expect(all<{ slug: string; daily_limit: number; weekly_limit: number }>(db, 'SELECT slug, daily_limit, weekly_limit FROM sending_tiers ORDER BY sort_order'))
      .toEqual([
        { slug: 'testing', daily_limit: 5, weekly_limit: 25 },
        { slug: 'initial_launch', daily_limit: 15, weekly_limit: 75 },
        { slug: 'expansion', daily_limit: 25, weekly_limit: 125 },
        { slug: 'established', daily_limit: 40, weekly_limit: 200 },
      ])
  })

  it('seeds creator analytics exactly as supplied, with periods', () => {
    const db = freshDb()
    const m = (platform: string, key: string) => get<{ value: number; period_label: string | null; period_start: string | null }>(db,
      'SELECT value, period_label, period_start FROM creator_metrics WHERE platform = ? AND metric_key = ?', platform, key)!
    expect(m('instagram', 'views_90d')).toEqual({ value: 7933413, period_label: '90 days', period_start: '2026-08-01' })
    expect(m('instagram', 'views_30d').value).toBe(2906664)
    expect(m('youtube', 'views_90d').value).toBe(4188116)
    expect(m('youtube', 'views_28d').value).toBe(1602221)
    expect(m('youtube', 'audience_male').value).toBe(95.9)
    expect(m('tiktok', 'followers').value).toBe(4370)
    expect(m('twitch', 'avg_viewers_30d').value).toBe(6.6)
    expect(m('combined', 'ig_yt_views_90d').value).toBe(7933413 + 4188116)
  })

  it('keeps edited settings when seeding runs again', async () => {
    const db = freshDb()
    const { setSetting } = await import('../packages/db')
    const { seed } = await import('../packages/db/seed')
    setSetting(db, 'business.creatorName', 'Changed')
    seed(db)
    expect(getSetting(db, 'business.creatorName')).toBe('Changed')
  })
})
