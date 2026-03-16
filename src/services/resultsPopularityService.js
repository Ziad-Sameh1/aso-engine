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
import { config } from "../config/index.js";

// ── Suggestion validation ─────────────────────────────────────────────────────

const SUGGEST_MAX_RETRIES = 12;

const SUGGEST_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

/**
 * Check whether `keyword` surfaces in Apple's autocomplete suggestions.
 * A keyword is considered "found" if any returned suggestion term equals it,
 * starts with it (e.g. "photo editor" found via "photo editor free"), or the
 * keyword itself begins with a returned suggestion term (stem coverage).
 *
 * Returns `true` on any network error or missing token so we never penalise
 * due to infrastructure issues.
 */
async function checkKeywordInSuggestions(keyword, store, platform) {
  const token = config.appleMediaApiToken;
  if (!token) return true;

  const norm = keyword.toLowerCase().trim();
  const url =
    `https://amp-api-edge.apps.apple.com/v1/catalog/${store}` +
    `/search/suggestions?term=${encodeURIComponent(norm)}&kinds=terms&platform=${platform}&limit=10`;

  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": SUGGEST_UA,
    Accept: "application/json",
    Origin: "https://apps.apple.com",
    "Accept-Language": "en-US,en;q=0.9",
  };

  for (let attempt = 1; attempt <= SUGGEST_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, { headers });

      if (response.status === 429) {
        if (attempt < SUGGEST_MAX_RETRIES) {
          console.warn(`[popularity] Suggest check 429 for "${keyword}" (attempt ${attempt}/${SUGGEST_MAX_RETRIES}) — retrying`);
          continue;
        }
        console.warn(`[popularity] Suggest check exhausted ${SUGGEST_MAX_RETRIES} retries (429) for "${keyword}" — skipping penalty`);
        return true;
      }

      if (!response.ok) {
        console.warn(`[popularity] Suggest check HTTP ${response.status} for "${keyword}" — skipping penalty`);
        return true;
      }

      const data = await response.json();
      const suggestions = data?.results?.suggestions ?? [];
      const terms = suggestions
        .filter((s) => !s.entity && !s.context)
        // Apple returns displayTerm, searchTerm, or term depending on context
        .map((s) => (s.displayTerm ?? s.searchTerm ?? s.term ?? "").toLowerCase().trim())
        .filter(Boolean);

      // Found if any suggestion equals the keyword, starts with it
      // (e.g. "qrosh: ai budget money app" starts with "qrosh"),
      // or keyword begins with a suggestion term (stem coverage).
      const found = terms.some(
        (t) => t === norm || t.startsWith(norm) || norm.startsWith(t + " "),
      );

      console.log(
        `[popularity] Suggest check "${keyword}" store=${store}: ${found ? "found" : "NOT FOUND"} (${terms.length} suggestions: ${terms.slice(0, 3).join(", ")})`,
      );
      return found;
    } catch (err) {
      if (attempt < SUGGEST_MAX_RETRIES) {
        console.warn(`[popularity] Suggest check error for "${keyword}" (attempt ${attempt}/${SUGGEST_MAX_RETRIES}): ${err.message} — retrying`);
        continue;
      }
      console.warn(`[popularity] Suggest check failed after ${SUGGEST_MAX_RETRIES} attempts for "${keyword}": ${err.message} — skipping penalty`);
      return true;
    }
  }

  return true;
}

// ── Popularity scoring ────────────────────────────────────────────────────────

function logAvgScore(arr) {
  if (!arr.length) return 0;
  const logScores = arr.map(
    (v) => (Math.log10(Math.max(v, 1)) / LOG_CEILING) * 100,
  );
  return logScores.reduce((s, v) => s + v, 0) / arr.length;
}

export function calculatePopularityScore(enriched) {
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

/**
 * Score popularity from pre-tagged results (with relevance.multiplier & ratingCount).
 * Computes medianTrueDemand, EIV enrichment, then the popularity score.
 */
export function scorePopularity(tagged) {
  const exactDemands = [];
  for (const app of tagged) {
    if (app.relevance.multiplier === 1.0) {
      exactDemands.push(app.relevance.ratingCount * app.relevance.multiplier);
    }
  }

  let medianTrueDemand = 0;
  if (exactDemands.length < 2) {
    // THE MONOPOLY PROTOCOL
    // If there is only 0 or 1 exact match, cap generic filler apps at a strict baseline.
    medianTrueDemand = 50;
  } else {
    exactDemands.sort((a, b) => a - b);
    const mid = Math.floor(exactDemands.length / 2);

    if (exactDemands.length % 2 === 0) {
      // THE CONSERVATIVE MEDIAN
      // For even arrays, always take the lower middle value to protect against giant outliers.
      medianTrueDemand = exactDemands[mid - 1];
    } else {
      medianTrueDemand = exactDemands[mid];
    }
  }

  const enriched = tagged.map((app) => {
    let eiv = app.relevance.ratingCount * app.relevance.multiplier;
    if (app.relevance.multiplier < 1.0 && eiv > medianTrueDemand) {
      eiv = medianTrueDemand;
    }
    return { ...app, relevance: { ...app.relevance, eiv } };
  });

  return calculatePopularityScore(enriched);
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

  console.log(results);

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
  if (exactDemands.length < 2) {
    // THE MONOPOLY PROTOCOL
    medianTrueDemand = 50;
  } else {
    // Sort ascending to find the median
    exactDemands.sort((a, b) => a - b);
    const mid = Math.floor(exactDemands.length / 2);

    if (exactDemands.length % 2 === 0) {
      // THE CONSERVATIVE MEDIAN
      medianTrueDemand = exactDemands[mid - 1];
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

  const { popularity: rawPopularity, breakdown } = calculatePopularityScore(enriched);

  // Validate keyword presence in Apple's autocomplete suggestions.
  // A keyword that never appears in suggestions has no real search volume —
  // the results-based score is an artefact of broad/partial matches.
  const suggestValidated = await checkKeywordInSuggestions(keyword, store, platform);
  const popularity = suggestValidated
    ? rawPopularity
    : Math.min(95, Math.max(5, Math.round(rawPopularity * 0.2)));

  return {
    keyword,
    store,
    platform,
    locale,
    popularity,
    suggestValidated,
    breakdown,
    total: enriched.length,
    results: enriched,
  };
}
