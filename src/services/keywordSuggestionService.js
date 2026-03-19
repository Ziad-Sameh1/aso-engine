/**
 * Keyword Suggestion Service
 *
 * Pipeline:
 *   1. Filter junk keywords (stopwords, duplicates, single-char)
 *   2. Score suggest popularity in parallel (100 concurrent via proxy)
 *   3. For keywords with suggestPopularity > 10, fetch results metrics
 *      (single search → scorePopularity + calculateDifficultyScore on same data)
 *   4. Return only keywords where BOTH suggestPopularity > 10 AND resultsPopularity > 10
 *
 * Failed keywords are retried in a second pass (queue-based, no backoff).
 */

import { calculatePopularity } from "./popularity.js";
import { getSearchRankings, getProxyAgent } from "./appstore.js";
import {
  storeToLocale,
  relevanceMultiplier,
  hydrateSubtitles,
} from "./resultsShared.js";
import { scorePopularity } from "./resultsPopularityService.js";
import { calculateDifficultyScore } from "./resultsDifficultyService.js";
import { CacheService } from "./cache.js";
import { config } from "../config/index.js";

const CONCURRENCY = 100;
const MIN_SUGGEST_POPULARITY = 10;
const MIN_RESULTS_POPULARITY = 10;
const CACHE_TTL = 86400; // 24h for scored keywords

// ── Junk keyword filter ──────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "of", "your", "a", "an", "and", "for", "with", "to", "in", "on",
  "by", "my", "no", "get", "is", "it", "at", "or", "be", "do", "if", "so",
  "up", "as", "not", "all", "but", "how", "can", "has", "had", "was", "are",
  "its", "this", "that", "from", "just", "more", "also", "very", "about",
  "into", "over", "such", "than", "most", "other", "some", "what", "when",
  "who", "will", "each", "make", "like", "been", "have", "new", "app", "best",
  "free", "top", "pro",
]);

/**
 * Returns true if a keyword is junk and should be skipped.
 * - Fewer than 2 meaningful (non-stopword) words
 * - Has duplicate words ("ai ai", "track track")
 * - Any word is a single character ("a b", "x y")
 */
function isJunkKeyword(keyword) {
  const words = keyword.toLowerCase().trim().split(/\s+/);

  const meaningful = words.filter((w) => !STOPWORDS.has(w));
  if (meaningful.length < 2) return true;

  if (new Set(words).size < words.length) return true;

  if (words.some((w) => w.length <= 1)) return true;

  return false;
}

/**
 * Simple concurrency limiter.
 */
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  }
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

// ── Phase 1: Suggest popularity ──────────────────────────────────────────────

/**
 * Score a single keyword's suggest popularity, with Redis cache.
 */
async function scoreSuggestPopularity(keyword, frequency, store, platform, deps, cache) {
  const cacheKey = `kw-suggest:${store}:${platform}:${keyword.toLowerCase().trim()}`;

  const cached = await cache.get(cacheKey);
  if (cached) {
    // Handle both old format { score, breakdown } and new { suggestPopularity, suggestBreakdown }
    const sp = cached.suggestPopularity ?? cached.score ?? 5;
    const sb = cached.suggestBreakdown ?? cached.breakdown ?? {};
    return sp > MIN_SUGGEST_POPULARITY
      ? { keyword, frequency, suggestPopularity: sp, suggestBreakdown: sb, cached: true }
      : null;
  }

  const result = await calculatePopularity(keyword, store, platform, deps);
  const suggestPopularity = result.score ?? 5;

  await cache.set(cacheKey, { suggestPopularity, suggestBreakdown: result.breakdown }, CACHE_TTL);

  return suggestPopularity > MIN_SUGGEST_POPULARITY
    ? { keyword, frequency, suggestPopularity, suggestBreakdown: result.breakdown, cached: false }
    : null;
}

/**
 * Run suggest popularity for keywords with retry.
 */
async function runSuggestPhase(keywords, store, platform, deps, cache) {
  const results = [];
  const failed = [];

  const limit = createLimiter(CONCURRENCY);
  const t0 = performance.now();

  await Promise.all(
    keywords.map((kw) =>
      limit(async () => {
        try {
          const result = await scoreSuggestPopularity(kw.keyword, kw.frequency, store, platform, deps, cache);
          if (result) results.push(result);
        } catch {
          failed.push(kw);
        }
      })
    )
  );

  const pass1Ms = Math.round(performance.now() - t0);
  console.log(
    `[kw-suggest] ${store}: suggest pass 1 — ${results.length} passed, ${failed.length} failed (${keywords.length} candidates) — ${pass1Ms}ms`
  );

  // Retry failures sequentially, no backoff
  if (failed.length > 0) {
    const t1 = performance.now();
    let retryOk = 0;

    for (const kw of failed) {
      try {
        const result = await scoreSuggestPopularity(kw.keyword, kw.frequency, store, platform, deps, cache);
        if (result) { results.push(result); retryOk++; }
      } catch (err) {
        console.warn(`[kw-suggest] suggest retry failed for "${kw.keyword}": ${err.message}`);
      }
    }

    const pass2Ms = Math.round(performance.now() - t1);
    console.log(`[kw-suggest] ${store}: suggest pass 2 — ${retryOk} recovered — ${pass2Ms}ms`);
  }

  return results;
}

