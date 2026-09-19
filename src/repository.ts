import type { Database } from './db/client'
import type {
  Deal,
  GameSummary,
  PlaytimeSnapshot,
  WishlistItem,
  WishlistRule,
} from './domain/types'
import { calculateWeeklyPlaytime } from './domain/playtime'
import type { RecommendationCandidate } from './domain/types'
import type { SteamOwnedGame } from './ports'
import type postgres from 'postgres'

type Row = Record<string, unknown>

export interface UserRecord {
  id: string
  locale: string
  country: string
  currency: string
  timezone: string
  notificationMode: 'instant' | 'digest'
  quietStart: number
  quietEnd: number
  notificationsEnabled: boolean
}

export interface ClaimedJob {
  id: string
  type: string
  payload: unknown
  attempts: number
  maxAttempts: number
}

const string = (value: unknown) => String(value ?? '')
const number = (value: unknown) => Number(value ?? 0)
const boolean = (value: unknown) => Boolean(value)
const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value)) as postgres.JSONValue

const mapUser = (row: Row): UserRecord => ({
  id: string(row.id),
  locale: string(row.locale),
  country: string(row.country),
  currency: string(row.currency),
  timezone: string(row.timezone),
  notificationMode: string(row.notification_mode) === 'digest' ? 'digest' : 'instant',
  quietStart: number(row.quiet_start),
  quietEnd: number(row.quiet_end),
  notificationsEnabled: boolean(row.notifications_enabled),
})

const mapGame = (row: Row): GameSummary => ({
  id: string(row.game_id ?? row.id),
  title: string(row.title),
  type:
    row.type === 'game' || row.type === 'dlc' || row.type === 'bundle'
      ? row.type
      : 'unknown',
  steamAppId: row.steam_app_id ? string(row.steam_app_id) : null,
  itadId: row.itad_id ? string(row.itad_id) : null,
  platforms: Array.isArray(row.platforms) ? row.platforms.map(string) : [],
  genres: Array.isArray(row.genres) ? row.genres.map(string) : [],
})

export class Repository {
  constructor(private readonly sql: Database) {}

  async health() {
    const result = await this.sql`SELECT 1 AS ok`
    return result[0]?.ok === 1
  }

  async getUser(userId: string) {
    const rows = await this.sql`SELECT * FROM users WHERE id = ${userId} AND status = 'active'`
    return rows[0] ? mapUser(rows[0] as Row) : null
  }

