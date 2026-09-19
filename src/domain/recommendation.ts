import type { Recommendation, RecommendationCandidate } from './types'

export interface RecommendationProfile {
  genreWeights: Record<string, number>
  platforms: string[]
  excludedGameIds: Set<string>
  maxPriceMinor: number | null
  currency: string
}

export function rankRecommendations(
  profile: RecommendationProfile,
  candidates: RecommendationCandidate[],
  limit = 10,
): Recommendation[] {
  return candidates
    .filter(({ game }) => !profile.excludedGameIds.has(game.id))
    .map((candidate) => {
      const matchedGenres = candidate.game.genres.filter(
        (genre) => (profile.genreWeights[genre.toLowerCase()] ?? 0) > 0,
      )
      const genreScore = Math.min(
        50,
        matchedGenres.reduce(
          (sum, genre) => sum + (profile.genreWeights[genre.toLowerCase()] ?? 0) * 10,
          0,
        ),
      )
      const platformMatch = candidate.game.platforms.some((platform) =>
        profile.platforms.includes(platform),
      )
      const platformScore = platformMatch ? 25 : 0
      const popularityScore = Math.max(0, Math.min(10, candidate.popularity * 10))
      const affordable =
        profile.maxPriceMinor === null ||
        (candidate.deal?.current.currency === profile.currency &&
          candidate.deal.current.amountMinor <= profile.maxPriceMinor)
      const valueScore = candidate.deal && affordable ? Math.min(15, candidate.deal.cutPercent / 5) : 0
      const reasons: string[] = []
      if (matchedGenres.length) reasons.push(`cocok dengan genre ${matchedGenres.slice(0, 2).join(', ')}`)
      if (platformMatch) reasons.push(`tersedia di ${profile.platforms.join('/')}`)
      if (candidate.deal && affordable) reasons.push(`sedang diskon ${candidate.deal.cutPercent}%`)

      return {
        game: candidate.game,
        deal: candidate.deal,
        score: Number((genreScore + platformScore + popularityScore + valueScore).toFixed(2)),
        reasons: reasons.length > 0 ? reasons : ['kandidat eksplorasi untukmu'],
      }
    })
    .filter((recommendation) => recommendation.score > 0)
    .sort((left, right) => right.score - left.score || left.game.title.localeCompare(right.game.title))
    .slice(0, limit)
}
