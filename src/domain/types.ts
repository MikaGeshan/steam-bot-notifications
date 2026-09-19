export type Currency = string

export interface Money {
  amountMinor: number
  currency: Currency
}

export interface GameSummary {
  id: string
  title: string
  type: 'game' | 'dlc' | 'bundle' | 'unknown'
  steamAppId: string | null
  itadId: string | null
  platforms: string[]
  genres: string[]
}

export interface Deal {
  game: GameSummary
  shop: string
  country: string
  current: Money
  regular: Money
  cutPercent: number
  historicalLow: Money | null
  historicalLowAt: string | null
  url: string
  source: string
  updatedAt: string
  voucher: boolean
}

export interface WishlistRule {
  maxPriceMinor: number | null
  minCutPercent: number | null
  historicalLowOnly: boolean
}

export interface WishlistItem {
  id: string
  userId: string
  game: GameSummary
  active: boolean
  rule: WishlistRule
  createdAt: string
}

export interface PlaytimeSnapshot {
  gameId: string
  title: string
  cumulativeMinutes: number
  capturedAt: string
}

export interface WeeklyPlaytime {
  totalMinutes: number
  activeGames: number
  coverageDays: number
  topGames: Array<{ gameId: string; title: string; minutes: number }>
}

export interface RecommendationCandidate {
  game: GameSummary
  deal: Deal | null
  popularity: number
}

export interface Recommendation {
  game: GameSummary
  score: number
  reasons: string[]
  deal: Deal | null
}