  async getOrCreateChannelUser(
    provider: string,
    addressHash: string,
    encryptedAddress: string,
  ) {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`${provider}:${addressHash}`}))`
      const existing = await tx`
        SELECT u.* FROM users u
        JOIN channel_identities c ON c.user_id = u.id
        WHERE c.provider = ${provider} AND c.address_hash = ${addressHash}
      `
      if (existing[0]) return mapUser(existing[0] as Row)
      const users = await tx`INSERT INTO users DEFAULT VALUES RETURNING *`
      const user = users[0]
      if (!user) throw new Error('Failed to create user')
      await tx`
        INSERT INTO channel_identities (user_id, provider, encrypted_address, address_hash)
        VALUES (${user.id}, ${provider}, ${encryptedAddress}, ${addressHash})
      `
      await tx`
        INSERT INTO audit_logs (user_id, action, resource_type)
        VALUES (${user.id}, 'user.created', 'user')
      `
      return mapUser(user as Row)
    })
  }

  async getEncryptedChannelAddress(userId: string, provider = 'telegram') {
    const rows = await this.sql`
      SELECT encrypted_address FROM channel_identities
      WHERE user_id = ${userId} AND provider = ${provider}
      LIMIT 1
    `
    return rows[0]?.encrypted_address ? string(rows[0].encrypted_address) : null
  }

  async setNotifications(userId: string, enabled: boolean) {
    await this.sql.begin(async (tx) => {
      await tx`
        UPDATE users
        SET notifications_enabled = ${enabled}, updated_at = now()
        WHERE id = ${userId} AND status = 'active'
      `
      await tx`
        INSERT INTO consents (user_id, type, version, granted_at, revoked_at)
        VALUES (
          ${userId},
          'proactive_notifications',
          '1.0',
          ${enabled ? new Date() : null},
          ${enabled ? null : new Date()}
        )
      `
      if (!enabled) {
        await tx`
          UPDATE notification_events
          SET state = 'suppressed', updated_at = now()
          WHERE user_id = ${userId} AND state IN ('pending', 'sending')
        `
      }
      await tx`
        INSERT INTO audit_logs (user_id, action, resource_type)
        VALUES (${userId}, ${enabled ? 'notifications.enabled' : 'notifications.disabled'}, 'consent')
      `
    })
  }

  async updateUserSettings(
    userId: string,
    input: Partial<Pick<UserRecord, 'country' | 'currency' | 'timezone' | 'notificationMode'>>,
  ) {
    const current = await this.getUser(userId)
    if (!current) return null
    const rows = await this.sql`
      UPDATE users SET
        country = ${input.country ?? current.country},
        currency = ${input.currency ?? current.currency},
        timezone = ${input.timezone ?? current.timezone},
        notification_mode = ${input.notificationMode ?? current.notificationMode},
        updated_at = now()
      WHERE id = ${userId} AND status = 'active'
      RETURNING *
    `
    return rows[0] ? mapUser(rows[0] as Row) : null
  }

  async requestUserDeletion(userId: string) {
    await this.sql.begin(async (tx) => {
      await tx`
        UPDATE users SET status = 'pending_deletion', notifications_enabled = false, updated_at = now()
        WHERE id = ${userId}
      `
      await tx`
        UPDATE notification_events SET state = 'suppressed', updated_at = now()
        WHERE user_id = ${userId} AND state IN ('pending', 'sending')
      `
      await tx`
        INSERT INTO audit_logs (user_id, action, resource_type)
        VALUES (${userId}, 'user.deletion_requested', 'user')
      `
    })
  }

  async persistDeal(deal: Deal): Promise<Deal> {
    return this.sql.begin(async (tx) => {
      let gameId: string | null = null
      const identifiers = [
        deal.game.itadId ? ['itad', deal.game.itadId] : null,
        deal.game.steamAppId ? ['steam', deal.game.steamAppId] : null,
      ].filter((item): item is [string, string] => item !== null)

      for (const [provider, externalId] of identifiers) {
        const found = await tx`
          SELECT game_id FROM game_provider_ids
          WHERE provider = ${provider} AND external_id = ${externalId}
        `
        if (found[0]?.game_id) {
          gameId = string(found[0].game_id)
          break
        }
      }

      if (!gameId) {
        const inserted = await tx`
          INSERT INTO games (title, type, metadata_status)
          VALUES (${deal.game.title}, ${deal.game.type}, 'partial')
          RETURNING id
        `
        gameId = string(inserted[0]?.id)
      } else {
        await tx`
          UPDATE games SET title = ${deal.game.title}, type = ${deal.game.type}, updated_at = now()
          WHERE id = ${gameId}
        `
      }

      for (const [provider, externalId] of identifiers) {
        await tx`
          INSERT INTO game_provider_ids (game_id, provider, external_id)
          VALUES (${gameId}, ${provider}, ${externalId})
          ON CONFLICT (provider, external_id) DO UPDATE SET game_id = EXCLUDED.game_id
        `
      }
      for (const platform of deal.game.platforms) {
        await tx`
          INSERT INTO game_platforms (game_id, platform)
          VALUES (${gameId}, ${platform.toLowerCase()})
          ON CONFLICT DO NOTHING
        `
      }
      for (const genre of deal.game.genres) {
        await tx`
          INSERT INTO game_genres (game_id, genre)
          VALUES (${gameId}, ${genre.toLowerCase()})
          ON CONFLICT DO NOTHING
        `
      }
      await tx`
        INSERT INTO price_snapshots (
          game_id, shop, country, currency, regular_minor, current_minor,
          cut_percent, deal_url, source, voucher, captured_at
        ) VALUES (
          ${gameId}, ${deal.shop}, ${deal.country}, ${deal.current.currency},
          ${deal.regular.amountMinor}, ${deal.current.amountMinor}, ${deal.cutPercent},
          ${deal.url}, ${deal.source}, ${deal.voucher}, ${new Date(deal.updatedAt)}
        )
      `
      if (deal.historicalLow && deal.historicalLowAt) {
        await tx`
          INSERT INTO historical_lows (
            game_id, shop_scope, country, currency, amount_minor, occurred_at, source
          ) VALUES (
            ${gameId}, 'all', ${deal.country}, ${deal.historicalLow.currency},
            ${deal.historicalLow.amountMinor}, ${new Date(deal.historicalLowAt)}, ${deal.source}
          )
          ON CONFLICT (game_id, shop_scope, country, currency) DO UPDATE SET
            amount_minor = LEAST(historical_lows.amount_minor, EXCLUDED.amount_minor),
            occurred_at = CASE
              WHEN EXCLUDED.amount_minor <= historical_lows.amount_minor THEN EXCLUDED.occurred_at
              ELSE historical_lows.occurred_at
            END,
            source = EXCLUDED.source,
            updated_at = now()
        `
      }
      return { ...deal, game: { ...deal.game, id: gameId } }
    })
  }

  async getGame(gameId: string) {
    const rows = await this.sql`
      SELECT g.id AS game_id, g.title, g.type,
        MAX(gp.external_id) FILTER (WHERE gp.provider = 'steam') AS steam_app_id,
        MAX(gp.external_id) FILTER (WHERE gp.provider = 'itad') AS itad_id,
        COALESCE(array_agg(DISTINCT p.platform) FILTER (WHERE p.platform IS NOT NULL), '{}') AS platforms,
        COALESCE(array_agg(DISTINCT ge.genre) FILTER (WHERE ge.genre IS NOT NULL), '{}') AS genres
      FROM games g
      LEFT JOIN game_provider_ids gp ON gp.game_id = g.id
      LEFT JOIN game_platforms p ON p.game_id = g.id
      LEFT JOIN game_genres ge ON ge.game_id = g.id
      WHERE g.id = ${gameId}
      GROUP BY g.id
    `
    return rows[0] ? mapGame(rows[0] as Row) : null
  }

  async addWishlist(userId: string, gameId: string, rule: WishlistRule) {
    return this.sql.begin(async (tx) => {
      const items = await tx`
        INSERT INTO wishlist_items (user_id, game_id, active)
        VALUES (${userId}, ${gameId}, true)
        ON CONFLICT (user_id, game_id) DO UPDATE SET active = true, updated_at = now()
        RETURNING id
      `
      const id = string(items[0]?.id)
      await tx`
        INSERT INTO wishlist_rules (
          wishlist_item_id, max_price_minor, min_cut_percent, historical_low_only
        ) VALUES (
          ${id}, ${rule.maxPriceMinor}, ${rule.minCutPercent}, ${rule.historicalLowOnly}
        )
        ON CONFLICT (wishlist_item_id) DO UPDATE SET
          max_price_minor = EXCLUDED.max_price_minor,
          min_cut_percent = EXCLUDED.min_cut_percent,
          historical_low_only = EXCLUDED.historical_low_only
      `
      await tx`
        INSERT INTO audit_logs (user_id, action, resource_type, resource_id)
        VALUES (${userId}, 'wishlist.upserted', 'wishlist_item', ${id})
      `
      return id
    })
  }

  async listWishlist(userId: string): Promise<WishlistItem[]> {
    const rows = await this.sql`
      SELECT w.id, w.user_id, w.active, w.created_at,
        g.id AS game_id, g.title, g.type,
        r.max_price_minor, r.min_cut_percent, r.historical_low_only,
        MAX(gp.external_id) FILTER (WHERE gp.provider = 'steam') AS steam_app_id,
        MAX(gp.external_id) FILTER (WHERE gp.provider = 'itad') AS itad_id,
        COALESCE(array_agg(DISTINCT p.platform) FILTER (WHERE p.platform IS NOT NULL), '{}') AS platforms,
        COALESCE(array_agg(DISTINCT ge.genre) FILTER (WHERE ge.genre IS NOT NULL), '{}') AS genres
      FROM wishlist_items w
      JOIN games g ON g.id = w.game_id
      JOIN wishlist_rules r ON r.wishlist_item_id = w.id
      LEFT JOIN game_provider_ids gp ON gp.game_id = g.id
      LEFT JOIN game_platforms p ON p.game_id = g.id
      LEFT JOIN game_genres ge ON ge.game_id = g.id
      WHERE w.user_id = ${userId}
      GROUP BY w.id, g.id, r.wishlist_item_id
      ORDER BY w.created_at DESC
    `
    return rows.map((row) => ({
      id: string(row.id),
      userId: string(row.user_id),
      game: mapGame(row as Row),
      active: boolean(row.active),
      rule: {
        maxPriceMinor: row.max_price_minor === null ? null : number(row.max_price_minor),
        minCutPercent: row.min_cut_percent === null ? null : number(row.min_cut_percent),
        historicalLowOnly: boolean(row.historical_low_only),
      },
      createdAt: new Date(string(row.created_at)).toISOString(),
    }))
  }

  async updateWishlist(
    userId: string,
    itemId: string,
    input: { active?: boolean; rule?: WishlistRule },
  ) {
    const owned = await this.sql`
      SELECT id FROM wishlist_items WHERE id = ${itemId} AND user_id = ${userId}
    `
    if (!owned[0]) return false
    await this.sql.begin(async (tx) => {
      if (input.active !== undefined) {
        await tx`
          UPDATE wishlist_items SET active = ${input.active}, updated_at = now()
          WHERE id = ${itemId} AND user_id = ${userId}
        `
      }
      if (input.rule) {
        await tx`
          UPDATE wishlist_rules SET
            max_price_minor = ${input.rule.maxPriceMinor},
            min_cut_percent = ${input.rule.minCutPercent},
            historical_low_only = ${input.rule.historicalLowOnly}
          WHERE wishlist_item_id = ${itemId}
        `
      }
    })
    return true
  }

  async deleteWishlist(userId: string, itemId: string) {
    const result = await this.sql`
      DELETE FROM wishlist_items WHERE id = ${itemId} AND user_id = ${userId} RETURNING id
    `
    return result.length > 0
  }

  async pauseWishlist(userId: string) {
    await this.sql`
      UPDATE wishlist_items SET active = false, updated_at = now() WHERE user_id = ${userId}
    `
  }

  async listActiveWishlistForRefresh(limit = 200) {
    const rows = await this.sql`
      SELECT w.id AS wishlist_id, w.user_id, u.country, u.currency, u.timezone,
        u.quiet_start, u.quiet_end, u.notifications_enabled,
        r.max_price_minor, r.min_cut_percent, r.historical_low_only,
        g.id AS game_id, g.title, g.type,
        MAX(gp.external_id) FILTER (WHERE gp.provider = 'steam') AS steam_app_id,
        MAX(gp.external_id) FILTER (WHERE gp.provider = 'itad') AS itad_id,
        COALESCE(array_agg(DISTINCT p.platform) FILTER (WHERE p.platform IS NOT NULL), '{}') AS platforms,
        COALESCE(array_agg(DISTINCT ge.genre) FILTER (WHERE ge.genre IS NOT NULL), '{}') AS genres
      FROM wishlist_items w
      JOIN wishlist_rules r ON r.wishlist_item_id = w.id
      JOIN users u ON u.id = w.user_id
      JOIN games g ON g.id = w.game_id
      LEFT JOIN game_provider_ids gp ON gp.game_id = g.id
      LEFT JOIN game_platforms p ON p.game_id = g.id
      LEFT JOIN game_genres ge ON ge.game_id = g.id
      WHERE w.active = true AND u.status = 'active'
      GROUP BY w.id, u.id, r.wishlist_item_id, g.id
      ORDER BY w.updated_at ASC
      LIMIT ${limit}
    `
    return rows.map((row) => ({
      wishlistId: string(row.wishlist_id),
      user: mapUser(row as Row),
      game: mapGame(row as Row),
      rule: {
        maxPriceMinor: row.max_price_minor === null ? null : number(row.max_price_minor),
        minCutPercent: row.min_cut_percent === null ? null : number(row.min_cut_percent),
        historicalLowOnly: boolean(row.historical_low_only),
      } satisfies WishlistRule,
    }))
  }

  async addPurchase(
    userId: string,
    input: {
      gameId: string
      amountMinor: number
      currency: string
      purchasedAt: string
      store?: string
      acquisitionType: 'paid' | 'gift' | 'free' | 'subscription' | 'unknown'
    },
  ) {
    const rows = await this.sql`
      INSERT INTO purchase_records (
        user_id, game_id, amount_minor, currency, purchased_at, store, acquisition_type
      ) VALUES (
        ${userId}, ${input.gameId}, ${input.amountMinor}, ${input.currency},
        ${input.purchasedAt}, ${input.store ?? null}, ${input.acquisitionType}
      ) RETURNING id
    `
    return string(rows[0]?.id)
  }

  async deletePurchase(userId: string, purchaseId: string) {
    const rows = await this.sql`
      DELETE FROM purchase_records WHERE id = ${purchaseId} AND user_id = ${userId} RETURNING id
    `
    return rows.length > 0
  }

  async purchaseSummary(userId: string) {
    const user = await this.getUser(userId)
    if (!user) return null
    const totals = await this.sql`
      SELECT currency, SUM(amount_minor)::bigint AS total, COUNT(*)::int AS records
      FROM purchase_records
      WHERE user_id = ${userId} AND acquisition_type = 'paid'
      GROUP BY currency
      ORDER BY currency
    `
    const library = await this.sql`
      SELECT COUNT(*)::int AS owned FROM owned_games WHERE user_id = ${userId}
    `
    const replacement = await this.sql`
      WITH latest AS (
        SELECT DISTINCT ON (p.game_id, p.currency)
          p.game_id, p.currency, p.current_minor, p.regular_minor
        FROM price_snapshots p
        JOIN owned_games o ON o.game_id = p.game_id
        WHERE o.user_id = ${userId}
        ORDER BY p.game_id, p.currency, p.captured_at DESC
      )
      SELECT currency,
        SUM(current_minor)::bigint AS current_total,
        SUM(regular_minor)::bigint AS regular_total,
        COUNT(*)::int AS priced_games
      FROM latest GROUP BY currency ORDER BY currency
    `
    return {
      totals: totals.map((row) => ({
        currency: string(row.currency),
        amountMinor: number(row.total),
        records: number(row.records),
      })),
      ownedGames: number(library[0]?.owned),
      coveragePercent:
        number(library[0]?.owned) === 0
          ? 0
          : Math.min(100, Math.round((totals.reduce((sum, row) => sum + number(row.records), 0) / number(library[0]?.owned)) * 100)),
      replacementValues: replacement.map((row) => ({
        currency: string(row.currency),
        currentAmountMinor: number(row.current_total),
        regularAmountMinor: number(row.regular_total),
        pricedGames: number(row.priced_games),
      })),
      disclaimer: 'Estimasi nilai pengganti library, bukan harga jual akun.',
    }
  }

  async updatePurchase(
    userId: string,
    purchaseId: string,
    input: {
      amountMinor: number
      currency: string
      purchasedAt: string
      store?: string | null
      acquisitionType: 'paid' | 'gift' | 'free' | 'subscription' | 'unknown'
    },
  ) {
    const rows = await this.sql`
      UPDATE purchase_records SET
        amount_minor = ${input.amountMinor},
        currency = ${input.currency},
        purchased_at = ${input.purchasedAt},
        store = ${input.store ?? null},
        acquisition_type = ${input.acquisitionType}
      WHERE id = ${purchaseId} AND user_id = ${userId}
      RETURNING id
    `
    return rows.length > 0
  }

  async syncOwnedGames(userId: string, games: SteamOwnedGame[], capturedAt = new Date()) {
    await this.sql.begin(async (tx) => {
      for (const owned of games) {
        const mapping = await tx`
          SELECT game_id FROM game_provider_ids WHERE provider = 'steam' AND external_id = ${owned.appId}
        `
        let gameId = mapping[0]?.game_id ? string(mapping[0].game_id) : ''
        if (!gameId) {
          const inserted = await tx`
            INSERT INTO games (title, type, metadata_status)
            VALUES (${owned.name}, 'game', 'partial') RETURNING id
          `
          gameId = string(inserted[0]?.id)
          await tx`
            INSERT INTO game_provider_ids (game_id, provider, external_id)
            VALUES (${gameId}, 'steam', ${owned.appId})
          `
        }
        await tx`
          INSERT INTO owned_games (user_id, game_id, playtime_minutes)
          VALUES (${userId}, ${gameId}, ${owned.playtimeMinutes})
          ON CONFLICT (user_id, game_id) DO UPDATE SET
            playtime_minutes = EXCLUDED.playtime_minutes,
            updated_at = now()
        `
        await tx`
          INSERT INTO playtime_snapshots (user_id, game_id, captured_at, cumulative_minutes)
          VALUES (${userId}, ${gameId}, ${capturedAt}, ${owned.playtimeMinutes})
          ON CONFLICT DO NOTHING
        `
      }
      await tx`UPDATE steam_accounts SET last_sync_at = now() WHERE user_id = ${userId}`
    })
  }

  async weeklyPlaytime(userId: string, now = new Date()) {
    const since = new Date(now.getTime() - 8 * 24 * 60 * 60_000)
    const rows = await this.sql`
      SELECT p.game_id, g.title, p.cumulative_minutes, p.captured_at
      FROM playtime_snapshots p
      JOIN games g ON g.id = p.game_id
      WHERE p.user_id = ${userId} AND p.captured_at >= ${since} AND p.captured_at <= ${now}
      ORDER BY p.captured_at ASC
    `
    const snapshots = rows.map((row): PlaytimeSnapshot => ({
      gameId: string(row.game_id),
      title: string(row.title),
      cumulativeMinutes: number(row.cumulative_minutes),
      capturedAt: new Date(string(row.captured_at)).toISOString(),
    }))
    const grouped = new Map<string, PlaytimeSnapshot[]>()
    for (const snapshot of snapshots) {
      grouped.set(snapshot.gameId, [...(grouped.get(snapshot.gameId) ?? []), snapshot])
    }
    const start = [...grouped.values()].flatMap((items) => items[0] ? [items[0]] : [])
    const end = [...grouped.values()].flatMap((items) => items.at(-1) ? [items.at(-1)!] : [])
    const uniqueDays = new Set(snapshots.map((item) => item.capturedAt.slice(0, 10))).size
    return calculateWeeklyPlaytime(start, end, uniqueDays)
  }

  async librarySummary(userId: string) {
    const rows = await this.sql`
      SELECT COUNT(*)::int AS owned,
        COUNT(*) FILTER (WHERE playtime_minutes > 0)::int AS played,
        COALESCE(SUM(playtime_minutes), 0)::bigint AS total_minutes
      FROM owned_games WHERE user_id = ${userId}
    `
    const top = await this.sql`
      SELECT g.id, g.title, o.playtime_minutes
      FROM owned_games o JOIN games g ON g.id = o.game_id
      WHERE o.user_id = ${userId}
      ORDER BY o.playtime_minutes DESC LIMIT 5
    `
    return {
      ownedGames: number(rows[0]?.owned),
      playedGames: number(rows[0]?.played),
      unplayedGames: number(rows[0]?.owned) - number(rows[0]?.played),
      totalMinutes: number(rows[0]?.total_minutes),
      topGames: top.map((row) => ({
        gameId: string(row.id),
        title: string(row.title),
        minutes: number(row.playtime_minutes),
      })),
    }
  }

  async recommendationData(userId: string) {
    const preferences = await this.sql`
      SELECT key, value, weight FROM user_preferences WHERE user_id = ${userId}
    `
    const inferredGenres = await this.sql`
      SELECT ge.genre, SUM(LEAST(o.playtime_minutes, 6000))::float AS weight
      FROM owned_games o
      JOIN game_genres ge ON ge.game_id = o.game_id
      WHERE o.user_id = ${userId} AND o.playtime_minutes > 0
      GROUP BY ge.genre
    `
    const excluded = await this.sql`
      SELECT game_id FROM owned_games WHERE user_id = ${userId}
      UNION SELECT game_id FROM wishlist_items WHERE user_id = ${userId}
      UNION SELECT game_id FROM recommendation_feedback
        WHERE user_id = ${userId} AND action IN ('dislike', 'hide', 'owned')
    `
    const candidates = await this.sql`
      SELECT g.id AS game_id, g.title, g.type, g.popularity,
        MAX(gp.external_id) FILTER (WHERE gp.provider = 'steam') AS steam_app_id,
        MAX(gp.external_id) FILTER (WHERE gp.provider = 'itad') AS itad_id,
        COALESCE(array_agg(DISTINCT p.platform) FILTER (WHERE p.platform IS NOT NULL), '{}') AS platforms,
        COALESCE(array_agg(DISTINCT ge.genre) FILTER (WHERE ge.genre IS NOT NULL), '{}') AS genres,
        price.shop, price.country, price.currency, price.current_minor, price.regular_minor,
        price.cut_percent, price.deal_url, price.source, price.voucher, price.captured_at,
        low.amount_minor AS low_minor, low.currency AS low_currency, low.occurred_at AS low_at
      FROM games g
      LEFT JOIN game_provider_ids gp ON gp.game_id = g.id
      LEFT JOIN game_platforms p ON p.game_id = g.id
      LEFT JOIN game_genres ge ON ge.game_id = g.id
      LEFT JOIN LATERAL (
        SELECT * FROM price_snapshots ps
        WHERE ps.game_id = g.id
        ORDER BY ps.captured_at DESC LIMIT 1
      ) price ON true
      LEFT JOIN historical_lows low ON low.game_id = g.id AND low.shop_scope = 'all'
      WHERE g.type = 'game'
      GROUP BY g.id, price.id, low.game_id, low.shop_scope, low.country, low.currency
      ORDER BY g.popularity DESC, g.title
      LIMIT 100
    `

    const genreWeights: Record<string, number> = {}
    const maxInferred = Math.max(1, ...inferredGenres.map((row) => number(row.weight)))
    for (const row of inferredGenres) {
      genreWeights[string(row.genre).toLowerCase()] = Math.max(0.1, number(row.weight) / maxInferred)
    }
    for (const row of preferences) {
      if (row.key === 'genre') genreWeights[string(row.value).toLowerCase()] = number(row.weight)
    }
    const platforms = preferences
      .filter((row) => row.key === 'platform')
      .map((row) => string(row.value).toLowerCase())

    const mappedCandidates: RecommendationCandidate[] = candidates.map((row) => {
      const game = mapGame(row as Row)
      const hasPrice = row.current_minor !== null && row.current_minor !== undefined
      const deal: Deal | null = hasPrice
        ? {
            game,
            shop: string(row.shop),
            country: string(row.country),
            current: { amountMinor: number(row.current_minor), currency: string(row.currency) },
            regular: { amountMinor: number(row.regular_minor), currency: string(row.currency) },
            cutPercent: number(row.cut_percent),
            historicalLow:
              row.low_minor === null || row.low_minor === undefined
                ? null
                : { amountMinor: number(row.low_minor), currency: string(row.low_currency) },
            historicalLowAt: row.low_at ? new Date(string(row.low_at)).toISOString() : null,
            url: string(row.deal_url),
            source: string(row.source),
            updatedAt: new Date(string(row.captured_at)).toISOString(),
            voucher: boolean(row.voucher),
          }
        : null
      return { game, deal, popularity: number(row.popularity) }
    })

    return {
      genreWeights,
      platforms: platforms.length > 0 ? platforms : ['windows'],
      excludedGameIds: new Set(excluded.map((row) => string(row.game_id))),
      candidates: mappedCandidates,
    }
  }

  async setRecommendationFeedback(
    userId: string,
    gameId: string,
    action: 'like' | 'dislike' | 'hide' | 'owned',
  ) {
    await this.sql`
      INSERT INTO recommendation_feedback (user_id, game_id, action)
      VALUES (${userId}, ${gameId}, ${action})
      ON CONFLICT (user_id, game_id) DO UPDATE SET action = EXCLUDED.action, created_at = now()
    `
  }

  async replacePreferences(
    userId: string,
    input: { genres: string[]; platforms: string[] },
  ) {
    await this.sql.begin(async (tx) => {
      await tx`
        DELETE FROM user_preferences
        WHERE user_id = ${userId} AND source = 'explicit' AND key IN ('genre', 'platform')
      `
      for (const genre of input.genres) {
        await tx`
          INSERT INTO user_preferences (user_id, key, value, source, weight)
          VALUES (${userId}, 'genre', ${genre.toLowerCase()}, 'explicit', 1)
        `
      }
      for (const platform of input.platforms) {
        await tx`
          INSERT INTO user_preferences (user_id, key, value, source, weight)
          VALUES (${userId}, 'platform', ${platform.toLowerCase()}, 'explicit', 1)
        `
      }
    })
  }

  async createSteamLinkToken(userId: string, nonceHash: string, expiresAt: Date) {
    await this.sql`
      INSERT INTO steam_link_tokens (nonce_hash, user_id, expires_at)
      VALUES (${nonceHash}, ${userId}, ${expiresAt})
    `
  }

  async getSteamLinkToken(nonceHash: string) {
    const rows = await this.sql`
      SELECT user_id, expires_at, consumed_at FROM steam_link_tokens WHERE nonce_hash = ${nonceHash}
    `
    const row = rows[0]
    if (!row) return null
    return {
      userId: string(row.user_id),
      expiresAt: new Date(string(row.expires_at)),
      consumedAt: row.consumed_at ? new Date(string(row.consumed_at)) : null,
    }
  }

  async consumeSteamLinkToken(nonceHash: string, steamId: string) {
    return this.sql.begin(async (tx) => {
      const consumed = await tx`
        UPDATE steam_link_tokens SET consumed_at = now()
        WHERE nonce_hash = ${nonceHash} AND consumed_at IS NULL AND expires_at > now()
        RETURNING user_id
      `
      const userId = consumed[0]?.user_id ? string(consumed[0].user_id) : null
      if (!userId) return null
      await tx`
        INSERT INTO steam_accounts (user_id, steam_id)
        VALUES (${userId}, ${steamId})
        ON CONFLICT (user_id) DO UPDATE SET steam_id = EXCLUDED.steam_id, linked_at = now()
      `
      await tx`
        INSERT INTO audit_logs (user_id, action, resource_type, resource_id)
        VALUES (${userId}, 'steam.linked', 'steam_account', ${steamId})
      `
      return userId
    })
  }

  async getSteamAccount(userId: string) {
    const rows = await this.sql`
      SELECT steam_id, profile_visibility, last_sync_at FROM steam_accounts WHERE user_id = ${userId}
    `
    return rows[0]
      ? {
          steamId: string(rows[0].steam_id),
          profileVisibility: string(rows[0].profile_visibility),
          lastSyncAt: rows[0].last_sync_at ? new Date(string(rows[0].last_sync_at)) : null,
        }
      : null
  }

  async listSteamAccounts(limit = 500) {
    const rows = await this.sql`
      SELECT s.user_id, s.steam_id, s.last_sync_at
      FROM steam_accounts s JOIN users u ON u.id = s.user_id
      WHERE u.status = 'active'
      ORDER BY s.last_sync_at NULLS FIRST
      LIMIT ${limit}
    `
    return rows.map((row) => ({
      userId: string(row.user_id),
      steamId: string(row.steam_id),
      lastSyncAt: row.last_sync_at ? new Date(string(row.last_sync_at)) : null,
    }))
  }

  async insertProviderEvent(
    provider: string,
    eventId: string,
    payloadHash: string,
    eventType: string,
  ) {
    const rows = await this.sql`
      INSERT INTO provider_events (provider, external_event_id, payload_hash, event_type)
      VALUES (${provider}, ${eventId}, ${payloadHash}, ${eventType})
      ON CONFLICT (provider, external_event_id) DO NOTHING
      RETURNING id
    `
    return rows.length > 0
  }

  async recordProviderMessageAndEnqueue(
    provider: string,
    eventId: string,
    payloadHash: string,
    payload: unknown,
    maxAttempts = 5,
  ) {
    return this.sql.begin(async (tx) => {
      const events = await tx`
        INSERT INTO provider_events (provider, external_event_id, payload_hash, event_type)
        VALUES (${provider}, ${eventId}, ${payloadHash}, 'message')
        ON CONFLICT (provider, external_event_id) DO NOTHING
        RETURNING id
      `
      if (!events[0]) return false
      await tx`
        INSERT INTO jobs (type, payload, dedupe_key, max_attempts)
        VALUES (
          'process-channel-message', ${tx.json(jsonValue(payload))},
          ${`${provider}-message:${eventId}`}, ${maxAttempts}
        )
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('pending', 'running')
        DO NOTHING
      `
      return true
    })
  }

  async createNotification(
    userId: string,
    type: string,
    payload: unknown,
    idempotencyKey: string,
    scheduledAt = new Date(),
  ) {
    const rows = await this.sql`
      INSERT INTO notification_events (user_id, type, payload, idempotency_key, scheduled_at)
      VALUES (${userId}, ${type}, ${this.sql.json(jsonValue(payload))}, ${idempotencyKey}, ${scheduledAt})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    `
    return rows[0]?.id ? string(rows[0].id) : null
  }

  async createNotificationAndEnqueue(
    userId: string,
    type: string,
    payload: unknown,
    idempotencyKey: string,
    scheduledAt: Date,
    maxAttempts = 5,
  ) {
    return this.sql.begin(async (tx) => {
      const notifications = await tx`
        INSERT INTO notification_events (user_id, type, payload, idempotency_key, scheduled_at)
        VALUES (${userId}, ${type}, ${tx.json(jsonValue(payload))}, ${idempotencyKey}, ${scheduledAt})
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id
      `
      const notificationId = notifications[0]?.id ? string(notifications[0].id) : null
      if (!notificationId) return null
      await tx`
        INSERT INTO jobs (type, payload, run_at, dedupe_key, max_attempts)
        VALUES (
          'send-notification', ${tx.json({ notificationId })}, ${scheduledAt},
          ${`send-notification:${notificationId}`}, ${maxAttempts}
        )
      `
      return notificationId
    })
  }

  async createDigestNotificationAndEnqueue(
    userId: string,
    type: string,
    payload: unknown,
    idempotencyKey: string,
    scheduledAt: Date,
    maxAttempts = 5,
  ) {
    return this.sql.begin(async (tx) => {
      const notifications = await tx`
        INSERT INTO notification_events (user_id, type, payload, idempotency_key, scheduled_at)
        VALUES (${userId}, ${type}, ${tx.json(jsonValue(payload))}, ${idempotencyKey}, ${scheduledAt})
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id
      `
      if (!notifications[0]) return null
      const digestBucket = scheduledAt.toISOString().slice(0, 13)
      await tx`
        INSERT INTO jobs (type, payload, run_at, dedupe_key, max_attempts)
        VALUES (
          'send-digest', ${tx.json({ userId })}, ${scheduledAt},
          ${`send-digest:${userId}:${digestBucket}`}, ${maxAttempts}
        )
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('pending', 'running')
        DO NOTHING
      `
      return string(notifications[0].id)
    })
  }

  async getNotification(notificationId: string) {
    const rows = await this.sql`
      SELECT n.*, u.notifications_enabled
      FROM notification_events n JOIN users u ON u.id = n.user_id
      WHERE n.id = ${notificationId}
    `
    return rows[0] ? rows[0] as Row : null
  }

  async claimNotificationForSend(notificationId: string) {
    const rows = await this.sql`
      UPDATE notification_events n SET state = 'sending', updated_at = now()
      FROM users u
      WHERE n.id = ${notificationId}
        AND n.user_id = u.id
        AND n.state IN ('pending', 'sending')
        AND n.scheduled_at <= now()
        AND u.status = 'active'
        AND u.notifications_enabled = true
      RETURNING n.*, u.notifications_enabled
    `
    return rows[0] ? rows[0] as Row : null
  }

  async claimDigestNotifications(userId: string, limit = 10) {
    const rows = await this.sql`
      WITH selected AS (
        SELECT n.id FROM notification_events n
        JOIN users u ON u.id = n.user_id
        WHERE n.user_id = ${userId}
          AND n.type = 'wishlist_price_alert'
          AND n.state = 'pending'
          AND n.scheduled_at <= now()
          AND u.status = 'active'
          AND u.notifications_enabled = true
        ORDER BY n.scheduled_at, n.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE notification_events n SET state = 'sending', updated_at = now()
      FROM selected s WHERE n.id = s.id
      RETURNING n.id, n.payload
    `
    return rows.map((row) => ({ id: string(row.id), payload: row.payload as Row }))
  }

  async suppressNotification(notificationId: string) {
    await this.sql`
      UPDATE notification_events SET state = 'suppressed', updated_at = now()
      WHERE id = ${notificationId} AND state IN ('pending', 'sending')
    `
  }

  async releaseNotificationForRetry(notificationId: string) {
    await this.sql`
      UPDATE notification_events SET state = 'pending', updated_at = now()
      WHERE id = ${notificationId} AND state = 'sending'
    `
  }

  async markNotificationFailed(notificationId: string) {
    await this.sql`
      UPDATE notification_events SET state = 'failed', updated_at = now()
      WHERE id = ${notificationId} AND state = 'sending'
    `
  }

  async releaseDigestForRetry(userId: string) {
    await this.sql`
      UPDATE notification_events SET state = 'pending', updated_at = now()
      WHERE user_id = ${userId} AND type = 'wishlist_price_alert' AND state = 'sending'
    `
  }

  async markDigestFailed(userId: string) {
    await this.sql`
      UPDATE notification_events SET state = 'failed', updated_at = now()
      WHERE user_id = ${userId} AND type = 'wishlist_price_alert' AND state = 'sending'
    `
  }

  async recentNotificationCount(userId: string) {
    const rows = await this.sql`
      SELECT COUNT(*)::int AS count FROM notification_events
      WHERE user_id = ${userId} AND sent_at >= now() - interval '24 hours'
    `
    return number(rows[0]?.count)
  }

  async markNotificationSent(notificationId: string, providerMessageId: string) {
    await this.sql`
      UPDATE notification_events
      SET state = 'sent', provider_message_id = ${providerMessageId}, sent_at = now(), updated_at = now()
      WHERE id = ${notificationId} AND state IN ('pending', 'sending')
    `
  }

  async markDigestSent(notificationIds: string[], providerMessageId: string) {
    if (notificationIds.length === 0) return
    await this.sql`
      UPDATE notification_events
      SET state = 'sent', provider_message_id = ${providerMessageId}, sent_at = now(), updated_at = now()
      WHERE id IN ${this.sql(notificationIds)} AND state = 'sending'
    `
  }

  async enqueueJob(
    type: string,
    payload: unknown,
    options: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {},
  ) {
    const rows = await this.sql`
      INSERT INTO jobs (type, payload, run_at, dedupe_key, max_attempts)
      VALUES (
        ${type}, ${this.sql.json(jsonValue(payload))}, ${options.runAt ?? new Date()},
        ${options.dedupeKey ?? null}, ${options.maxAttempts ?? 5}
      )
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('pending', 'running')
      DO NOTHING
      RETURNING id
    `
    return rows[0]?.id ? string(rows[0].id) : null
  }

  async claimJobs(workerId: string, limit = 10): Promise<ClaimedJob[]> {
    const rows = await this.sql`
      WITH claimable AS (
        SELECT id FROM jobs
        WHERE (
          state = 'pending' AND run_at <= now()
        ) OR (
          state = 'running' AND locked_at < now() - interval '5 minutes'
        )
        ORDER BY run_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE jobs j SET
        state = 'running',
        locked_at = now(),
        locked_by = ${workerId},
        attempts = attempts + 1,
        updated_at = now()
      FROM claimable c
      WHERE j.id = c.id
      RETURNING j.id, j.type, j.payload, j.attempts, j.max_attempts
    `
    return rows.map((row) => ({
      id: string(row.id),
      type: string(row.type),
      payload: row.payload,
      attempts: number(row.attempts),
      maxAttempts: number(row.max_attempts),
    }))
  }

  async completeJob(jobId: string) {
    await this.sql`
      UPDATE jobs SET state = 'completed', locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE id = ${jobId}
    `
  }

  async failJob(
    job: ClaimedJob,
    errorCode: string,
    retryable: boolean,
    retryAfterMs?: number,
  ) {
    const dead = !retryable || job.attempts >= job.maxAttempts
    const exponentialDelayMs = Math.min(3_600_000, 2 ** Math.max(0, job.attempts) * 15_000)
    const delayMs = Math.max(exponentialDelayMs, retryAfterMs ?? 0)
    await this.sql`
      UPDATE jobs SET
        state = ${dead ? 'dead' : 'pending'},
        run_at = ${new Date(Date.now() + delayMs)},
        locked_at = NULL,
        locked_by = NULL,
        last_error_code = ${errorCode.slice(0, 120)},
        updated_at = now()
      WHERE id = ${job.id}
    `
  }

  async jobStats() {
    const rows = await this.sql`
      SELECT state, COUNT(*)::int AS count FROM jobs GROUP BY state ORDER BY state
    `
    return Object.fromEntries(rows.map((row) => [string(row.state), number(row.count)]))
  }

  async enabledFeature(key: string) {
    const rows = await this.sql`SELECT enabled FROM feature_flags WHERE key = ${key}`
    return rows[0] ? boolean(rows[0].enabled) : false
  }
}
