/**
 * Keyword opportunity scoring (0-95).
 *
 * Measures the gap between demand (popularity) and competition (difficulty).
 * High opportunity = high demand AND low competition.
 *
 * Formula:
 *   gap = popularity - difficulty
 *   rawOpportunity = gap + 50          (centres at 50 when pop == diff)
 *   demandMultiplier = min(1, pop/50)  (ramps 0→1 over first 50 popularity points)
 *   score = clamp(round(raw * multiplier), 0, 95)
 *
 * Properties:
 *   - popularity == difficulty → 50 (neutral)
 *   - popularity > difficulty  → > 50 (good opportunity)
 *   - popularity < difficulty  → < 50 (tough keyword)
 *   - popularity == 0          → 0   (no demand = no opportunity)
 *   - low pop + low difficulty → low  (dead keyword, not a real opportunity)
 *
 * Pure function — no side effects, no async, no API calls.
 *
 * @param {number} popularity - 0-100 scale
 * @param {number} difficulty - 0-100 scale
 * @returns {number} 0-95
 */
export function calculateOpportunity(popularity, difficulty) {
  if (popularity <= 0) return 0;

  const gap = popularity - difficulty;
  const rawOpportunity = gap + 50;
  const demandMultiplier = Math.min(1, popularity / 50);
  return Math.max(0, Math.min(95, Math.round(rawOpportunity * demandMultiplier)));
}
