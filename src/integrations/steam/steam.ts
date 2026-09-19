import type { SteamOwnedGame, SteamProvider } from '../../ports'
import { ProviderError, safeFetch } from '../http'

const OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login'
const OPENID_NS = 'http://specs.openid.net/auth/2.0'
const OPENID_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select'

const requireSingle = (params: URLSearchParams, key: string) => {
  const values = params.getAll(key)
  if (values.length !== 1 || !values[0]) throw new Error(`Invalid OpenID parameter: ${key}`)
  return values[0]
}

export class SteamWebProvider implements SteamProvider {
  constructor(
    private readonly apiKey: string,
    private readonly realm: string,
  ) {}

  buildLoginUrl(returnTo: string) {
    const callback = new URL(returnTo)
    const configuredRealm = new URL(this.realm)
    if (callback.origin !== configuredRealm.origin) throw new Error('Steam callback origin is not allowed')

    const url = new URL(OPENID_ENDPOINT)
    url.searchParams.set('openid.ns', OPENID_NS)
    url.searchParams.set('openid.mode', 'checkid_setup')
    url.searchParams.set('openid.return_to', callback.toString())
    url.searchParams.set('openid.realm', configuredRealm.origin)
    url.searchParams.set('openid.identity', OPENID_SELECT)
    url.searchParams.set('openid.claimed_id', OPENID_SELECT)
    return url.toString()
  }

  async verifyOpenId(params: URLSearchParams, expectedReturnTo: string) {
    if (requireSingle(params, 'openid.mode') !== 'id_res') throw new Error('Steam OpenID was not approved')
    if (requireSingle(params, 'openid.op_endpoint') !== OPENID_ENDPOINT) {
      throw new Error('Unexpected Steam OpenID endpoint')
    }
    if (requireSingle(params, 'openid.return_to') !== expectedReturnTo) {
      throw new Error('Steam OpenID return URL mismatch')
    }
    const claimed = requireSingle(params, 'openid.claimed_id')
    const identity = requireSingle(params, 'openid.identity')
    if (claimed !== identity) throw new Error('Steam OpenID identity mismatch')
    const match = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(claimed)
    if (!match?.[1]) throw new Error('Invalid SteamID64 identity')

    const signed = new Set(requireSingle(params, 'openid.signed').split(','))
    for (const field of ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce']) {
      if (!signed.has(field)) throw new Error(`Steam OpenID field is not signed: ${field}`)
    }
    const nonce = requireSingle(params, 'openid.response_nonce')
    const nonceDate = new Date(nonce.slice(0, 20))
    const age = Date.now() - nonceDate.getTime()
    if (!Number.isFinite(age) || age > 10 * 60_000 || age < -60_000) {
      throw new Error('Steam OpenID response nonce is stale')
    }

    const verification = new URLSearchParams(params)
    verification.set('openid.mode', 'check_authentication')
    const response = await safeFetch(
      'steam-openid',
      OPENID_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: verification.toString(),
      },
      { allowedHosts: ['steamcommunity.com'], timeoutMs: 8_000, maxBytes: 100_000 },
    )
    const body = await response.text()
    if (!body.split(/\r?\n/).includes('is_valid:true')) {
      throw new Error('Steam OpenID assertion is invalid')
    }
    return match[1]
  }

  async getOwnedGames(steamId: string): Promise<SteamOwnedGame[]> {
    if (!/^\d{17}$/.test(steamId)) throw new Error('Invalid SteamID64')
    if (!this.apiKey) throw new ProviderError('steam', 'not_configured', 'Steam API key is missing', false)
    const url = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/')
    url.searchParams.set('key', this.apiKey)
    url.searchParams.set('steamid', steamId)
    url.searchParams.set('include_appinfo', 'true')
    url.searchParams.set('include_played_free_games', 'true')
    const response = await safeFetch('steam', url, {}, {
      allowedHosts: ['api.steampowered.com'],
      timeoutMs: 10_000,
      maxBytes: 5_000_000,
    })
    const data = await response.json() as {
      response?: {
        games?: Array<{
          appid?: number
          name?: string
          playtime_forever?: number
          playtime_2weeks?: number
        }>
      }
    }
    return (data.response?.games ?? []).flatMap((game) => {
      if (!game.appid || !game.name) return []
      return [{
        appId: String(game.appid),
        name: game.name,
        playtimeMinutes: Math.max(0, game.playtime_forever ?? 0),
        playtimeTwoWeeksMinutes:
          game.playtime_2weeks === undefined ? null : Math.max(0, game.playtime_2weeks),
      }]
    })
  }
}
