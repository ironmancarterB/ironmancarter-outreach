import { describe, expect, it } from 'vitest'
import { detectSignals, pageSignals, rankLinks } from '../packages/research/evidence'
import { classifyEmail, extractPage } from '../packages/research/extract'
import { createFetcher } from '../packages/research/fetcher'
import { isAllowed, parseRobots } from '../packages/research/robots'
import { scoreResearch } from '../packages/research/score'
import { BRAND_SEEDS } from '../packages/db/brandSeeds'
import { CATEGORIES } from '../packages/db/seed'
import { normalizeDomain } from '../packages/core/normalize'
import { fakeWeb, html } from './fakeWeb'

describe('robots.txt', () => {
  const txt = `User-agent: *\nDisallow: /private\nAllow: /private/press\nDisallow: /*.pdf$\n\nUser-agent: OtherBot\nDisallow: /`
  const rules = parseRobots(txt, 'IronmanCarterOutreachResearch')
  it('applies the * group, longest match wins, Allow wins ties', () => {
    expect(isAllowed(rules, '/')).toBe(true)
    expect(isAllowed(rules, '/private/team')).toBe(false)
    expect(isAllowed(rules, '/private/press/kit')).toBe(true)
    expect(isAllowed(rules, '/media/kit.pdf')).toBe(false)
    expect(isAllowed(rules, '/media/kit.pdf?x=1')).toBe(true)
  })
  it('uses a group that names our agent instead of *', () => {
    const mine = parseRobots('User-agent: *\nDisallow:\n\nUser-agent: ironmancarteroutreachresearch\nDisallow: /', 'IronmanCarterOutreachResearch')
    expect(isAllowed(mine, '/anything')).toBe(false)
  })
})

describe('polite fetcher', () => {
  const quiet = { sleep: async () => {}, delayMs: 0 }

  it('never requests a page robots.txt disallows', async () => {
    const web = fakeWeb({ 'https://brand.test/robots.txt': 'User-agent: *\nDisallow: /partners', 'https://brand.test/partners': html('P', 'secret') })
    const f = createFetcher({ fetchImpl: web.fetchImpl, ...quiet })
    const r = await f.get('https://brand.test/partners')
    expect(r.outcome).toBe('robots_disallowed')
    expect(web.calls).toEqual(['https://brand.test/robots.txt'])
  })

  it('treats an unreachable robots.txt (5xx) as "do not crawl", and a missing one (404) as allowed', async () => {
    const down = fakeWeb({ 'https://down.test/robots.txt': { status: 503 }, 'https://down.test/': html('D', 'x') })
    expect((await createFetcher({ fetchImpl: down.fetchImpl, ...quiet }).get('https://down.test/')).outcome).toBe('robots_disallowed')
    const none = fakeWeb({ 'https://open.test/': html('O', 'x') })
    expect((await createFetcher({ fetchImpl: none.fetchImpl, ...quiet }).get('https://open.test/')).outcome).toBe('ok')
  })

  it('checks robots.txt again after a redirect to another site', async () => {
    const web = fakeWeb({
      'https://old.test/': { status: 301, location: 'https://new.test/home' },
      'https://new.test/robots.txt': 'User-agent: *\nDisallow: /',
    })
    const r = await createFetcher({ fetchImpl: web.fetchImpl, ...quiet }).get('https://old.test/')
    expect(r.outcome).toBe('robots_disallowed')
    expect(web.calls).not.toContain('https://new.test/home')
  })

  it('waits between requests to the same site', async () => {
    const waits: number[] = []
    let t = 0
    const web = fakeWeb({ 'https://brand.test/': html('B', 'x'), 'https://brand.test/a': html('A', 'x') })
    const f = createFetcher({ fetchImpl: web.fetchImpl, delayMs: 1500, now: () => t, sleep: async (ms) => { waits.push(ms); t += ms } })
    await f.get('https://brand.test/')
    await f.get('https://brand.test/a')
    expect(waits.every((w) => w <= 1500)).toBe(true)
    expect(waits.length).toBeGreaterThanOrEqual(2) // robots → home → page, each spaced
  })

  it('skips non-HTML and oversized responses', async () => {
    const web = fakeWeb({ 'https://b.test/kit.pdf': { body: '%PDF', type: 'application/pdf' }, 'https://b.test/big': 'x'.repeat(5000) })
    const f = createFetcher({ fetchImpl: web.fetchImpl, ...quiet, maxBytes: 1000 })
    expect((await f.get('https://b.test/kit.pdf')).outcome).toBe('not_html')
    expect((await f.get('https://b.test/big')).outcome).toBe('too_large')
  })
})

