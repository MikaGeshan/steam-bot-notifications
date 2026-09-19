import type { Deal, GameSummary } from './domain/types'

export interface SearchDealsInput {
  query: string
  country: string
  currency: string
  limit?: number
}

export interface PriceProvider {
  readonly name: string
  searchDeals(input: SearchDealsInput): Promise<Deal[]>
  getDeal(game: GameSummary, country: string, currency: string): Promise<Deal | null>
}

export interface IncomingMessage {
  eventId: string
  address: string
  text: string
  timestamp: string
  interactionId?: string
}

export interface ParsedMessagingWebhook {
  messages: IncomingMessage[]
}

export interface MessagingProvider {
  readonly name: string
  verifyWebhook(secret: string | null): Promise<boolean>
  parseWebhook(payload: unknown): ParsedMessagingWebhook
  acknowledgeInteraction(interactionId: string): Promise<void>
  sendText(to: string, text: string): Promise<{ providerMessageId: string }>
}

export interface SteamOwnedGame {
  appId: string
  name: string
  playtimeMinutes: number
  playtimeTwoWeeksMinutes: number | null
}

export interface SteamProvider {
  buildLoginUrl(returnTo: string): string
  verifyOpenId(params: URLSearchParams, expectedReturnTo: string): Promise<string>
  getOwnedGames(steamId: string): Promise<SteamOwnedGame[]>
}
