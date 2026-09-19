export type BotIntent =
  | { type: 'help' }
  | { type: 'notifications'; enabled: boolean }
  | { type: 'search'; query: string }
  | { type: 'wishlist-list' }
  | { type: 'wishlist-add'; query: string }
  | { type: 'wishlist-remove'; query: string }
  | { type: 'wishlist-update'; query: string; maxPriceMinor?: number; minCutPercent?: number; historicalLowOnly?: boolean }
  | { type: 'wishlist-pause' }
  | { type: 'stats' }
  | { type: 'expenses' }
  | { type: 'purchase-add'; query: string; amountMinor: number; purchasedAt: string; store?: string }
  | { type: 'recommendations' }
  | { type: 'steam-link' }
  | { type: 'delete-request' }
  | { type: 'delete-confirm' }
  | { type: 'unknown' }

const normalize = (text: string) => text.trim().replace(/\s+/g, ' ')

export function parseIntent(text: string, now = new Date()): BotIntent {
  const normalized = normalize(text)
  const lower = normalized.toLocaleLowerCase('id-ID')

  if (['stop', 'berhenti', '/notifikasi off'].includes(lower)) {
    return { type: 'notifications', enabled: false }
  }
  if (['mulai', '/notifikasi on'].includes(lower)) {
    return { type: 'notifications', enabled: true }
  }
  if (lower === '/wishlist' || lower === 'wishlist') return { type: 'wishlist-list' }
  if (lower === '/wishlist jeda') return { type: 'wishlist-pause' }
  if (lower.startsWith('/wishlist tambah ')) {
    return { type: 'wishlist-add', query: normalized.slice('/wishlist tambah '.length).trim() }
  }
  if (lower.startsWith('/wishlist hapus ')) {
    return { type: 'wishlist-remove', query: normalized.slice('/wishlist hapus '.length).trim() }
  }
  const wishlistUpdate = /^\/wishlist atur\s+(.+?)\s+(?:diskon\s+(\d{1,3})|harga\s+([0-9.]+)|(terendah))$/i.exec(normalized)
  if (wishlistUpdate?.[1]) {
    const result: BotIntent = { type: 'wishlist-update', query: wishlistUpdate[1].trim() }
    if (wishlistUpdate[2]) result.minCutPercent = Math.min(100, Number(wishlistUpdate[2]))
    if (wishlistUpdate[3]) result.maxPriceMinor = Number(wishlistUpdate[3].replaceAll('.', ''))
    if (wishlistUpdate[4]) result.historicalLowOnly = true
    return result
  }
  if (lower === '/statistik' || lower === 'statistik') return { type: 'stats' }
  if (lower === '/pengeluaran' || lower === 'pengeluaran') return { type: 'expenses' }
  if (lower === '/rekomendasi' || lower.includes('rekomendasi untuk saya')) {
    return { type: 'recommendations' }
  }
  if (lower === '/linksteam' || lower === 'hubungkan steam') return { type: 'steam-link' }
  if (lower === '/hapusdata') return { type: 'delete-request' }
  if (lower === 'konfirmasi hapus data') return { type: 'delete-confirm' }

  const purchase = /^\/beli tambah\s+(.+?)\s+([0-9][0-9.]*)?(?:\s+tanggal\s+(\d{4}-\d{2}-\d{2}))?(?:\s+toko\s+(.+))?$/i.exec(normalized)
  if (purchase?.[1] && purchase[2]) {
    const amountMinor = Number.parseInt(purchase[2].replaceAll('.', ''), 10)
    if (Number.isSafeInteger(amountMinor) && amountMinor >= 0) {
      const result: BotIntent = {
        type: 'purchase-add',
        query: purchase[1].trim(),
        amountMinor,
        purchasedAt: purchase[3] ?? now.toISOString().slice(0, 10),
      }
      if (purchase[4]) result.store = purchase[4].trim()
      return result
    }
  }

  if (lower === '/diskon' || lower === 'diskon' || lower === 'game sedang diskon') {
    return { type: 'search', query: '' }
  }
  if (lower.startsWith('/diskon ')) {
    return { type: 'search', query: normalized.slice('/diskon '.length).trim() }
  }
  const naturalSearch = /^(?:cari(?:kan)?|cek)\s+(?:diskon\s+)?(.+)$/i.exec(normalized)
  if (naturalSearch?.[1]) return { type: 'search', query: naturalSearch[1].trim() }

  if (['hai', 'halo', 'hi', 'menu', '/start', '/help', 'bantuan'].includes(lower)) {
    return { type: 'help' }
  }
  return { type: 'unknown' }
}
