import type { AppDependencies } from '../dependencies'
import { formatMoney } from '../domain/money'
import { evaluateWishlistRule, isQuietHour, notificationIdempotencyKey } from '../domain/wishlist'
import { ProviderError } from '../integrations/http'
import { formatWeekly } from '../modules/bot/messages'
import { BotService } from '../modules/bot/service'
import type { ClaimedJob } from '../repository'

const nextAllowedTime = (
  timezone: string,
  quietStart: number,
  quietEnd: number,
  now = new Date(),
) => {
  if (!isQuietHour(now, timezone, quietStart, quietEnd)) return now
  let candidate = new Date(now)
  for (let step = 0; step < 96; step += 1) {
    candidate = new Date(candidate.getTime() + 15 * 60_000)
    if (!isQuietHour(candidate, timezone, quietStart, quietEnd)) return candidate
  }
  return new Date(now.getTime() + 12 * 60 * 60_000)
}

const payloadObject = (job: ClaimedJob) => {
  if (!job.payload || typeof job.payload !== 'object') throw new Error('invalid_job_payload')
  return job.payload as Record<string, unknown>
}

export class JobWorker {
  private readonly bot: BotService

  constructor(private readonly deps: AppDependencies) {
    this.bot = new BotService({
      repository: deps.repository,
      pricing: deps.pricing,
      messaging: deps.messaging,
      steam: deps.steam,
      decryptAddress: deps.decryptAddress,
      publicBaseUrl: deps.config.publicBaseUrl,
      logger: deps.logger,
    })
  }

  async process(job: ClaimedJob) {
    const payload = payloadObject(job)
    switch (job.type) {
      case 'process-channel-message':
        await this.bot.handleMessage({
          eventId: String(payload.eventId ?? ''),
          encryptedAddress: String(payload.encryptedAddress ?? ''),
          addressHash: String(payload.addressHash ?? ''),
          text: String(payload.text ?? ''),
          ...(payload.interactionId ? { interactionId: String(payload.interactionId) } : {}),
        })
        return
      case 'refresh-wishlist':
        await this.refreshWishlist()
        return
      case 'send-notification':
        await this.sendNotification(String(payload.notificationId ?? ''))
        return
      case 'send-digest':
        await this.sendDigest(String(payload.userId ?? ''))
        return
      case 'sync-all-steam':
        await this.enqueueSteamSyncs()
        return
      case 'sync-steam':
        await this.syncSteam(String(payload.userId ?? ''))
        return
      case 'weekly-reports':
        await this.enqueueWeeklyReports()
        return
      case 'weekly-report':
        await this.createWeeklyReport(String(payload.userId ?? ''))
        return
      default:
        throw new Error('unknown_job_type')
    }
  }

  private async refreshWishlist() {
    if (!await this.deps.repository.enabledFeature('notifications.enabled')) return
    const items = await this.deps.repository.listActiveWishlistForRefresh()
    for (const item of items) {
      const deal = await this.deps.pricing.getDeal(item.game, item.user.country, item.user.currency)
      if (!deal) continue
      const persisted = await this.deps.repository.persistDeal(deal)
      const match = evaluateWishlistRule(item.rule, persisted)
      if (!match.matched || !item.user.notificationsEnabled) continue

      let scheduledAt = nextAllowedTime(
        item.user.timezone,
        item.user.quietStart,
        item.user.quietEnd,
      )
      const recent = await this.deps.repository.recentNotificationCount(item.user.id)
      if (recent >= 5 || item.user.notificationMode === 'digest') {
        scheduledAt = new Date(Math.max(scheduledAt.getTime(), Date.now() + 12 * 60 * 60_000))
      }
      const low = persisted.historicalLow ? formatMoney(persisted.historicalLow) : 'belum tersedia'
      const fallbackText = `🎯 ${persisted.game.title} mencapai targetmu. Sekarang ${formatMoney(persisted.current)} (-${persisted.cutPercent}%). Terendah historis: ${low}. ${persisted.url}`
      const notificationPayload = {
        text: fallbackText,
        gameId: persisted.game.id,
        deal: persisted,
        reasons: match.reasons,
      }
      if (item.user.notificationMode === 'digest' || recent >= 5) {
        await this.deps.repository.createDigestNotificationAndEnqueue(
          item.user.id,
          'wishlist_price_alert',
          notificationPayload,
          notificationIdempotencyKey(item.user.id, persisted),
          scheduledAt,
          this.deps.config.scheduler.jobMaxAttempts,
        )
      } else {
        await this.deps.repository.createNotificationAndEnqueue(
          item.user.id,
          'wishlist_price_alert',
          notificationPayload,
          notificationIdempotencyKey(item.user.id, persisted),
          scheduledAt,
          this.deps.config.scheduler.jobMaxAttempts,
        )
      }
    }
  }

