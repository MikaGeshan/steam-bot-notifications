import type { SteamOwnedGame, SteamProvider } from '../../ports'

export class MockSteamProvider implements SteamProvider {
  buildLoginUrl(returnTo: string) {
    return `${returnTo}${returnTo.includes('?') ? '&' : '?'}mock_steam_id=76561198000000000`
  }

  async verifyOpenId(params: URLSearchParams) {
    return params.get('mock_steam_id') ?? '76561198000000000'
  }

  async getOwnedGames(): Promise<SteamOwnedGame[]> {
    return [
      { appId: '1145360', name: 'Hades', playtimeMinutes: 1_200, playtimeTwoWeeksMinutes: 180 },
      { appId: '413150', name: 'Stardew Valley', playtimeMinutes: 4_800, playtimeTwoWeeksMinutes: 60 },
    ]
  }
}
