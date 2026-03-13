/**
 * Keyword competitiveness scoring (5-95).
 *
 * Measures how hard it is for a new app to rank for a keyword.
 * 95 = extremely competitive (e.g., "photo editor", "weather")
 *  5 = virtually no competition
 *
 * Pure function — uses only search results data, no API calls, no async.
 *
 * Formula:
 *   - Rating count (70%) — P75 log10 of top 10 apps' ratingCount
 *   - Average rating (20%) — mean star rating of top 10 apps
 *   - Result density (10%) — total number of results
 *   - Vulnerability discount — weak slots (< 50 ratings) reduce the score,
 *     reflecting that open entry points make ranking easier regardless of
 *     how strong a few incumbents are.
 *
 * @param {Array<{rank, rating, ratingCount}>} results - search results sorted by rank
 * @returns {number} score 5-95
 */
export function calculateCompetitiveness(results) {
  if (!results || results.length === 0) return 5;

  const TOP_N = 10;
  const LOG_CEILING = 5.5;       // log10(~316K) — apps with 300K+ ratings = max tier
  const RATING_FLOOR = 2.0;
  const RATING_CEILING = 5.0;
  const RESULTS_CEILING = 200;
  const WEAK_THRESHOLD = 50;

  const top = results.slice(0, TOP_N);

  // ── Component 1: Rating count score (70%) — P75 of top 10 ──
  const validCounts = top
    .map((r) => r.ratingCount)
    .filter((c) => c != null && c >= 0);

  let ratingCountScore = 0;
  if (validCounts.length > 0) {
    const logs = validCounts.map((c) => Math.log10(c + 1)).sort((a, b) => a - b);
    const p75Idx = Math.min(Math.floor(logs.length * 0.75), logs.length - 1);
    const p75Log = logs[p75Idx];
    ratingCountScore = Math.min(100, Math.max(0, (p75Log / LOG_CEILING) * 100));
  }

  // ── Component 2: Average rating score (20%) ──
  const validRatings = top
    .map((r) => r.rating)
    .filter((r) => r != null && r > 0);

  let avgRatingScore = 0;
  if (validRatings.length > 0) {
    const avgRating =
      validRatings.reduce((sum, r) => sum + r, 0) / validRatings.length;
    avgRatingScore = Math.min(
      100,
      Math.max(
        0,
        ((avgRating - RATING_FLOOR) / (RATING_CEILING - RATING_FLOOR)) * 100
      )
    );
  }

  // ── Component 3: Result density score (10%) ──
  const densityScore = Math.min(100, (results.length / RESULTS_CEILING) * 100);

  // ── Combine ──
  const raw =
    ratingCountScore * 0.7 + avgRatingScore * 0.2 + densityScore * 0.1;

  // ── Vulnerability discount ──
  // Apps with < 50 ratings are weak slots a new entrant can displace.
  // 4/10 weak → 40% → discount ×0.72  (difficulty drops ~28%)
  // 7/10 weak → 70% → discount ×0.51  (difficulty drops ~49%)
  const weakCount = validCounts.filter((c) => c < WEAK_THRESHOLD).length;
  const weakRatio = top.length > 0 ? weakCount / top.length : 0;
  const vulnerabilityMultiplier = 1 - weakRatio * 0.7;

  return Math.max(5, Math.min(95, Math.round(raw * vulnerabilityMultiplier)));
}
