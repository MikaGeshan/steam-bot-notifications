import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../src/config'

describe('configuration', () => {
  test('defaults to mock providers outside production', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).useMockProviders).toBe(true)
  })

  test('fails fast when production secrets are missing', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', USE_MOCK_PROVIDERS: 'false' }))
      .toThrow('Missing production configuration')
  })

  test('requires Telegram credentials when real providers are enabled', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      USE_MOCK_PROVIDERS: 'false',
      DATABASE_URL: 'postgres://example',
      INTERNAL_API_KEY: 'internal',
      ADMIN_API_KEY: 'admin',
      LINK_TOKEN_SECRET: 'link-secret',
      DATA_ENCRYPTION_KEY: 'encryption-secret',
      STEAM_WEB_API_KEY: 'steam',
      ITAD_API_KEY: 'itad',
    })).toThrow('TELEGRAM_BOT_TOKEN')
  })
})
