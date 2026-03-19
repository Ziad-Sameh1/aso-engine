import { getSearchRankings } from "../services/appstore.js";
import { getProxyAgent } from "../services/appstore.js";
import {
  storeToLocale,
  relevanceMultiplier,
  hydrateSubtitles,
} from "../services/resultsShared.js";
import { scorePopularity } from "../services/resultsPopularityService.js";
import { calculateDifficultyScore } from "../services/resultsDifficultyService.js";
import { calculateOpportunity } from "../services/opportunity.js";
import { calculatePopularity } from "../services/popularity.js";
import { DEFAULT_STORES } from "../services/setupService.js";
import { config } from "../config/index.js";

export async function keywordScoreRoutes(fastify) {
  // ── GET /api/apps/:appleId/keywords/:keyword/score-all ────────────────────
  // Scores a keyword across all default stores in parallel.
  // Returns resultsPopularity, suggestionPopularity, difficulty, opportunity per store.
  fastify.get(
    "/api/apps/:appleId/keywords/:keyword/score-all",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId", "keyword"],
          properties: {
            appleId: { type: "string", minLength: 1 },
            keyword: { type: "string", minLength: 1 },
          },
        },
        querystring: {
          type: "object",
          properties: {
            stores: { type: "string" },
            platform: {
              type: "string",
              enum: ["iphone", "ipad"],
              default: "iphone",
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId, keyword } = request.params;
      const { platform = "iphone", stores: storesParam } = request.query;
      const totalT0 = performance.now();

      const targetStores = storesParam
        ? storesParam.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
        : DEFAULT_STORES;

      const httpsAgent = config.proxyUrl ? getProxyAgent() : null;

      // Score all stores in parallel
      const storeResults = await Promise.all(
        targetStores.map(async (store) => {
          const t0 = performance.now();
          try {
            return await scoreStore(
              appleId, keyword, store, platform, fastify.redis, httpsAgent,
            );
          } catch (err) {
            const ms = Math.round(performance.now() - t0);
            return { store, error: err.message, ms };
          }
        }),
      );

      const totalMs = Math.round(performance.now() - totalT0);

      return {
        appleId,
        keyword,
        platform,
        stores: storeResults,
        timings: {
          totalMs,
          perStore: Object.fromEntries(
            storeResults.map(({ store, ms }) => [store, ms]),
          ),
        },
      };
    },
  );
}

/**
 * Score a keyword in a single store.
 * Runs search → tags relevance → computes all four scores.
 */
async function scoreStore(appleId, keyword, store, platform, redis, httpsAgent) {
  const t0 = performance.now();

  // 1. Fetch search results (via proxy)
  const results = await getSearchRankings({
    keyword,
    country: store,
    platform,
    limit: 20,
    useProxy: true,
  });

  await hydrateSubtitles(results, store);

  const locale = storeToLocale(store);

  // 2. Tag relevance
  const tagged = results.map((app) => {
    const { multiplier, match } = relevanceMultiplier(
      keyword, app.name, app.subtitle, locale,
    );
    const ratingCount = Math.max(app.ratingCount ?? 0, 1);
    return { ...app, relevance: { multiplier, match, ratingCount } };
  });

  // 3. Results popularity (EIV-based)
  const { popularity: resultsPopularity, breakdown: popularityBreakdown } =
    scorePopularity(tagged);

  // 4. Difficulty
  const { difficulty, breakdown: difficultyBreakdown } =
    calculateDifficultyScore(tagged);

  // 5. Opportunity
  const opportunity = calculateOpportunity(resultsPopularity, difficulty);

  // 6. Suggestion popularity (prefix depth + position + Apple Ads) — in parallel
  const suggestResult = await calculatePopularity(keyword, store, platform, {
    redis,
    mediaApiToken: config.appleMediaApiToken,
    appleAdsCookie: config.appleAdsCookie,
    appleAdsXsrfToken: config.appleAdsXsrfToken,
    appleAdsAdamId: config.appleAdsAdamId,
    httpsAgent,
  });

  // 7. Find app rank
  const appRank = tagged.find((r) => String(r.id) === String(appleId))?.rank ?? null;

  const ms = Math.round(performance.now() - t0);

  return {
    store,
    appRank,
    resultsPopularity,
    suggestionPopularity: suggestResult.score,
    difficulty,
    opportunity,
    breakdown: {
      popularity: popularityBreakdown,
      difficulty: difficultyBreakdown,
      suggestion: suggestResult.breakdown,
    },
    ms,
  };
}
