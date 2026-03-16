/**
 * Results Difficulty service.
 *
 * Answers: "How hard is it to reach the Top 3 for this keyword?"
 *
 * Three pillars, pure-math approach — no magic numbers except LOG_CEILING.
 *
 *   Pillar 1 – Fortress  (50%)  Average Log10 ratings of Rank 1-3
 *   Pillar 2 – Barrier   (25%)  Median  Log10 ratings of Rank 4-10
 *   Pillar 3 – Opt. Wall (25%)  % of Top 10 with Exact/Broad relevance
 */

import { getSearchRankings } from "./appstore.js";
import {
  storeToLocale,
  relevanceMultiplier,
  hydrateSubtitles,
  MATCH,
  LOG_CEILING,
} from "./resultsShared.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function logScore(ratingCount) {
  return (Math.log10(Math.max(ratingCount, 1)) / LOG_CEILING) * 100;
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ── Pillar calculations ───────────────────────────────────────────────────────

/**
 * Pillar 1 — The Fortress (Top 3).
 * The Top 3 absorb ~70 % of traffic. If they are impenetrable, the keyword is Hard.
 * → Average of Log10(ratings) for ranks 1, 2, 3, mapped to LOG_CEILING → 0-100.
 */
function fortressScore(top3) {
  if (!top3.length) return 0;
  const scores = top3.map((app) => logScore(app.relevance.ratingCount));
  return scores.reduce((s, v) => s + v, 0) / scores.length;
}

/**
 * Pillar 2 — The Barrier to Entry (Ranks 4-10).
 * What's the minimum standard to survive on Page 1?
 * → Median of Log10(ratings) for ranks 4-10, mapped to LOG_CEILING → 0-100.
 */
function barrierScore(ranks4to10) {
  if (!ranks4to10.length) return 0;
  const scores = ranks4to10.map((app) => logScore(app.relevance.ratingCount));
  return median(scores);
}

/**
 * Pillar 3 — The Optimization Wall (Relevance).
 * Are the Top 10 apps actually optimised for this keyword, or just Apple filler?
 * → % of Top 10 with Exact (1.0) or Broad (0.6) relevance multiplier → 0-100.
 */
function optimizationWallScore(top10) {
  if (!top10.length) return 0;
  const optimized = top10.filter(
    (app) =>
      app.relevance.multiplier === MATCH.EXACT ||
      app.relevance.multiplier === MATCH.BROAD,
  );
  return (optimized.length / top10.length) * 100;
}

// ── Final blend ───────────────────────────────────────────────────────────────

export function calculateDifficultyScore(tagged) {
  const top3 = tagged.slice(0, 3);
  const ranks4to10 = tagged.slice(3, 10);
  const top10 = tagged.slice(0, 10);

  const fortress = fortressScore(top3);
  const barrier = barrierScore(ranks4to10);
  const optWall = optimizationWallScore(top10);

  const raw = fortress * 0.5 + barrier * 0.25 + optWall * 0.25;
  const difficulty = Math.round(Math.min(95, Math.max(5, raw)));

  return {
    difficulty,
    breakdown: {
      fortress: Math.round(fortress * 10) / 10,
      barrier: Math.round(barrier * 10) / 10,
      optimizationWall: Math.round(optWall * 10) / 10,
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function getResultsDifficulty(
  redis,
  { keyword, store = "us", platform = "iphone" },
) {
  const results = await getSearchRankings({
    keyword,
    country: store,
    platform,
    limit: 10,
    useProxy: true,
  });

  await hydrateSubtitles(results, store);

  const locale = storeToLocale(store);

  const tagged = results.map((app) => {
    const { multiplier, match } = relevanceMultiplier(
      keyword,
      app.name,
      app.subtitle,
      locale,
    );
    const ratingCount = Math.max(app.ratingCount ?? 0, 1);
    return { ...app, relevance: { multiplier, match, ratingCount } };
  });

  const { difficulty, breakdown } = calculateDifficultyScore(tagged);

  return {
    keyword,
    store,
    platform,
    locale,
    difficulty,
    breakdown,
    total: tagged.length,
    results: tagged,
  };
}
