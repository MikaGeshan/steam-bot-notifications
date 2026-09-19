import { describe, expect, test } from 'bun:test'
import { calculateWeeklyPlaytime } from '../../src/domain/playtime'

describe('weekly playtime', () => {
  test('uses non-negative cumulative deltas and reports coverage', () => {
    const result = calculateWeeklyPlaytime(
      [
        { gameId: 'a', title: 'A', cumulativeMinutes: 100, capturedAt: '2026-09-08T00:00:00Z' },
        { gameId: 'b', title: 'B', cumulativeMinutes: 500, capturedAt: '2026-09-08T00:00:00Z' },
      ],
      [
        { gameId: 'a', title: 'A', cumulativeMinutes: 220, capturedAt: '2026-09-15T00:00:00Z' },
        { gameId: 'b', title: 'B', cumulativeMinutes: 490, capturedAt: '2026-09-15T00:00:00Z' },
      ],
      9,
    )
    expect(result).toEqual({
      totalMinutes: 120,
      activeGames: 1,
      coverageDays: 7,
      topGames: [{ gameId: 'a', title: 'A', minutes: 120 }],
    })
  })
})
