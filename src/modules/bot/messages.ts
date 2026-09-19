import type { Deal, Recommendation, WeeklyPlaytime, WishlistItem } from '../../domain/types'
import { formatMoney } from '../../domain/money'

export const helpMessage = `Halo! Saya Steam Discount Bot 🎮

Perintah yang tersedia:
• /diskon <nama game>
• /wishlist tambah <nama game>
• /wishlist atur <game> diskon <persen>
• /wishlist
• /statistik
• /pengeluaran
• /rekomendasi
• /linksteam
• /notifikasi on|off

Saya tidak pernah meminta password, cookie, atau Steam Guard.`

export function formatDeals(deals: Deal[]) {
  if (deals.length === 0) return 'Belum menemukan deal yang cocok. Coba judul yang lebih spesifik.'
  return deals.map((deal, index) => {
    const low = deal.historicalLow
      ? `${formatMoney(deal.historicalLow)}${deal.historicalLowAt ? ` pada ${new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium' }).format(new Date(deal.historicalLowAt))}` : ''}`
      : 'Histori belum tersedia'
    return `${index + 1}. ${deal.game.title} — ${deal.shop}
Normal: ${formatMoney(deal.regular)}
Sekarang: ${formatMoney(deal.current)} (-${deal.cutPercent}%)
Terendah: ${low}
Wilayah: ${deal.country} · Sumber: ${deal.source}
${deal.url}`
  }).join('\n\n')
}

export function formatWishlist(items: WishlistItem[]) {
  if (items.length === 0) return 'Wishlist-mu masih kosong. Tambahkan dengan /wishlist tambah <nama game>.'
  return `❤️ Wishlist kamu\n\n${items.map((item, index) => {
    const targets = [
      item.rule.maxPriceMinor === null ? null : `maks. ${formatMoney({ amountMinor: item.rule.maxPriceMinor, currency: 'IDR' })}`,
      item.rule.minCutPercent === null ? null : `diskon ≥${item.rule.minCutPercent}%`,
      item.rule.historicalLowOnly ? 'historical low' : null,
    ].filter(Boolean).join(', ')
    return `${index + 1}. ${item.game.title} — ${item.active ? 'aktif' : 'jeda'} (${targets})`
  }).join('\n')}`
}

export function formatWeekly(stats: WeeklyPlaytime) {
  const hours = Math.floor(stats.totalMinutes / 60)
  const minutes = stats.totalMinutes % 60
  const top = stats.topGames.length
    ? stats.topGames.map((item) => `• ${item.title}: ${Math.floor(item.minutes / 60)}j ${item.minutes % 60}m`).join('\n')
    : 'Belum ada perubahan playtime yang teramati.'
  const period = stats.coverageDays >= 7 ? '7 hari terakhir' : 'sejak pemantauan dimulai'
  return `📊 Statistik ${period}

Total: ${hours}j ${minutes}m
Game aktif: ${stats.activeGames}
Coverage: ${stats.coverageDays}/7 hari

${top}`
}

export function formatRecommendations(recommendations: Recommendation[]) {
  if (recommendations.length === 0) {
    return 'Data rekomendasi belum cukup. Tambahkan wishlist atau hubungkan Steam terlebih dahulu.'
  }
  return `✨ Rekomendasi untukmu\n\n${recommendations.map((item, index) => {
    const price = item.deal ? ` · ${formatMoney(item.deal.current)} (-${item.deal.cutPercent}%)` : ''
    return `${index + 1}. ${item.game.title}${price}\n   ${item.reasons.join('; ')}`
  }).join('\n\n')}`
}
