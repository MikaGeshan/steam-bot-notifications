import { describe, expect, test } from 'bun:test'
import type { Deal } from '../../src/domain/types'
import {
  evaluateWishlistRule,
  isQuietHour,
  notificationIdempotencyKey,
} from '../../src/domain/wishlist'

const deal: Deal = {
  game: {
    id: 'game-1', title: 'Hades', type: 'game', steamAppId: '1', itadId: 'itad-1',
    platforms: ['windows'], genres: ['action'],
  },
  shop: 'Steam',
  country: 'ID',
  current: { amountMinor: 80_000, currency: 'IDR' },
  regular: { amountMinor: 160_000, currency: 'IDR' },
  cutPercent: 50,
  historicalLow: { amountMinor: 75_000, currency: 'IDR' },
  historicalLowAt: '2026-01-01T00:00:00.000Z',
  url: 'https://example.test/deal',
  source: 'test',
  updatedAt: '2026-09-15T00:00:00.000Z',
  voucher: false,
}

describe('wishlist rules', () => {
  test('matches exact price and discount boundaries', () => {
    expect(evaluateWishlistRule({
      maxPriceMinor: 80_000,
      minCutPercent: 50,
      historicalLowOnly: false,
    }, deal)).toEqual({ matched: true, reasons: ['max_price', 'minimum_discount'] })
  })

  test('does not claim historical low when current price is higher or history missing', () => {
    expect(evaluateWishlistRule({
      maxPriceMinor: null,
      minCutPercent: null,
      historicalLowOnly: true,
    }, deal)).toEqual({ matched: false, reasons: [] })
    expect(evaluateWishlistRule({
      maxPriceMinor: null,
      minCutPercent: null,
      historicalLowOnly: true,
    }, { ...deal, historicalLow: null })).toEqual({ matched: false, reasons: [] })
  })

  test('builds stable idempotency keys for the same price event', () => {
    expect(notificationIdempotencyKey('user-1', deal)).toBe(
      notificationIdempotencyKey('user-1', { ...deal, updatedAt: '2027-01-01T00:00:00Z' }),
    )
  })

  test('handles quiet hours that cross midnight', () => {
    expect(isQuietHour(new Date('2026-09-15T16:00:00Z'), 'Asia/Jakarta', 22, 8)).toBe(true)
    expect(isQuietHour(new Date('2026-09-15T05:00:00Z'), 'Asia/Jakarta', 22, 8)).toBe(false)
  })
})
