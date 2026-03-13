/**
 * Results Popularity service.
 */

import { getSearchRankings } from "./appstore.js";
import {
  storeToLocale,
  relevanceMultiplier,
  hydrateSubtitles,
  LOG_CEILING,
} from "./resultsShared.js";

// ── Popularity scoring ────────────────────────────────────────────────────────

function logAvgScore(arr) {
  if (!arr.length) return 0;
  const logScores = arr.map(
    (v) => (Math.log10(Math.max(v, 1)) / LOG_CEILING) * 100,
  );
  return logScores.reduce((s, v) => s + v, 0) / arr.length;
}

function calculatePopularityScore(enriched) {
  const eivs = enriched.map((a) => a.relevance.eiv);

  const top5 = eivs.slice(0, 5);
  const ranks1_10 = eivs.slice(0, 10);
  const ranks11_20 = eivs.slice(10, 20);

  const ceilingScore = logAvgScore(top5);
  const bodyScore = logAvgScore(ranks1_10);
  const tailScore = logAvgScore(ranks11_20);

  // 1. Calculate the strict ecosystem score (which works perfectly for indie apps)
  const rawScore = ceilingScore * 0.4 + bodyScore * 0.4 + tailScore * 0.2;
  let finalPopularity = 5 + rawScore * 0.9;

  // 2. THE MEGA-BRAND FIX: Find the highest Exact Match on the page
  const exactApps = enriched.filter((a) => a.relevance.multiplier === 1.0);
  const maxExactEIV =
    exactApps.length > 0
      ? Math.max(...exactApps.map((a) => a.relevance.eiv))
      : 0;

  if (maxExactEIV > 0) {
    const logMax = Math.log10(maxExactEIV);

    // Create a smooth sliding scale.
    // If < 100k ratings (Log 5), weight is 0.
    // If > 10M ratings (Log 7), weight is 1.0.
    const brandWeight = Math.max(0, Math.min(1, (logMax - 5) / 2));

    // Calculate the Anchor Score of the mega-brand itself
    const maxAnchorScore = (logMax / LOG_CEILING) * 100;

    // Blend the scores based on the weight
    finalPopularity =
      finalPopularity * (1 - brandWeight) + maxAnchorScore * brandWeight;
  }

  // Ensure it stays within bounds
  finalPopularity = Math.round(Math.min(95, Math.max(5, finalPopularity)));

  return {
    popularity: finalPopularity,
    breakdown: {
      ceilingScore: Math.round(ceilingScore * 10) / 10,
      bodyScore: Math.round(bodyScore * 10) / 10,
      tailScore: Math.round(tailScore * 10) / 10,
      rawScore: Math.round(rawScore * 10) / 10,
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function getResultsPopularity(
  redis,
  { keyword, store = "us", platform = "iphone" },
) {
  const results = await getSearchRankings({
    keyword,
    country: store,
    platform,
    limit: 20,
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

  // Collect EIVs among apps that STRICTLY target the exact keyword
  const exactDemands = [];
  for (const app of tagged) {
    if (app.relevance.multiplier === 1.0) {
      exactDemands.push(app.relevance.ratingCount * app.relevance.multiplier);
    }
  }

  // Calculate the median
  let medianTrueDemand = 0;
  if (exactDemands.length === 0) {
    medianTrueDemand = 50; // Strict fallback for empty niches
  } else {
    // Sort ascending to find the median
    exactDemands.sort((a, b) => a - b);
    const mid = Math.floor(exactDemands.length / 2);

    if (exactDemands.length % 2 === 0) {
      medianTrueDemand = (exactDemands[mid - 1] + exactDemands[mid]) / 2;
    } else {
      medianTrueDemand = exactDemands[mid];
    }
  }

  // Calculate EIV with cap: generic apps cannot exceed the niche's median demand
  const enriched = tagged.map((app) => {
    let eiv = app.relevance.ratingCount * app.relevance.multiplier;

    if (app.relevance.multiplier < 1.0 && eiv > medianTrueDemand) {
      eiv = medianTrueDemand;
    }

    return { ...app, relevance: { ...app.relevance, eiv } };
  });

  const { popularity, breakdown } = calculatePopularityScore(enriched);

  return {
    keyword,
    store,
    platform,
    locale,
    popularity,
    breakdown,
    total: enriched.length,
    results: enriched,
  };
}
