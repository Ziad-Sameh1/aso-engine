/**
 * Keyword opportunity scoring (1-100).
 *
 * Measures how accessible a keyword is for an indie developer:
 * high demand AND low competition = high opportunity.
 *
 * Formula:
 *   accessibility    = (100 - difficulty) / 100          (0→1 as difficulty drops)
 *   indieMultiplier  = accessibility^1.5                 (exponential penalty for hard markets)
 *   opportunity      = popularity × indieMultiplier
 *   gap bonus        = if popularity > difficulty, add (gap × 0.5)
 *   score            = clamp(round(opportunity), 1, 100)
 *
 * Properties:
 *   - high popularity + low difficulty  → near 100 (clear win)
 *   - high popularity + high difficulty → moderate (big market, hard to enter)
 *   - low popularity  (any difficulty)  → low      (dead keyword)
 *
 * Pure function — no side effects, no async, no API calls.
 *
 * @param {number} popularity - 0-100 scale
 * @param {number} difficulty - 0-100 scale
 * @returns {number} 1-100
 */
export function calculateOpportunity(popularity, difficulty) {
  // 1. The Accessibility Curve
  const accessibility = Math.max(0, (100 - difficulty) / 100);
  const indieMultiplier = Math.pow(accessibility, 1.1);

  // 2. Base Potential
  let opportunity = popularity * indieMultiplier;

  // 3. The Raw Gap Shift
  const gap = popularity - difficulty;
  opportunity += gap * 0.5;

  // 4. THE DEAD END PENALTY (Updated)
  if (popularity < 25) {
    // The Absolute Floor: If there's no volume, it's dead. Period.
    // Even if difficulty is 0, crush the score.
    opportunity = opportunity * 0.2;
  } else if (popularity < 35 && gap < 0) {
    // The Friction Trap: Low volume + Hard competition
    opportunity = opportunity * 0.3;
  }

  // 5. Normalize to a clean 1-100 scale
  return Math.round(Math.max(1, Math.min(100, opportunity)));
}
