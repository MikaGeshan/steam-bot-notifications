import type { PlaytimeSnapshot, WeeklyPlaytime } from './types'

export function calculateWeeklyPlaytime(
  start: PlaytimeSnapshot[],
  end: PlaytimeSnapshot[],
  coverageDays: number,
): WeeklyPlaytime {
  const initial = new Map(start.map((snapshot) => [snapshot.gameId, snapshot.cumulativeMinutes]))
  const deltas = end
    .map((snapshot) => ({
      gameId: snapshot.gameId,
      title: snapshot.title,
      minutes: Math.max(0, snapshot.cumulativeMinutes - (initial.get(snapshot.gameId) ?? snapshot.cumulativeMinutes)),
    }))
    .filter((item) => item.minutes > 0)
    .sort((left, right) => right.minutes - left.minutes)

  return {
    totalMinutes: deltas.reduce((sum, item) => sum + item.minutes, 0),
    activeGames: deltas.length,
    coverageDays: Math.max(0, Math.min(7, coverageDays)),
    topGames: deltas.slice(0, 5),
  }
}
