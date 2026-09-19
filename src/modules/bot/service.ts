import { formatMoney } from '../../domain/money'
import { rankRecommendations } from '../../domain/recommendation'
import { sha256 } from '../../lib/crypto'
import type { Logger } from '../../lib/logger'
import type { MessagingProvider, PriceProvider, SteamProvider } from '../../ports'
import type { Repository } from '../../repository'
import { parseIntent } from './intent'
import {
  formatDeals,
  formatRecommendations,
  formatWeekly,
  formatWishlist,
  helpMessage,
} from './messages'

export interface BotServiceDependencies {
  repository: Repository
  pricing: PriceProvider
  messaging: MessagingProvider
  steam: SteamProvider
  decryptAddress: (value: string) => Promise<string>
  publicBaseUrl: string
  logger: Logger
}

export class BotService {
  constructor(private readonly deps: BotServiceDependencies) {}

  async handleMessage(input: {
    eventId: string
    encryptedAddress: string
    addressHash: string
    text: string
    interactionId?: string
  }) {
    const user = await this.deps.repository.getOrCreateChannelUser(
      'telegram',
      input.addressHash,
      input.encryptedAddress,
    )
    const address = await this.deps.decryptAddress(input.encryptedAddress)
    if (input.interactionId) {
      try {
        await this.deps.messaging.acknowledgeInteraction(input.interactionId)
      } catch {
        this.deps.logger.warn('telegram_callback_ack_failed', { userId: user.id })
      }
    }
    const intent = parseIntent(input.text)
    let reply = helpMessage

    switch (intent.type) {
      case 'notifications':
        await this.deps.repository.setNotifications(user.id, intent.enabled)
        reply = intent.enabled
          ? 'Notifikasi aktif. Saya akan mengabari saat rule wishlist-mu tercapai.'
          : 'Notifikasi proaktif dihentikan. Kamu tetap bisa memakai perintah pencarian.'
        break
      case 'search': {
        const deals = await this.deps.pricing.searchDeals({
          query: intent.query,
          country: user.country,
          currency: user.currency,
          limit: 5,
        })
        const persisted = []
        for (const deal of deals) persisted.push(await this.deps.repository.persistDeal(deal))
        reply = formatDeals(persisted)
        break
      }
      case 'wishlist-add': {
        const deals = await this.deps.pricing.searchDeals({
          query: intent.query,
          country: user.country,
          currency: user.currency,
          limit: 1,
        })
        const deal = deals[0]
        if (!deal) {
          reply = 'Game tidak ditemukan. Coba gunakan judul yang lebih spesifik.'
          break
        }
        const persisted = await this.deps.repository.persistDeal(deal)
        await this.deps.repository.addWishlist(user.id, persisted.game.id, {
          maxPriceMinor: null,
          minCutPercent: 30,
          historicalLowOnly: false,
        })
        reply = `${persisted.game.title} ditambahkan ke wishlist dengan target diskon minimal 30%.`
        break
      }
      case 'wishlist-list':
        reply = formatWishlist(await this.deps.repository.listWishlist(user.id))
        break
      case 'wishlist-remove': {
        const items = await this.deps.repository.listWishlist(user.id)
        const match = items.find((item) => item.game.title.toLowerCase().includes(intent.query.toLowerCase()))
        reply = match && await this.deps.repository.deleteWishlist(user.id, match.id)
          ? `${match.game.title} dihapus dari wishlist.`
          : 'Game tersebut tidak ditemukan di wishlist-mu.'
        break
      }
      case 'wishlist-update': {
        const items = await this.deps.repository.listWishlist(user.id)
        const match = items.find((item) => item.game.title.toLowerCase().includes(intent.query.toLowerCase()))
        if (!match) {
          reply = 'Game tersebut tidak ditemukan di wishlist-mu.'
          break
        }
        const rule = {
          ...match.rule,
          ...(intent.maxPriceMinor === undefined ? {} : { maxPriceMinor: intent.maxPriceMinor }),
          ...(intent.minCutPercent === undefined ? {} : { minCutPercent: intent.minCutPercent }),
          ...(intent.historicalLowOnly === undefined ? {} : { historicalLowOnly: intent.historicalLowOnly }),
        }
        await this.deps.repository.updateWishlist(user.id, match.id, { active: true, rule })
        reply = `Target ${match.game.title} berhasil diperbarui.`
        break
      }
      case 'wishlist-pause':
        await this.deps.repository.pauseWishlist(user.id)
        reply = 'Semua pemantauan wishlist dijeda.'
        break
      case 'stats':
        reply = formatWeekly(await this.deps.repository.weeklyPlaytime(user.id))
        break
      case 'expenses': {
        const summary = await this.deps.repository.purchaseSummary(user.id)
        const replacement = summary?.replacementValues
          .map((item) => `${formatMoney({ amountMinor: item.currentAmountMinor, currency: item.currency })} saat diskon / ${formatMoney({ amountMinor: item.regularAmountMinor, currency: item.currency })} normal (${item.pricedGames} game)`)
          .join('\n')
        reply = summary
          ? `💳 Pengeluaran tercatat\n${summary.totals.length ? summary.totals.map((item) => `${formatMoney(item)} (${item.records} catatan)`).join('\n') : formatMoney({ amountMinor: 0, currency: user.currency })}\nCoverage purchase record: ${summary.coveragePercent}%\n\nNilai pengganti library:\n${replacement || 'Belum cukup data harga.'}\n\n${summary.disclaimer}`
          : 'Pengguna tidak ditemukan.'
        break
      }
      case 'purchase-add': {
        const deals = await this.deps.pricing.searchDeals({
          query: intent.query,
          country: user.country,
          currency: user.currency,
          limit: 1,
        })
        const deal = deals[0]
        if (!deal) {
          reply = 'Game tidak ditemukan sehingga pembelian belum dicatat.'
          break
        }
        const persisted = await this.deps.repository.persistDeal(deal)
        await this.deps.repository.addPurchase(user.id, {
          gameId: persisted.game.id,
          amountMinor: intent.amountMinor,
          currency: user.currency,
          purchasedAt: intent.purchasedAt,
          ...(intent.store ? { store: intent.store } : {}),
          acquisitionType: 'paid',
        })
        reply = `Pembelian ${persisted.game.title} sebesar ${formatMoney({ amountMinor: intent.amountMinor, currency: user.currency })} tercatat.`
        break
      }
      case 'recommendations': {
        const data = await this.deps.repository.recommendationData(user.id)
        reply = formatRecommendations(rankRecommendations({
          genreWeights: data.genreWeights,
          platforms: data.platforms,
          excludedGameIds: data.excludedGameIds,
          maxPriceMinor: null,
          currency: user.currency,
        }, data.candidates, 5))
        break
      }
      case 'steam-link': {
        const bytes = crypto.getRandomValues(new Uint8Array(32))
        const token = Buffer.from(bytes).toString('base64url')
        await this.deps.repository.createSteamLinkToken(
          user.id,
          await sha256(token),
          new Date(Date.now() + 10 * 60_000),
        )
        reply = `Hubungkan Steam melalui tautan satu kali ini (berlaku 10 menit):\n${this.deps.publicBaseUrl}/auth/steam/start?token=${encodeURIComponent(token)}\n\nSaya tidak pernah meminta password atau Steam Guard.`
        break
      }
      case 'delete-request':
        reply = 'Tindakan ini akan menonaktifkan akun dan menjadwalkan penghapusan data. Balas persis: KONFIRMASI HAPUS DATA'
        break
      case 'delete-confirm':
        await this.deps.repository.requestUserDeletion(user.id)
        reply = 'Permintaan penghapusan diterima. Notifikasi dihentikan segera.'
        break
      case 'help':
      case 'unknown':
        reply = helpMessage
        break
    }

    const sent = await this.deps.messaging.sendText(address, reply)
    this.deps.logger.info('bot_reply_sent', {
      userId: user.id,
      intent: intent.type,
      providerMessageId: sent.providerMessageId,
    })
  }
}
