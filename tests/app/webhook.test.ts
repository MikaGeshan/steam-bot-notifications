import { describe, expect, test } from 'bun:test'
import { createApp } from '../../src/app'
import { loadConfig } from '../../src/config'
import type { AppDependencies } from '../../src/dependencies'
import type { Database } from '../../src/db/client'
import { createLogger } from '../../src/lib/logger'
import { MockPriceProvider } from '../../src/integrations/pricing/mock'
import { MockSteamProvider } from '../../src/integrations/steam/mock'
import { TelegramBotProvider } from '../../src/integrations/telegram/bot-api'
import type { Repository } from '../../src/repository'

const makeApp = () => {
  const enqueued: unknown[] = []
  const user = {
    id: '11111111-1111-4111-8111-111111111111',
    locale: 'id-ID', country: 'ID', currency: 'IDR', timezone: 'Asia/Jakarta',
    notificationMode: 'instant' as const, quietStart: 22, quietEnd: 8,
    notificationsEnabled: true,
  }
  const game = {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Hades', type: 'game' as const, steamAppId: '1145360', itadId: 'mock-hades',
    platforms: ['windows'], genres: ['action'],
  }
  const config = loadConfig({
    NODE_ENV: 'test',
    USE_MOCK_PROVIDERS: 'false',
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
    INTERNAL_API_KEY: 'internal',
    ADMIN_API_KEY: 'admin',
    LINK_TOKEN_SECRET: 'link-secret',
    DATA_ENCRYPTION_KEY: 'encryption-secret',
  })
  const repository = {
    health: async () => true,
    getOrCreateChannelUser: async () => user,
    getUser: async (id: string) => id === user.id ? user : null,
    updateUserSettings: async () => user,
    setNotifications: async () => undefined,
    requestUserDeletion: async () => undefined,
    persistDeal: async (deal: unknown) => deal,
    getGame: async () => game,
    listWishlist: async () => [],
    addWishlist: async () => '22222222-2222-4222-8222-222222222222',
    updateWishlist: async () => true,
    deleteWishlist: async () => true,
    weeklyPlaytime: async () => ({ totalMinutes: 0, activeGames: 0, coverageDays: 0, topGames: [] }),
    librarySummary: async () => ({ ownedGames: 0, playedGames: 0, unplayedGames: 0, totalMinutes: 0, topGames: [] }),
    purchaseSummary: async () => ({ totals: [], ownedGames: 0, coveragePercent: 0, disclaimer: 'not for sale' }),
    addPurchase: async () => '33333333-3333-4333-8333-333333333333',
    deletePurchase: async () => true,
    recommendationData: async () => ({
      genreWeights: { action: 1 }, platforms: ['windows'], excludedGameIds: new Set(),
      candidates: [{ game, deal: null, popularity: 1 }],
    }),
    setRecommendationFeedback: async () => undefined,
    createSteamLinkToken: async () => undefined,
    jobStats: async () => ({ pending: 0 }),
    recordProviderMessageAndEnqueue: async (...args: unknown[]) => {
      enqueued.push(args)
      return true
    },
    insertProviderEvent: async () => true,
  } as unknown as Repository
  const messaging = new TelegramBotProvider({
    botToken: 'test-bot-token',
    webhookSecret: 'webhook-secret',
  })
  const deps: AppDependencies = {
    config,
    sql: {} as Database,
    repository,
    pricing: new MockPriceProvider(),
    messaging,
    steam: new MockSteamProvider(),
    logger: createLogger('error'),
    encryptAddress: async () => 'encrypted-value',
    decryptAddress: async () => '620000000001',
    hashAddress: async () => 'address-hash',
  }
  return { app: createApp(deps), enqueued }
}

