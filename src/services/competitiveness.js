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
 *   - Rating count (70%) — avg log10 of top 20 apps' ratingCount
 *   - Average rating (20%) — mean star rating of top 20 apps
 *   - Result density (10%) — total number of results
 *
 * @param {Array<{rank, rating, ratingCount}>} results - search results sorted by rank
 * @returns {number} score 5-95
 */
export function calculateCompetitiveness(results) {
  if (!results || results.length === 0) return 5;

  const TOP_N = 10;
  const LOG_CEILING = 6.5;       // log10(~3M) — apps with millions of ratings = max tier
  const RATING_FLOOR = 2.0;
  const RATING_CEILING = 5.0;
  const RESULTS_CEILING = 200;

  const top = results.slice(0, TOP_N);

  // ── Component 1: Rating count score (70%) — median of top 10 ──
  const validCounts = top
    .map((r) => r.ratingCount)
    .filter((c) => c != null && c >= 0);

  let ratingCountScore = 0;
  if (validCounts.length > 0) {
    const logs = validCounts.map((c) => Math.log10(c + 1)).sort((a, b) => a - b);
    const mid = Math.floor(logs.length / 2);
    const medianLog = logs.length % 2 === 0
      ? (logs[mid - 1] + logs[mid]) / 2
      : logs[mid];
    ratingCountScore = Math.min(100, Math.max(0, (medianLog / LOG_CEILING) * 100));
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

  return Math.max(5, Math.min(95, Math.round(raw)));
}