  private async sendNotification(notificationId: string) {
    if (!notificationId) throw new Error('invalid_notification_id')
    const notification = await this.deps.repository.claimNotificationForSend(notificationId)
    if (!notification) return
    const user = await this.deps.repository.getUser(String(notification.user_id))
    if (!user?.notificationsEnabled) {
      await this.deps.repository.suppressNotification(notificationId)
      return
    }
    const encryptedAddress = await this.deps.repository.getEncryptedChannelAddress(user.id)
    if (!encryptedAddress) throw new Error('channel_address_missing')
    const address = await this.deps.decryptAddress(encryptedAddress)
    const payload = notification.payload as { text?: string }
    const sent = await this.deps.messaging.sendText(address, payload.text ?? 'Ada notifikasi baru.')
    await this.deps.repository.markNotificationSent(notificationId, sent.providerMessageId)
  }

  private async sendDigest(userId: string) {
    if (!userId) throw new Error('invalid_user_id')
    const user = await this.deps.repository.getUser(userId)
    if (!user?.notificationsEnabled) return
    const notifications = await this.deps.repository.claimDigestNotifications(userId, 10)
    if (notifications.length === 0) return
    const encryptedAddress = await this.deps.repository.getEncryptedChannelAddress(userId)
    if (!encryptedAddress) throw new Error('channel_address_missing')
    const address = await this.deps.decryptAddress(encryptedAddress)
    const lines = notifications.map((notification, index) => {
      const payload = notification.payload as { text?: string }
      return `${index + 1}. ${payload.text ?? 'Deal wishlist baru.'}`
    })
    const digestText = `🔥 Digest deal wishlist\n\n${lines.join('\n\n')}`.slice(0, 4_000)
    const sent = await this.deps.messaging.sendText(address, digestText)
    await this.deps.repository.markDigestSent(
      notifications.map((notification) => notification.id),
      sent.providerMessageId,
    )
  }

  private async enqueueSteamSyncs() {
    if (!await this.deps.repository.enabledFeature('steam.sync.enabled')) return
    for (const account of await this.deps.repository.listSteamAccounts()) {
      await this.deps.repository.enqueueJob('sync-steam', { userId: account.userId }, {
        dedupeKey: `sync-steam:${account.userId}`,
        maxAttempts: this.deps.config.scheduler.jobMaxAttempts,
      })
    }
  }

  private async syncSteam(userId: string) {
    const account = await this.deps.repository.getSteamAccount(userId)
    if (!account) return
    const games = await this.deps.steam.getOwnedGames(account.steamId)
    await this.deps.repository.syncOwnedGames(userId, games)
  }

  private async enqueueWeeklyReports() {
    for (const account of await this.deps.repository.listSteamAccounts()) {
      await this.deps.repository.enqueueJob('weekly-report', { userId: account.userId }, {
        dedupeKey: `weekly-report:${account.userId}:${new Date().toISOString().slice(0, 10)}`,
        maxAttempts: this.deps.config.scheduler.jobMaxAttempts,
      })
    }
  }

  private async createWeeklyReport(userId: string) {
    const user = await this.deps.repository.getUser(userId)
    if (!user?.notificationsEnabled) return
    const stats = await this.deps.repository.weeklyPlaytime(userId)
    if (stats.coverageDays === 0) return
    const scheduledAt = nextAllowedTime(user.timezone, user.quietStart, user.quietEnd)
    await this.deps.repository.createNotificationAndEnqueue(
      userId,
      'weekly_report',
      {
        text: formatWeekly(stats),
      },
      `weekly-report:${userId}:${new Date().toISOString().slice(0, 10)}`,
      scheduledAt,
      this.deps.config.scheduler.jobMaxAttempts,
    )
  }

  async runOnce(workerId: string, limit = 10) {
    const jobs = await this.deps.repository.claimJobs(workerId, limit)
    for (const job of jobs) {
      try {
        await this.process(job)
        await this.deps.repository.completeJob(job.id)
      } catch (error) {
        const retryable = error instanceof ProviderError ? error.retryable : true
        const terminal = !retryable || job.attempts >= job.maxAttempts
        const failedPayload = job.payload && typeof job.payload === 'object'
          ? job.payload as Record<string, unknown>
          : {}
        const code = error instanceof ProviderError
          ? `${error.provider}.${error.code}`
          : error instanceof Error
            ? error.message.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120)
            : 'unknown_error'
        if (job.type === 'send-notification') {
          const notificationId = String(failedPayload.notificationId ?? '')
          if (notificationId) {
            if (terminal) await this.deps.repository.markNotificationFailed(notificationId)
            else await this.deps.repository.releaseNotificationForRetry(notificationId)
          }
        }
        if (job.type === 'send-digest') {
          const userId = String(failedPayload.userId ?? '')
          if (userId) {
            if (terminal) await this.deps.repository.markDigestFailed(userId)
            else await this.deps.repository.releaseDigestForRetry(userId)
          }
        }
        await this.deps.repository.failJob(
          job,
          code,
          retryable,
          error instanceof ProviderError ? error.retryAfterMs : undefined,
        )
        this.deps.logger.error('job_failed', { jobId: job.id, jobType: job.type, code, retryable })
      }
    }
    return jobs.length
  }
}