describe('page extraction', () => {
  const page = extractPage(html('Brand &amp; Co', `
    <nav><a href="/creators">Creator Program</a> <a href="https://other.test/x">Elsewhere</a> <a href="mailto:Partnerships@Brand.test?subject=Hi">Email</a></nav>
    <p>Reach press@brand.test. Logo: logo@2x.png</p>
    <script>var hidden = "nope@brand.test"</script>
    <form><input type="email" name="email"><textarea></textarea></form>`, 'We make mice'), 'https://brand.test/')
  it('reads title, description, links and published emails', () => {
    expect(page.title).toBe('Brand & Co')
    expect(page.description).toBe('We make mice')
    expect(page.links.map((l) => l.url)).toEqual(['https://brand.test/creators', 'https://other.test/x'])
    expect(page.emails.sort()).toEqual(['partnerships@brand.test', 'press@brand.test'])
    expect(page.hasContactForm).toBe(true)
  })
  it('decodes typographic entities in titles', () => {
    expect(extractPage(html('Affiliate Application &ndash; G FUEL&trade;', ''), 'https://b.test/').title).toBe('Affiliate Application – G FUEL™')
  })

  it('does not mistake a newsletter sign-up for a contact form', () => {
    const newsletter = extractPage(html('N', '<form><input type="email" name="email"><button type="submit">Join</button></form>'), 'https://b.test/')
    const contact = extractPage(html('C', '<form><input name="name"><input type="email" name="email"><input name="company"></form>'), 'https://b.test/')
    expect(newsletter.hasContactForm).toBe(false)
    expect(contact.hasContactForm).toBe(true)
  })

  it('ranks partnership pages above contact pages and ignores other sites', () => {
    const ranked = rankLinks([
      { url: 'https://brand.test/contact', text: 'Contact' },
      { url: 'https://brand.test/affiliates', text: 'Affiliates' },
      { url: 'https://other.test/partners', text: 'Partners' },
      { url: 'https://brand.test/shop', text: 'Shop' },
    ], (u) => normalizeDomain(u) === 'brand.test')
    expect(ranked).toEqual(['https://brand.test/affiliates', 'https://brand.test/contact'])
  })
})

describe('email classification', () => {
  it.each([
    ['partnerships@brand.test', 'role', 1],
    ['creators@brand.test', 'role', 2],
    ['press@eu.brand.test', 'role', 3],
    ['hello@brand.test', 'role', 4],
  ])('%s is a %s mailbox (rank %d)', (email, kind, rank) => {
    expect(classifyEmail(email, 'brand.test')).toMatchObject({ kind, rank })
  })
  it('never keeps personal, support or other-domain addresses', () => {
    expect(classifyEmail('jane.doe@brand.test', 'brand.test').kind).toBe('personal')
    expect(classifyEmail('jdoe@brand.test', 'brand.test').kind).toBe('personal')
    expect(classifyEmail('support@brand.test', 'brand.test').kind).toBe('excluded')
    expect(classifyEmail('privacy@brand.test', 'brand.test').kind).toBe('excluded')
    expect(classifyEmail('partnerships@gmail.com', 'brand.test').kind).toBe('free_mail')
    expect(classifyEmail('partnerships@other.test', 'brand.test').kind).toBe('off_domain')
  })
})

describe('evidence and scoring', () => {
  it('detects creator-partnership signals with the supporting sentence', () => {
    const f = detectSignals('Welcome. Join our Creator Program and earn with every sale. We sponsor the best gamers.', 'https://b.test/creators')
    expect(f.find((x) => x.signal === 'creator_program')).toMatchObject({ url: 'https://b.test/creators', snippet: expect.stringContaining('Creator Program') })
    expect(f.some((x) => x.signal === 'gaming_audience')).toBe(true)
  })

  it('ignores navigation menus for evidence and treats dedicated program pages as evidence', () => {
    const p = extractPage(html('Home', '<nav><a href="/creator-program">Creator Program</a></nav><main><p>Shop mice.</p></main>'), 'https://b.test/')
    expect(detectSignals(p.mainText, 'https://b.test/').some((f) => f.signal === 'creator_program')).toBe(false)
    expect(pageSignals('https://b.test/en-us/programs/creator-program', 'Creator Program')).toEqual([
      { signal: 'creator_program', url: 'https://b.test/en-us/programs/creator-program', snippet: 'Dedicated page on the brand\'s site: "Creator Program"' },
    ])
  })

  it('spends the page budget across directories instead of many similar profile pages', () => {
    const links = ['bubba', 'suellio', 'other'].map((n) => ({ url: `https://b.test/en/discover/ambassadors/${n}`, text: n }))
    links.push({ url: 'https://b.test/en/contact', text: 'Contact' })
    expect(rankLinks(links, () => true)).toEqual(['https://b.test/en/discover/ambassadors/bubba', 'https://b.test/en/contact'])
  })

  it('quotes whole words around a match', () => {
    const [f] = detectSignals('Lots of words here before. We run an affiliate program for streamers and creators worldwide.', 'https://b.test/a')
    expect(f.snippet).toBe('We run an affiliate program for streamers and creators worldwide.')
  })

  it('scores higher with published evidence and a partnerships mailbox, and explains why', () => {
    const strong = scoreResearch({ categorySlug: 'gaming-peripherals', categoryName: 'Gaming Peripherals', signals: new Set(['creator_program', 'affiliate_program', 'gaming_audience', 'streaming_audience']), bestEmailRank: 1, hasContactForm: false })
    const weak = scoreResearch({ categorySlug: 'productivity-tech', categoryName: 'Productivity and Technology', signals: new Set(), bestEmailRank: null, hasContactForm: false })
    expect(strong.score).toBeGreaterThanOrEqual(80)
    expect(weak.score).toBeLessThan(60)
    expect(strong.explanation).toMatch(/creator program, affiliate program/)
    expect(strong.explanation).toMatch(/Verified business email/)
    expect(weak.explanation).toMatch(/No published evidence/)
    expect(weak.explanation).toMatch(/No published business contact/)
  })
})

describe('starter candidate list', () => {
  const all = Object.entries(BRAND_SEEDS).flatMap(([slug, list]) => list.map(([name, url]) => ({ slug, name, url, domain: normalizeDomain(url) })))
  it('covers all eight categories with valid, unique official domains and no contact details', () => {
    expect(Object.keys(BRAND_SEEDS).sort()).toEqual(CATEGORIES.map((c) => c.slug).sort())
    expect(all.length).toBeGreaterThan(150)
    expect(all.every((s) => s.domain)).toBe(true)
    expect(new Set(all.map((s) => s.domain)).size).toBe(all.length)
    expect(JSON.stringify(BRAND_SEEDS)).not.toMatch(/@/)
  })
})
