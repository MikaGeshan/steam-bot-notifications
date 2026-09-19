import type { Money } from './types'

const zeroDecimalCurrencies = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'IDR', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
  'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
])

export const currencyFractionDigits = (currency: string) =>
  zeroDecimalCurrencies.has(currency.toUpperCase()) ? 0 : 2

export function assertMoney(money: Money) {
  if (!Number.isSafeInteger(money.amountMinor) || money.amountMinor < 0) {
    throw new Error('Money must use a non-negative safe integer minor unit')
  }
  if (!/^[A-Z]{3}$/.test(money.currency)) throw new Error('Invalid ISO currency code')
  return money
}

export function formatMoney(money: Money, locale = 'id-ID') {
  assertMoney(money)
  const fractionDigits = currencyFractionDigits(money.currency)
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
  return formatter.format(money.amountMinor / 10 ** fractionDigits)
}

export function addMoney(values: Money[]) {
  if (values.length === 0) return null
  const currency = values[0]?.currency
  if (!currency || values.some((value) => value.currency !== currency)) {
    throw new Error('Cannot add different currencies without explicit conversion')
  }
  return assertMoney({
    currency,
    amountMinor: values.reduce((sum, value) => sum + value.amountMinor, 0),
  })
}
