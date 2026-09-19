import { describe, expect, test } from 'bun:test'
import { addMoney, assertMoney, formatMoney } from '../../src/domain/money'

describe('money', () => {
  test('formats IDR minor units without implicit decimal conversion', () => {
    expect(formatMoney({ amountMinor: 359_400, currency: 'IDR' })).toContain('359.400')
  })

  test('adds values with the same currency', () => {
    expect(addMoney([
      { amountMinor: 10_000, currency: 'IDR' },
      { amountMinor: 5_000, currency: 'IDR' },
    ])).toEqual({ amountMinor: 15_000, currency: 'IDR' })
  })

  test('rejects cross-currency aggregation', () => {
    expect(() => addMoney([
      { amountMinor: 10_000, currency: 'IDR' },
      { amountMinor: 500, currency: 'USD' },
    ])).toThrow('different currencies')
  })

  test('rejects floating point and negative minor units', () => {
    expect(() => assertMoney({ amountMinor: 10.5, currency: 'IDR' })).toThrow()
    expect(() => assertMoney({ amountMinor: -1, currency: 'IDR' })).toThrow()
    expect(() => assertMoney({ amountMinor: 1, currency: 'idr' })).toThrow()
  })
})
