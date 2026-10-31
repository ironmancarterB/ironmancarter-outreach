import { describe, expect, it } from 'vitest'
import { nameKey, normalizeDomain, normalizeEmail, normalizeUrl } from '../packages/core/normalize'
import { fitTier, scoreFit } from '../packages/core/scoring'

describe('domain normalization (deduplication key)', () => {
  it.each([
    ['https://www.Logitech.com/en-us/products', 'logitech.com'],
    ['logitechg.com', 'logitechg.com'],
    ['http://shop.razer.com:8080', 'razer.com'],
    ['partnerships@corsair.com', 'corsair.com'],
    ['https://store.example.co.uk/x', 'example.co.uk'],
    ['WWW.NORDVPN.COM.', 'nordvpn.com'],
  ])('%s → %s', (input, out) => expect(normalizeDomain(input)).toBe(out))

  it.each(['', '   ', 'not a domain', 'http://localhost', null])('rejects %s', (input) => expect(normalizeDomain(input)).toBeNull())
})

describe('email normalization', () => {
  it('lowercases and strips mailto', () => expect(normalizeEmail(' mailto:Partners@Brand.COM ')).toBe('partners@brand.com'))
  it('rejects invalid addresses', () => {
    for (const bad of ['brand.com', 'a@b', '@brand.com', 'two@@brand.com', '']) expect(normalizeEmail(bad)).toBeNull()
  })
})

describe('company name keys', () => {
  it('treats legal suffixes and punctuation as equal', () => {
    expect(nameKey('Logitech, Inc.')).toBe(nameKey('logitech'))
    expect(nameKey('HyperX Gaming LLC')).toBe(nameKey('HyperX'))
    expect(nameKey('Monster Energy')).not.toBe(nameKey('Red Bull'))
  })
})

describe('urls', () => {
  it('adds https and rejects non-web schemes', () => {
    expect(normalizeUrl('brand.com/partners')).toBe('https://brand.com/partners')
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
  })
})

describe('fit scoring', () => {
  it('sums weighted factors and assigns tiers', () => {
    const s = scoreFit({ audience: 22, evidence: 20, recurring: 16, product: 12, contact: 8, integration: 4 })
    expect(s).toBe(82)
    expect(fitTier(s)).toBe('A')
    expect(fitTier(60)).toBe('B')
    expect(fitTier(59)).toBe('C')
    expect(fitTier(null)).toBeNull()
  })
  it('rejects points above a factor maximum', () => {
    expect(() => scoreFit({ audience: 26 })).toThrow(/between 0 and 25/)
    expect(() => scoreFit({ contact: -1 })).toThrow()
  })
})
