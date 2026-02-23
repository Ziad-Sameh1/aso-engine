/**
 * Shared "run search" logic used by /api/search and as an auto-trigger
 * fallback in other routes when the requested keyword isn't in the DB yet.
 */

import { getSearchRankings } from "./appstore.js";
import { CacheService } from "./cache.js";
import { config } from "../config/index.js";
import { calculatePopularity } from "./popularity.js";
import { calculateCompetitiveness } from "./competitiveness.js";
import {
  upsertStorefront,
  upsertWord,
  upsertKeyword,
  upsertApps,
  insertSearchSnapshot,
  insertAppRankings,
  insertAppRatings,
  insertPopularity,
  insertCompetitiveness,
} from "./db.js";

/**
 * Scrape App Store search results, persist all data, and cache the response.
 * Returns the full response object (same shape as /api/search).
 *
 * Safe to call multiple times — upserts are idempotent, but a new snapshot +
 * ranking/rating rows are always inserted (they are time-series records).
 *
 * @param {object} pg        - fastify.pg pool
 * @param {object} redis     - fastify.redis client
 * @param {object} opts
 * @param {string} opts.keyword
 * @param {string} [opts.store="us"]
 * @param {string} [opts.platform="iphone"]
 * @param {number} [opts.limit=50]
 * @returns {Promise<object>} response
 */
export async function runSearch(
  pg,
  redis,
  { keyword, store = "us", platform = "iphone", limit = 50, skipCache = false }
) {
  const cache = new CacheService(redis);
  const normKeyword = keyword.toLowerCase().trim();
  const cacheKey = `search:${store}:${platform}:${normKeyword}`;

  // Return cached result if available (skipped by background workers)
  if (!skipCache) {
    const cached = await cache.get(cacheKey);
    if (cached) return { ...cached, cached: true };
  }

  // Scrape
  const results = await getSearchRankings({
    keyword,
    country: store,
    platform,
    limit,
  });

  // Persist — upsertApps has no dependency on the keyword chain, run both in parallel
  const appData = results.map((r) => ({
    appleId:   r.id,
    bundleId:  r.bundleId,
    name:      r.name,
    developer: r.developer,
    price:     r.price,
    genre:     r.genre,
    iconUrl:   r.iconUrl,
  }));

  const [[storefront, word], appIdMap] = await Promise.all([
    Promise.all([upsertStorefront(pg, store), upsertWord(pg, keyword)]),
    upsertApps(pg, appData),
  ]);

  const kw = await upsertKeyword(pg, word.id, storefront.id, platform);

  const snapshot = await insertSearchSnapshot(
    pg,
    kw.id,
    results.length,
    results
  );

  await Promise.all([
    insertAppRankings(
      pg,
      kw.id,
      snapshot.id,
      results.map((r) => ({ appDbId: appIdMap.get(r.id), rank: r.rank }))
    ),
    insertAppRatings(
      pg,
      snapshot.id,
      results.map((r) => ({
        appDbId: appIdMap.get(r.id),
        rating: r.rating,
        ratingsCount: r.ratingCount,
      })),
      store,
      platform
    ),
    calculatePopularity(normKeyword, store, platform, {
      redis,
      mediaApiToken:     config.appleMediaApiToken,
      appleAdsCookie:    config.appleAdsCookie,
      appleAdsXsrfToken: config.appleAdsXsrfToken,
      appleAdsAdamId:    config.appleAdsAdamId,
    }).then(({ score }) => {
      if (score !== null) return insertPopularity(pg, kw.id, score);
      console.warn(`[search] Skipping popularity insert for "${normKeyword}" — score unavailable (rate limited)`);
    }),
    insertCompetitiveness(pg, kw.id, calculateCompetitiveness(results)),
  ]);

  const response = { keyword, store, platform, total: results.length, results };
  await cache.set(cacheKey, response, config.cacheTtlSearch);

  return { ...response, keywordId: kw.id, cached: false };
}
