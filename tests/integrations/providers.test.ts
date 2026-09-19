import { describe, expect, test } from 'bun:test'
import { ProviderError, safeFetch } from '../../src/integrations/http'
import { MockPriceProvider } from '../../src/integrations/pricing/mock'
import { MockSteamProvider } from '../../src/integrations/steam/mock'

describe('provider adapters', () => {
  test('blocks outbound hosts outside the adapter allowlist', async () => {
    expect(safeFetch('test', 'https://127.0.0.1/private', {}, {
      allowedHosts: ['api.example.test'],
    })).rejects.toBeInstanceOf(ProviderError)
  })

  test('mock pricing supports search and exact game refresh', async () => {
    const provider = new MockPriceProvider()
    const results = await provider.searchDeals({ query: 'Hades', country: 'ID', currency: 'IDR' })
    expect(results).toHaveLength(1)
    expect(results[0]?.current.currency).toBe('IDR')
    expect(await provider.getDeal(results[0]!.game, 'ID')).not.toBeNull()
    expect(await provider.getDeal({
      id: 'missing', title: 'Missing', type: 'game', steamAppId: null, itadId: null,
      platforms: [], genres: [],
    }, 'ID')).toBeNull()
  })

  test('mock Steam keeps SteamID as a string and returns deterministic library', async () => {
    const provider = new MockSteamProvider()
    expect(provider.buildLoginUrl('http://localhost/callback?state=x')).toContain('mock_steam_id=')
    expect(await provider.verifyOpenId(new URLSearchParams('mock_steam_id=76561198000000001')))
      .toBe('76561198000000001')
    expect(await provider.getOwnedGames()).toHaveLength(2)
  })
})
