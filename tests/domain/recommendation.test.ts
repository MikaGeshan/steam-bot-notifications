import { describe, expect, test } from 'bun:test'
import { rankRecommendations } from '../../src/domain/recommendation'
import type { RecommendationCandidate } from '../../src/domain/types'

const candidates: RecommendationCandidate[] = [
  {
    game: {
      id: 'owned', title: 'Owned', type: 'game', steamAppId: null, itadId: null,
      platforms: ['windows'], genres: ['rpg'],
    },
    deal: null,
    popularity: 1,
  },
  {
    game: {
      id: 'candidate', title: 'Candidate', type: 'game', steamAppId: null, itadId: null,
      platforms: ['windows'], genres: ['rpg'],
    },
    deal: null,
    popularity: 0.5,
  },
]

describe('recommendation ranking', () => {
  test('excludes owned games and produces explainable deterministic output', () => {
    const output = rankRecommendations({
      genreWeights: { rpg: 1 },
      platforms: ['windows'],
      excludedGameIds: new Set(['owned']),
      maxPriceMinor: null,
      currency: 'IDR',
    }, candidates)
    expect(output).toHaveLength(1)
    expect(output[0]?.game.id).toBe('candidate')
    expect(output[0]?.reasons.join(' ')).toContain('rpg')
  })
})
