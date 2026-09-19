import { openapi } from '@elysiajs/openapi'
import { Elysia, t } from 'elysia'
import type { AppDependencies } from './dependencies'
import { rankRecommendations } from './domain/recommendation'
import { sha256, timingSafeEqualString } from './lib/crypto'

const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
const uuidSchema = t.String({ pattern: uuidPattern })

const errorBody = (code: string, message: string, requestId?: string) => ({
  error: { code, message, ...(requestId ? { requestId } : {}) },
})

const userIdFrom = (request: Request) => request.headers.get('x-user-id') ?? ''

export function createApp(deps: AppDependencies) {
  const app = new Elysia({ name: 'steam-discount-notifications' })
    .use(openapi({
      path: '/openapi',
      documentation: {
        info: {
          title: 'Steam Discount Notification Bot API',
          version: '0.2.0',
          description: 'Internal API and Telegram webhook for the Steam discount notification bot.',
        },
        tags: [
          { name: 'Health' },
          { name: 'Games' },
          { name: 'Wishlist' },
          { name: 'Analytics' },
          { name: 'Steam' },
        ],
      },
      exclude: { paths: ['/webhooks/telegram'] },
    }))
    .onRequest(({ request, set }) => {
      const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID()
      set.headers['x-request-id'] = requestId
    })
    .onError(({ code, error, request, set }) => {
      const requestId = request.headers.get('x-request-id') ?? undefined
      if (code === 'VALIDATION') {
        set.status = 422
        return errorBody('validation_error', 'Request tidak valid.', requestId)
      }
      if (code === 'NOT_FOUND') {
        set.status = 404
        return errorBody('not_found', 'Resource tidak ditemukan.', requestId)
      }
      deps.logger.error('request_failed', {
        requestId,
        code,
        method: request.method,
        path: new URL(request.url).pathname,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })
      set.status = 500
      return errorBody('internal_error', 'Terjadi kesalahan internal.', requestId)
    })
    .get('/health/live', () => ({ status: 'ok', timestamp: new Date().toISOString() }), {
      detail: { tags: ['Health'] },
    })
    .get('/health/ready', async ({ set }) => {
      try {
        const database = await deps.repository.health()
        if (!database) {
          set.status = 503
          return { status: 'not_ready', database: false }
        }
        return { status: 'ready', database: true }
      } catch {
        set.status = 503
        return { status: 'not_ready', database: false }
      }
    }, { detail: { tags: ['Health'] } })
    .post('/webhooks/telegram', async ({ request, set }) => {
      const contentType = request.headers.get('content-type') ?? ''
      const declaredLength = Number(request.headers.get('content-length') ?? 0)
      if (!contentType.toLowerCase().includes('application/json')) {
        set.status = 415
        return errorBody('unsupported_media_type', 'Content-Type harus application/json.')
      }
      if (declaredLength > 1_000_000) {
        set.status = 413
        return errorBody('payload_too_large', 'Webhook payload terlalu besar.')
      }
      const valid = await deps.messaging.verifyWebhook(
        request.headers.get('x-telegram-bot-api-secret-token'),
      )
      if (!valid) {
        set.status = 401
        return errorBody('invalid_webhook_secret', 'Secret webhook Telegram tidak valid.')
      }
      const bytes = await request.arrayBuffer()
      if (bytes.byteLength > 1_000_000) {
        set.status = 413
        return errorBody('payload_too_large', 'Webhook payload terlalu besar.')
      }
      const rawBody = new TextDecoder().decode(bytes)

      let payload: unknown
      try {
        payload = JSON.parse(rawBody)
      } catch {
        set.status = 400
        return errorBody('invalid_json', 'Webhook payload bukan JSON yang valid.')
      }
      let parsed
      try {
        parsed = deps.messaging.parseWebhook(payload)
      } catch {
        set.status = 400
        return errorBody('invalid_update', 'Payload update Telegram tidak valid.')
      }
      const payloadHash = await sha256(rawBody)

      for (const message of parsed.messages) {
        const encryptedAddress = await deps.encryptAddress(message.address)
        const addressHash = await deps.hashAddress(message.address)
        await deps.repository.recordProviderMessageAndEnqueue(
          deps.messaging.name,
          message.eventId,
          payloadHash,
          {
            eventId: message.eventId,
            encryptedAddress,
            addressHash,
            text: message.text,
            timestamp: message.timestamp,
            ...(message.interactionId ? { interactionId: message.interactionId } : {}),
          },
          deps.config.scheduler.jobMaxAttempts,
        )
      }
      return { ok: true }
    }, { parse: 'none', detail: { hide: true } })
    .get('/auth/steam/start', async ({ query, redirect, set }) => {
      const tokenHash = await sha256(query.token)
      const link = await deps.repository.getSteamLinkToken(tokenHash)
      if (!link || link.consumedAt || link.expiresAt <= new Date()) {
        set.status = 410
        return errorBody('link_expired', 'Tautan Steam tidak valid atau kedaluwarsa.')
      }
      const returnTo = `${deps.config.publicBaseUrl}/auth/steam/callback?state=${encodeURIComponent(query.token)}`
      return redirect(deps.steam.buildLoginUrl(returnTo), 302)
    }, {
      query: t.Object({ token: t.String({ minLength: 20, maxLength: 200 }) }),
      detail: { tags: ['Steam'] },
    })
    .get('/auth/steam/callback', async ({ request, query, set }) => {
      const stateHash = await sha256(query.state)
      const link = await deps.repository.getSteamLinkToken(stateHash)
      if (!link || link.consumedAt || link.expiresAt <= new Date()) {
        set.status = 410
        return errorBody('link_expired', 'Tautan Steam tidak valid atau kedaluwarsa.')
      }
      const requestUrl = new URL(request.url)
      const openIdParams = new URLSearchParams()
      for (const [key, value] of requestUrl.searchParams) {
        if (key.startsWith('openid.') || key === 'mock_steam_id') openIdParams.append(key, value)
      }
      const expectedReturnTo = `${deps.config.publicBaseUrl}/auth/steam/callback?state=${encodeURIComponent(query.state)}`
      const steamId = await deps.steam.verifyOpenId(openIdParams, expectedReturnTo)
      const userId = await deps.repository.consumeSteamLinkToken(stateHash, steamId)
      if (!userId) {
        set.status = 409
        return errorBody('link_already_used', 'Tautan Steam sudah digunakan.')
      }
      await deps.repository.enqueueJob('sync-steam', { userId }, {
        dedupeKey: `sync-steam:${userId}`,
        maxAttempts: deps.config.scheduler.jobMaxAttempts,
      })
      set.headers['content-type'] = 'text/html; charset=utf-8'
      return '<!doctype html><html lang="id"><body><h1>Steam berhasil dihubungkan</h1><p>Kamu boleh menutup halaman ini dan kembali ke Telegram.</p></body></html>'
    }, {
      query: t.Object({ state: t.String({ minLength: 20, maxLength: 200 }) }, { additionalProperties: true }),
      detail: { tags: ['Steam'] },
    })

  const internal = new Elysia({ prefix: '/internal' })
    .onBeforeHandle(({ request, set }) => {
      if (!timingSafeEqualString(request.headers.get('x-api-key') ?? '', deps.config.internalApiKey)) {
        set.status = 401
        return errorBody('unauthorized', 'API key tidak valid.')
      }
    })
    .post('/users/bootstrap', async ({ body }) => {
      const hash = await deps.hashAddress(body.address)
      const encrypted = await deps.encryptAddress(body.address)
      const user = await deps.repository.getOrCreateChannelUser(body.provider, hash, encrypted)
      return { userId: user.id }
    }, {
      body: t.Object({
        provider: t.Union([t.Literal('telegram'), t.Literal('development')]),
        address: t.String({ minLength: 3, maxLength: 100 }),
      }),
    })

  const v1 = new Elysia({ prefix: '/v1' })
    .onBeforeHandle(({ request, set }) => {
      const apiKey = request.headers.get('x-api-key') ?? ''
      const userId = userIdFrom(request)
      if (!timingSafeEqualString(apiKey, deps.config.internalApiKey) || !new RegExp(uuidPattern).test(userId)) {
        set.status = 401
        return errorBody('unauthorized', 'API key atau user context tidak valid.')
      }
    })
    .get('/me', async ({ request, set }) => {
      const user = await deps.repository.getUser(userIdFrom(request))
      if (!user) {
        set.status = 404
        return errorBody('user_not_found', 'Pengguna tidak ditemukan.')
      }
      return user
    })
    .patch('/me/settings', async ({ request, body, set }) => {
      if (body.timezone) {
        try {
          new Intl.DateTimeFormat('en', { timeZone: body.timezone }).format()
        } catch {
          set.status = 422
          return errorBody('invalid_timezone', 'Zona waktu tidak valid.')
        }
      }
      const user = await deps.repository.updateUserSettings(userIdFrom(request), body)
      if (!user) {
        set.status = 404
        return errorBody('user_not_found', 'Pengguna tidak ditemukan.')
      }
      return user
    }, {
      body: t.Object({
        country: t.Optional(t.String({ pattern: '^[A-Z]{2}$' })),
        currency: t.Optional(t.String({ pattern: '^[A-Z]{3}$' })),
        timezone: t.Optional(t.String({ minLength: 3, maxLength: 100 })),
        notificationMode: t.Optional(t.Union([t.Literal('instant'), t.Literal('digest')])),
      }),
    })
    .post('/me/notifications', async ({ request, body }) => {
      await deps.repository.setNotifications(userIdFrom(request), body.enabled)
      return { enabled: body.enabled }
    }, { body: t.Object({ enabled: t.Boolean() }) })
    .delete('/me', async ({ request, set }) => {
      await deps.repository.requestUserDeletion(userIdFrom(request))
      set.status = 202
      return { status: 'pending_deletion' }
    })
    .get('/games/search', async ({ request, query }) => {
      const user = await deps.repository.getUser(userIdFrom(request))
      if (!user) return []
      const deals = await deps.pricing.searchDeals({
        query: query.q,
        country: query.country ?? user.country,
        currency: query.currency ?? user.currency,
        limit: query.limit ?? 5,
      })
      const persisted = []
      for (const deal of deals) persisted.push(await deps.repository.persistDeal(deal))
      return persisted
    }, {
      query: t.Object({
        q: t.String({ minLength: 1, maxLength: 200 }),
        country: t.Optional(t.String({ pattern: '^[A-Z]{2}$' })),
        currency: t.Optional(t.String({ pattern: '^[A-Z]{3}$' })),
        limit: t.Optional(t.Integer({ minimum: 1, maximum: 20, default: 5 })),
      }),
      detail: { tags: ['Games'] },
    })
    .get('/games/:id/prices', async ({ request, params, set }) => {
      const user = await deps.repository.getUser(userIdFrom(request))
      const game = await deps.repository.getGame(params.id)
      if (!user || !game) {
        set.status = 404
        return errorBody('not_found', 'Game atau pengguna tidak ditemukan.')
      }
      const deal = await deps.pricing.getDeal(game, user.country, user.currency)
      return deal ? await deps.repository.persistDeal(deal) : null
    }, {
      params: t.Object({ id: uuidSchema }),
      detail: { tags: ['Games'] },
    })
    .get('/wishlist', ({ request }) => deps.repository.listWishlist(userIdFrom(request)), {
      detail: { tags: ['Wishlist'] },
    })
    .post('/wishlist', async ({ request, body, set }) => {
      const game = await deps.repository.getGame(body.gameId)
      if (!game) {
        set.status = 404
        return errorBody('game_not_found', 'Game tidak ditemukan.')
      }
      const id = await deps.repository.addWishlist(userIdFrom(request), body.gameId, {
        maxPriceMinor: body.maxPriceMinor ?? null,
        minCutPercent: body.minCutPercent ?? 30,
        historicalLowOnly: body.historicalLowOnly ?? false,
      })
      set.status = 201
      return { id }
    }, {
      body: t.Object({
        gameId: uuidSchema,
        maxPriceMinor: t.Optional(t.Union([t.Null(), t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })])),
        minCutPercent: t.Optional(t.Union([t.Null(), t.Integer({ minimum: 0, maximum: 100 })])),
        historicalLowOnly: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['Wishlist'] },
    })
    .patch('/wishlist/:id', async ({ request, params, body, set }) => {
      const rule = body.rule
        ? {
            maxPriceMinor: body.rule.maxPriceMinor ?? null,
            minCutPercent: body.rule.minCutPercent ?? null,
            historicalLowOnly: body.rule.historicalLowOnly ?? false,
          }
        : undefined
      const updated = await deps.repository.updateWishlist(userIdFrom(request), params.id, {
        ...(body.active === undefined ? {} : { active: body.active }),
        ...(rule ? { rule } : {}),
      })
      if (!updated) {
        set.status = 404
        return errorBody('wishlist_not_found', 'Wishlist item tidak ditemukan.')
      }
      return { updated: true }
    }, {
      params: t.Object({ id: uuidSchema }),
      body: t.Object({
        active: t.Optional(t.Boolean()),
        rule: t.Optional(t.Object({
          maxPriceMinor: t.Optional(t.Union([t.Null(), t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })])),
          minCutPercent: t.Optional(t.Union([t.Null(), t.Integer({ minimum: 0, maximum: 100 })])),
          historicalLowOnly: t.Optional(t.Boolean()),
        })),
      }),
      detail: { tags: ['Wishlist'] },
    })
    .delete('/wishlist/:id', async ({ request, params, set }) => {
      const deleted = await deps.repository.deleteWishlist(userIdFrom(request), params.id)
      if (!deleted) {
        set.status = 404
        return errorBody('wishlist_not_found', 'Wishlist item tidak ditemukan.')
      }
      set.status = 204
      return
    }, { params: t.Object({ id: uuidSchema }), detail: { tags: ['Wishlist'] } })
    .get('/stats/weekly', ({ request }) => deps.repository.weeklyPlaytime(userIdFrom(request)), {
      detail: { tags: ['Analytics'] },
    })
    .get('/stats/library', ({ request }) => deps.repository.librarySummary(userIdFrom(request)), {
      detail: { tags: ['Analytics'] },
    })
    .get('/purchases', ({ request }) => deps.repository.purchaseSummary(userIdFrom(request)), {
      detail: { tags: ['Analytics'] },
    })
    .post('/purchases', async ({ request, body, set }) => {
      const id = await deps.repository.addPurchase(userIdFrom(request), body)
      set.status = 201
      return { id }
    }, {
      body: t.Object({
        gameId: uuidSchema,
        amountMinor: t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        currency: t.String({ pattern: '^[A-Z]{3}$' }),
        purchasedAt: t.String({ format: 'date' }),
        store: t.Optional(t.String({ maxLength: 100 })),
        acquisitionType: t.Union([
          t.Literal('paid'), t.Literal('gift'), t.Literal('free'),
          t.Literal('subscription'), t.Literal('unknown'),
        ]),
      }),
      detail: { tags: ['Analytics'] },
    })
    .patch('/purchases/:id', async ({ request, params, body, set }) => {
      const updated = await deps.repository.updatePurchase(userIdFrom(request), params.id, body)
      if (!updated) {
        set.status = 404
        return errorBody('purchase_not_found', 'Catatan pembelian tidak ditemukan.')
      }
      return { updated: true }
    }, {
      params: t.Object({ id: uuidSchema }),
      body: t.Object({
        amountMinor: t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        currency: t.String({ pattern: '^[A-Z]{3}$' }),
        purchasedAt: t.String({ format: 'date' }),
        store: t.Optional(t.Union([t.Null(), t.String({ maxLength: 100 })])),
        acquisitionType: t.Union([
          t.Literal('paid'), t.Literal('gift'), t.Literal('free'),
          t.Literal('subscription'), t.Literal('unknown'),
        ]),
      }),
      detail: { tags: ['Analytics'] },
    })
    .delete('/purchases/:id', async ({ request, params, set }) => {
      if (!await deps.repository.deletePurchase(userIdFrom(request), params.id)) {
        set.status = 404
        return errorBody('purchase_not_found', 'Catatan pembelian tidak ditemukan.')
      }
      set.status = 204
      return
    }, { params: t.Object({ id: uuidSchema }), detail: { tags: ['Analytics'] } })
    .get('/recommendations', async ({ request }) => {
      const user = await deps.repository.getUser(userIdFrom(request))
      if (!user) return []
      const data = await deps.repository.recommendationData(user.id)
      return rankRecommendations({
        genreWeights: data.genreWeights,
        platforms: data.platforms,
        excludedGameIds: data.excludedGameIds,
        maxPriceMinor: null,
        currency: user.currency,
      }, data.candidates, 10)
    }, { detail: { tags: ['Analytics'] } })
    .post('/recommendations/:gameId/feedback', async ({ request, params, body }) => {
      await deps.repository.setRecommendationFeedback(userIdFrom(request), params.gameId, body.action)
      return { recorded: true }
    }, {
      params: t.Object({ gameId: uuidSchema }),
      body: t.Object({ action: t.Union([
        t.Literal('like'), t.Literal('dislike'), t.Literal('hide'), t.Literal('owned'),
      ]) }),
      detail: { tags: ['Analytics'] },
    })
    .put('/preferences', async ({ request, body }) => {
      await deps.repository.replacePreferences(userIdFrom(request), body)
      return { updated: true }
    }, {
      body: t.Object({
        genres: t.Array(t.String({ minLength: 2, maxLength: 50 }), { minItems: 0, maxItems: 20, uniqueItems: true }),
        platforms: t.Array(
          t.Union([t.Literal('windows'), t.Literal('macos'), t.Literal('linux')]),
          { minItems: 1, maxItems: 3, uniqueItems: true },
        ),
      }),
      detail: { tags: ['Analytics'] },
    })
    .post('/steam/link', async ({ request }) => {
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      const token = Buffer.from(bytes).toString('base64url')
      await deps.repository.createSteamLinkToken(
        userIdFrom(request),
        await sha256(token),
        new Date(Date.now() + 10 * 60_000),
      )
      return { url: `${deps.config.publicBaseUrl}/auth/steam/start?token=${encodeURIComponent(token)}`, expiresInSeconds: 600 }
    }, { detail: { tags: ['Steam'] } })

  const admin = new Elysia({ prefix: '/admin' })
    .onBeforeHandle(({ request, set }) => {
      if (!timingSafeEqualString(request.headers.get('x-admin-key') ?? '', deps.config.adminApiKey)) {
        set.status = 401
        return errorBody('unauthorized', 'Admin key tidak valid.')
      }
    })
    .get('/jobs', () => deps.repository.jobStats())

  return app.use(internal).use(v1).use(admin)
}