// ── Phase 2: Results popularity + difficulty (single search) ─────────────────

/**
 * Fetch search results once, then compute both resultsPopularity and
 * resultsDifficulty from the same tagged data — avoids double-searching.
 */
async function scoreResultsMetrics(kw, store, platform, cache) {
  const cacheKey = `kw-results:${store}:${platform}:${kw.keyword.toLowerCase().trim()}`;

  const cached = await cache.get(cacheKey);
  if (cached) {
    if (cached.resultsPopularity <= MIN_RESULTS_POPULARITY) return null;
    return { ...kw, ...cached, cached: true };
  }

  // Single search call (top 20 covers both popularity and difficulty needs)
  const results = await getSearchRankings({
    keyword: kw.keyword,
    country: store,
    platform,
    limit: 20,
    useProxy: true,
  });

  await hydrateSubtitles(results, store);

  const locale = storeToLocale(store);

  // Tag relevance (shared by both scorers)
  const tagged = results.map((app) => {
    const { multiplier, match } = relevanceMultiplier(
      kw.keyword, app.name, app.subtitle, locale,
    );
    const ratingCount = Math.max(app.ratingCount ?? 0, 1);
    return { ...app, relevance: { multiplier, match, ratingCount } };
  });

  // Compute both scores from the same data
  const { popularity: resultsPopularity } = scorePopularity(tagged);
  const { difficulty: resultsDifficulty } = calculateDifficultyScore(tagged);
  const opportunity = resultsPopularity - resultsDifficulty;

  const metrics = { resultsPopularity, resultsDifficulty, opportunity };
  await cache.set(cacheKey, metrics, CACHE_TTL);

  if (resultsPopularity <= MIN_RESULTS_POPULARITY) return null;

  return { ...kw, ...metrics, cached: false };
}

/**
 * Run results metrics for keywords with retry.
 */
async function runResultsPhase(keywords, store, platform, cache) {
  const results = [];
  const failed = [];

  const limit = createLimiter(CONCURRENCY);
  const t0 = performance.now();

  await Promise.all(
    keywords.map((kw) =>
      limit(async () => {
        try {
          const result = await scoreResultsMetrics(kw, store, platform, cache);
          if (result) results.push(result);
        } catch {
          failed.push(kw);
        }
      })
    )
  );

  const pass1Ms = Math.round(performance.now() - t0);
  console.log(
    `[kw-suggest] ${store}: results pass 1 — ${results.length} passed, ${failed.length} failed (${keywords.length} candidates) — ${pass1Ms}ms`
  );

  // Retry failures sequentially, no backoff
  if (failed.length > 0) {
    const t1 = performance.now();
    let retryOk = 0;

    for (const kw of failed) {
      try {
        const result = await scoreResultsMetrics(kw, store, platform, cache);
        if (result) { results.push(result); retryOk++; }
      } catch (err) {
        console.warn(`[kw-suggest] results retry failed for "${kw.keyword}": ${err.message}`);
      }
    }

    const pass2Ms = Math.round(performance.now() - t1);
    console.log(`[kw-suggest] ${store}: results pass 2 — ${retryOk} recovered — ${pass2Ms}ms`);
  }

  return results;
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Score all mined keywords for an app+store.
 *
 * Phase 1: Suggest popularity (100 concurrent) → filter > 10
 * Phase 2: Single search → scorePopularity + calculateDifficultyScore → filter resultsPopularity > 10
 *
 * Returns keywords sorted by opportunity (resultsPopularity - resultsDifficulty) descending.
 */
export async function scoreMinedKeywords(keywords, store, platform, { redis }) {
  const cache = new CacheService(redis);
  const httpsAgent = config.proxyUrl ? getProxyAgent() : null;

  const suggestDeps = {
    redis,
    mediaApiToken: config.appleMediaApiToken,
    appleAdsCookie: config.appleAdsCookie,
    appleAdsXsrfToken: config.appleAdsXsrfToken,
    appleAdsAdamId: config.appleAdsAdamId,
    httpsAgent,
  };

  // Only score 2+ word keywords, skip junk
  const candidates = keywords.filter((kw) => {
    const words = kw.keyword.trim().split(/\s+/);
    return words.length >= 2 && !isJunkKeyword(kw.keyword);
  });

  console.log(`[kw-suggest] ${store}: ${candidates.length} candidates (${keywords.length} total mined, ${keywords.length - candidates.length} filtered)`);

  // Phase 1: suggest popularity
  const suggestPassed = await runSuggestPhase(candidates, store, platform, suggestDeps, cache);

  if (!suggestPassed.length) return [];

  console.log(`[kw-suggest] ${store}: ${suggestPassed.length} keywords passed suggest filter, starting results phase`);

  // Phase 2: results popularity + difficulty (single search per keyword)
  const finalResults = await runResultsPhase(suggestPassed, store, platform, cache);

  // Sort by frequency (mine appearances) descending, then opportunity
  finalResults.sort((a, b) => b.frequency - a.frequency || b.opportunity - a.opportunity);

  console.log(`[kw-suggest] ${store}: ${finalResults.length} keywords passed all filters`);

  return finalResults;
}