describe('Telegram webhook routes', () => {
  const authHeaders = {
    'x-api-key': 'internal',
    'x-user-id': '11111111-1111-4111-8111-111111111111',
  }

  test('rejects an invalid webhook secret before side effects', async () => {
    const { app, enqueued } = makeApp()
    const response = await app.handle(new Request('http://localhost/webhooks/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'wrong-secret',
      },
      body: '{"update_id":1}',
    }))
    expect(response.status).toBe(401)
    expect(enqueued).toHaveLength(0)
  })

  test('accepts a valid raw body and enqueues a sanitized message', async () => {
    const { app, enqueued } = makeApp()
    const raw = JSON.stringify({
      update_id: 101,
      message: {
        message_id: 9,
        date: 1789459200,
        chat: { id: 620000000001, type: 'private' },
        from: { id: 620000000001, is_bot: false },
        text: '/diskon Hades',
      },
    })
    const response = await app.handle(new Request('http://localhost/webhooks/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'webhook-secret',
      },
      body: raw,
    }))
    expect(response.status).toBe(200)
    expect(enqueued).toHaveLength(1)
    expect(JSON.stringify(enqueued[0])).not.toContain('620000000001')
    expect(JSON.stringify(enqueued[0])).toContain('encrypted-value')
  })

  test('rejects non-JSON and oversized declared payloads', async () => {
    const { app } = makeApp()
    const wrongType = await app.handle(new Request('http://localhost/webhooks/telegram', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello',
    }))
    expect(wrongType.status).toBe(415)

    const oversized = await app.handle(new Request('http://localhost/webhooks/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '1000001' },
      body: '{}',
    }))
    expect(oversized.status).toBe(413)
  })

  test('serves health and protects internal/user/admin APIs', async () => {
    const { app } = makeApp()
    expect((await app.handle(new Request('http://localhost/health/live'))).status).toBe(200)
    expect((await app.handle(new Request('http://localhost/health/ready'))).status).toBe(200)
    expect((await app.handle(new Request('http://localhost/v1/me'))).status).toBe(401)
    expect((await app.handle(new Request('http://localhost/admin/jobs'))).status).toBe(401)

    const admin = await app.handle(new Request('http://localhost/admin/jobs', {
      headers: { 'x-admin-key': 'admin' },
    }))
    expect(admin.status).toBe(200)
    expect(await admin.json()).toEqual({ pending: 0 })
  })

  test('executes authenticated MVP API routes', async () => {
    const { app } = makeApp()
    const me = await app.handle(new Request('http://localhost/v1/me', { headers: authHeaders }))
    expect(me.status).toBe(200)

    const search = await app.handle(new Request('http://localhost/v1/games/search?q=Hades', {
      headers: authHeaders,
    }))
    expect(search.status).toBe(200)
    expect((await search.json()) as unknown[]).toHaveLength(1)

    const price = await app.handle(new Request(
      'http://localhost/v1/games/00000000-0000-4000-8000-000000000001/prices',
      { headers: authHeaders },
    ))
    expect(price.status).toBe(200)

    const wishlist = await app.handle(new Request('http://localhost/v1/wishlist', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: '00000000-0000-4000-8000-000000000001' }),
    }))
    expect(wishlist.status).toBe(201)

    const wishlistId = '22222222-2222-4222-8222-222222222222'
    const updated = await app.handle(new Request(`http://localhost/v1/wishlist/${wishlistId}`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ active: false }),
    }))
    expect(updated.status).toBe(200)
    expect((await app.handle(new Request(`http://localhost/v1/wishlist/${wishlistId}`, {
      method: 'DELETE', headers: authHeaders,
    }))).status).toBe(204)

    expect((await app.handle(new Request('http://localhost/v1/stats/weekly', { headers: authHeaders }))).status).toBe(200)
    expect((await app.handle(new Request('http://localhost/v1/stats/library', { headers: authHeaders }))).status).toBe(200)
    expect((await app.handle(new Request('http://localhost/v1/purchases', { headers: authHeaders }))).status).toBe(200)
    expect((await app.handle(new Request('http://localhost/v1/recommendations', { headers: authHeaders }))).status).toBe(200)
    expect((await app.handle(new Request('http://localhost/v1/steam/link', {
      method: 'POST', headers: authHeaders,
    }))).status).toBe(200)
  })

  test('validates API request schemas', async () => {
    const { app } = makeApp()
    const invalid = await app.handle(new Request('http://localhost/v1/wishlist', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: 'not-a-uuid' }),
    }))
    expect(invalid.status).toBe(422)
  })
})
