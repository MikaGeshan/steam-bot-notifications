import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadConfig } from '../../src/config'
import { createDatabase } from '../../src/db/client'
import { MockPriceProvider } from '../../src/integrations/pricing/mock'
import { Repository } from '../../src/repository'

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://steam_bot:steam_bot@localhost:5432/steam_bot',
})
const sql = createDatabase(config)
const repository = new Repository(sql)

describe('PostgreSQL repository', () => {
  beforeAll(async () => {
    await sql.unsafe(`
      TRUNCATE TABLE
        audit_logs, jobs, notification_events, provider_events, recommendation_feedback,
        user_preferences, purchase_records, wishlist_rules, wishlist_items, historical_lows,
        price_snapshots, playtime_snapshots, owned_games, game_genres, game_platforms,
        game_provider_ids, games, steam_link_tokens, steam_accounts, consents,
        channel_identities, users
      RESTART IDENTITY CASCADE
    `)
  })

  afterAll(async () => {
    await sql.end()
  })

  test('enforces identity, provider-event, wishlist, and job idempotency', async () => {
    const first = await repository.getOrCreateChannelUser('telegram', 'hash-1', 'cipher-1')
    const duplicate = await repository.getOrCreateChannelUser('telegram', 'hash-1', 'cipher-1')
    const other = await repository.getOrCreateChannelUser('telegram', 'hash-2', 'cipher-2')
    expect(duplicate.id).toBe(first.id)
    expect(other.id).not.toBe(first.id)

    const provider = new MockPriceProvider()
    const deal = (await provider.searchDeals({ query: 'Hades', country: 'ID', currency: 'IDR' }))[0]!
    const persisted = await repository.persistDeal(deal)
    const persistedAgain = await repository.persistDeal(deal)
    expect(persistedAgain.game.id).toBe(persisted.game.id)

    const itemId = await repository.addWishlist(first.id, persisted.game.id, {
      maxPriceMinor: null,
      minCutPercent: 30,
      historicalLowOnly: false,
    })
    expect(await repository.listWishlist(first.id)).toHaveLength(1)
    expect(await repository.deleteWishlist(other.id, itemId)).toBe(false)
    expect(await repository.deleteWishlist(first.id, itemId)).toBe(true)

    expect(await repository.insertProviderEvent('test', 'event-1', 'hash', 'message')).toBe(true)
    expect(await repository.insertProviderEvent('test', 'event-1', 'hash', 'message')).toBe(false)
    expect(await repository.enqueueJob('test-job', {}, { dedupeKey: 'same-job' })).not.toBeNull()
    expect(await repository.enqueueJob('test-job', {}, { dedupeKey: 'same-job' })).toBeNull()
  })
})
