import type { Deal, WishlistRule } from './types'

export type RuleMatch = {
  matched: boolean
  reasons: Array<'max_price' | 'minimum_discount' | 'historical_low'>
}

export function evaluateWishlistRule(rule: WishlistRule, deal: Deal): RuleMatch {
  const reasons: RuleMatch['reasons'] = []

  if (
    rule.maxPriceMinor !== null &&
    deal.current.currency === deal.regular.currency &&
    deal.current.amountMinor <= rule.maxPriceMinor
  ) {
    reasons.push('max_price')
  }

  if (rule.minCutPercent !== null && deal.cutPercent >= rule.minCutPercent) {
    reasons.push('minimum_discount')
  }

  if (
    rule.historicalLowOnly &&
    deal.historicalLow &&
    deal.historicalLow.currency === deal.current.currency &&
    deal.current.amountMinor <= deal.historicalLow.amountMinor
  ) {
    reasons.push('historical_low')
  }

  return { matched: reasons.length > 0, reasons }
}

export function notificationIdempotencyKey(userId: string, deal: Deal) {
  return [
    'wishlist-price',
    userId,
    deal.game.id,
    deal.shop.toLowerCase(),
    deal.country.toUpperCase(),
    deal.current.currency,
    deal.current.amountMinor,
    deal.cutPercent,
  ].join(':')
}

export function isQuietHour(now: Date, timezone: string, startHour = 22, endHour = 8) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '-1')
  if (hour < 0) return false
  if (startHour === endHour) return false
  return startHour > endHour
    ? hour >= startHour || hour < endHour
    : hour >= startHour && hour < endHour
}
