import type { Deal, GameSummary } from '../../domain/types'
import type { PriceProvider, SearchDealsInput } from '../../ports'

const games: GameSummary[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Hades',
    type: 'game',
    steamAppId: '1145360',
    itadId: 'mock-hades',
    platforms: ['windows', 'macos'],
    genres: ['action', 'roguelike', 'indie'],
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    title: 'Stardew Valley',
    type: 'game',
    steamAppId: '413150',
    itadId: 'mock-stardew-valley',
    platforms: ['windows', 'macos', 'linux'],
    genres: ['simulation', 'rpg', 'indie'],
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    title: 'ELDEN RING',
    type: 'game',
    steamAppId: '1245620',
    itadId: 'mock-elden-ring',
    platforms: ['windows'],
    genres: ['action', 'rpg', 'souls-like'],
  },
]

const priceById: Record<string, { regular: number; current: number; low: number; cut: number }> = {
  '00000000-0000-4000-8000-000000000001': { regular: 169_999, current: 84_999, low: 67_999, cut: 50 },
  '00000000-0000-4000-8000-000000000002': { regular: 115_999, current: 69_599, low: 57_999, cut: 40 },
  '00000000-0000-4000-8000-000000000003': { regular: 599_000, current: 359_400, low: 299_500, cut: 40 },
}

const dealFor = (game: GameSummary, country: string): Deal => {
  const price = priceById[game.id] ?? { regular: 100_000, current: 80_000, low: 70_000, cut: 20 }
  return {
    game,
    shop: 'Steam',
    country,
    current: { amountMinor: price.current, currency: 'IDR' },
    regular: { amountMinor: price.regular, currency: 'IDR' },
    cutPercent: price.cut,
    historicalLow: { amountMinor: price.low, currency: 'IDR' },
    historicalLowAt: '2025-12-21T00:00:00.000Z',
    url: `https://store.steampowered.com/app/${game.steamAppId}`,
    source: 'mock',
    updatedAt: new Date().toISOString(),
    voucher: false,
  }
}

export class MockPriceProvider implements PriceProvider {
  readonly name = 'mock'

  async searchDeals(input: SearchDealsInput) {
    const query = input.query.trim().toLowerCase()
    return games
      .filter((game) => !query || game.title.toLowerCase().includes(query))
      .slice(0, input.limit ?? 5)
      .map((game) => dealFor(game, input.country))
  }

  async getDeal(game: GameSummary, country: string) {
    const match = games.find(
      (item) => item.id === game.id || item.itadId === game.itadId || item.steamAppId === game.steamAppId,
    )
    return match ? dealFor(match, country) : null
  }
}
