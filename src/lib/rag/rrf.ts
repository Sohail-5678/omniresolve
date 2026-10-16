/**
 * Reciprocal Rank Fusion: RRF(d) = Σ_r 1 / (k + rank_r(d)), k = 60.
 * Rank-based, so BM25 scores and cosine similarities never need calibrating against each other.
 */

export function reciprocalRankFusion(rankings: { id: string; rank: number }[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankings) {
    for (const { id, rank } of list) scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
  }
  return scores;
}
