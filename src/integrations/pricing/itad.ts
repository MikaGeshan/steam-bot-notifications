import type { Deal, GameSummary } from '../../domain/types'
import { currencyFractionDigits } from '../../domain/money'
import type { PriceProvider, SearchDealsInput } from '../../ports'
import { ProviderError, safeFetch } from '../http'

type ItadGame = {
  id: string
  title: string
  type?: string | null
}

type ItadPrice = {
  id: string
  current?: {
    shop: { name: string }
    price: { amount: number; amountInt: number; currency: string }
    regular: { amount: number; amountInt: number; currency: string }
    cut: number
    voucher?: string | null
    platforms?: Array<{ name: string }>
    timestamp?: string
    url: string
  } | null
  lowest?: {
    price: { amount: number; amountInt: number; currency: string }
    timestamp?: string
  } | null
}

const mapType = (type: string | null | undefined): GameSummary['type'] => {
  if (type === 'game' || type === 'dlc' || type === 'bundle') return type
  return 'unknown'
}

const mapMoney = (price: { amount: number; amountInt: number; currency: string }) => {
  const currency = price.currency.toUpperCase()
  const fractionDigits = currencyFractionDigits(currency)
  const amountMinor = Number.isFinite(price.amount)
    ? Math.round(price.amount * 10 ** fractionDigits)
    : price.amountInt
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new ProviderError('itad', 'invalid_money', 'ITAD returned an invalid price', false)
  }
  return { amountMinor, currency }
}

const dealUrl = (value: string) => {
  const url = new URL(value)
  if (url.protocol !== 'https:') {
    throw new ProviderError('itad', 'invalid_deal_url', 'ITAD returned a non-HTTPS deal URL', false)
  }
  return url.toString()
}

export class ItadPriceProvider implements PriceProvider {
  readonly name = 'itad'
  private readonly origin = 'https://api.isthereanydeal.com'

  constructor(private readonly apiKey: string) {}

  private async request(path: string, init?: RequestInit) {
    if (!this.apiKey) throw new ProviderError(this.name, 'not_configured', 'ITAD API key is missing', false)
    return safeFetch(
      this.name,
      `${this.origin}${path}`,
      {
        ...init,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'ITAD-API-Key': this.apiKey,
          ...init?.headers,
        },
      },
      { allowedHosts: ['api.isthereanydeal.com'], timeoutMs: 8_000, maxBytes: 2_000_000 },
    )
  }

  async searchDeals(input: SearchDealsInput): Promise<Deal[]> {
    const searchResponse = await this.request(
      `/games/search/v1?title=${encodeURIComponent(input.query)}&results=${Math.min(input.limit ?? 5, 20)}`,
    )
    const found = await searchResponse.json() as ItadGame[]
    if (found.length === 0) return []

    const overviewResponse = await this.request(
      `/games/overview/v2?country=${encodeURIComponent(input.country)}&vouchers=true`,
      { method: 'POST', body: JSON.stringify(found.map((game) => game.id)) },
    )
    const overview = await overviewResponse.json() as { prices?: ItadPrice[] }
    const byId = new Map((overview.prices ?? []).map((price) => [price.id, price]))

    return found.flatMap((externalGame): Deal[] => {
      const price = byId.get(externalGame.id)
      if (!price?.current) return []
      const game: GameSummary = {
        id: crypto.randomUUID(),
        title: externalGame.title,
        type: mapType(externalGame.type),
        steamAppId: null,
        itadId: externalGame.id,
        platforms: (price.current.platforms ?? []).map((platform) => platform.name.toLowerCase()),
        genres: [],
      }
      return [{
        game,
        shop: price.current.shop.name,
        country: input.country,
        current: mapMoney(price.current.price),
        regular: mapMoney(price.current.regular),
        cutPercent: price.current.cut,
        historicalLow: price.lowest
          ? mapMoney(price.lowest.price)
          : null,
        historicalLowAt: price.lowest?.timestamp ?? null,
        url: dealUrl(price.current.url),
        source: this.name,
        updatedAt: price.current.timestamp ?? new Date().toISOString(),
        voucher: Boolean(price.current.voucher),
      }]
    })
  }

  async getDeal(game: GameSummary, country: string, currency: string) {
    if (!game.itadId) {
      const matches = await this.searchDeals({ query: game.title, country, currency, limit: 1 })
      return matches[0] ?? null
    }
    const response = await this.request(
      `/games/overview/v2?country=${encodeURIComponent(country)}&vouchers=true`,
      { method: 'POST', body: JSON.stringify([game.itadId]) },
    )
    const overview = await response.json() as { prices?: ItadPrice[] }
    const price = overview.prices?.[0]
    if (!price?.current) return null
    return {
      game,
      shop: price.current.shop.name,
      country,
      current: mapMoney(price.current.price),
      regular: mapMoney(price.current.regular),
      cutPercent: price.current.cut,
      historicalLow: price.lowest
        ? mapMoney(price.lowest.price)
        : null,
      historicalLowAt: price.lowest?.timestamp ?? null,
      url: dealUrl(price.current.url),
      source: this.name,
      updatedAt: price.current.timestamp ?? new Date().toISOString(),
      voucher: Boolean(price.current.voucher),
    }
  }
}
