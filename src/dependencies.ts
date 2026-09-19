import { loadConfig, type AppConfig } from './config'
import { createDatabase, type Database } from './db/client'
import { createCipher, hmacSha256 } from './lib/crypto'
import { createLogger, type Logger } from './lib/logger'
import { ItadPriceProvider } from './integrations/pricing/itad'
import { MockPriceProvider } from './integrations/pricing/mock'
import { MockSteamProvider } from './integrations/steam/mock'
import { SteamWebProvider } from './integrations/steam/steam'
import { TelegramBotProvider } from './integrations/telegram/bot-api'
import { MockMessagingProvider } from './integrations/telegram/mock'
import type { MessagingProvider, PriceProvider, SteamProvider } from './ports'
import { Repository } from './repository'

export interface AppDependencies {
  config: AppConfig
  sql: Database
  repository: Repository
  pricing: PriceProvider
  messaging: MessagingProvider
  steam: SteamProvider
  logger: Logger
  encryptAddress: (value: string) => Promise<string>
  decryptAddress: (value: string) => Promise<string>
  hashAddress: (value: string) => Promise<string>
}

export function createDependencies(overrides: Partial<AppDependencies> = {}): AppDependencies {
  const config = overrides.config ?? loadConfig()
  const sql = overrides.sql ?? createDatabase(config)
  const cipher = createCipher(config.dataEncryptionKey)
  return {
    config,
    sql,
    repository: overrides.repository ?? new Repository(sql),
    pricing:
      overrides.pricing ??
      (config.useMockProviders ? new MockPriceProvider() : new ItadPriceProvider(config.itad.apiKey)),
    messaging:
      overrides.messaging ??
      (config.useMockProviders
        ? new MockMessagingProvider()
        : new TelegramBotProvider(config.telegram)),
    steam:
      overrides.steam ??
      (config.useMockProviders
        ? new MockSteamProvider()
        : new SteamWebProvider(config.steam.apiKey, config.steam.openIdRealm)),
    logger: overrides.logger ?? createLogger(config.logLevel),
    encryptAddress: overrides.encryptAddress ?? cipher.encrypt,
    decryptAddress: overrides.decryptAddress ?? cipher.decrypt,
    hashAddress:
      overrides.hashAddress ??
      ((value) => hmacSha256(config.dataEncryptionKey, `channel-address:${value}`)),
  }
}
