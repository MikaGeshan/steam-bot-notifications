import { describe, expect, test } from 'bun:test'
import { parseIntent } from '../../src/modules/bot/intent'

describe('bot intent parser', () => {
  test.each([
    ['STOP', { type: 'notifications', enabled: false }],
    ['/notifikasi on', { type: 'notifications', enabled: true }],
    ['/diskon Elden Ring', { type: 'search', query: 'Elden Ring' }],
    ['/wishlist tambah Hades', { type: 'wishlist-add', query: 'Hades' }],
    ['/wishlist hapus Hades', { type: 'wishlist-remove', query: 'Hades' }],
    ['/wishlist atur Hades diskon 50', { type: 'wishlist-update', query: 'Hades', minCutPercent: 50 }],
    ['/statistik', { type: 'stats' }],
    ['/linksteam', { type: 'steam-link' }],
  ])('parses %s', (input, expected) => {
    expect(parseIntent(input as string)).toEqual(expected as ReturnType<typeof parseIntent>)
  })

  test('parses an IDR purchase without floating point', () => {
    expect(parseIntent('/beli tambah Hades 120.000 tanggal 2026-09-01 toko Steam')).toEqual({
      type: 'purchase-add',
      query: 'Hades',
      amountMinor: 120_000,
      purchasedAt: '2026-09-01',
      store: 'Steam',
    })
  })

  test.each([
    ['/wishlist', 'wishlist-list'],
    ['/wishlist jeda', 'wishlist-pause'],
    ['/pengeluaran', 'expenses'],
    ['/rekomendasi', 'recommendations'],
    ['/hapusdata', 'delete-request'],
    ['KONFIRMASI HAPUS DATA', 'delete-confirm'],
    ['halo', 'help'],
    ['pesan acak', 'unknown'],
    ['cari diskon Hades', 'search'],
  ])('covers %s', (input, type) => {
    expect(parseIntent(input as string).type).toBe(type as ReturnType<typeof parseIntent>['type'])
  })
})
