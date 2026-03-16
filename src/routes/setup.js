import {
  setupApp,
  rankAllStores,
} from "../services/setupService.js";
import { getResultsPopularity } from "../services/resultsPopularityService.js";
import { getResultsDifficulty } from "../services/resultsDifficultyService.js";

export async function setupRoutes(fastify) {
  // ── POST /api/apps/setup ──────────────────────────────────────────────────
  fastify.post(
    "/api/apps/setup",
    {
      schema: {
        body: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string", minLength: 1 },
            stores: {
              type: "array",
              items: { type: "string" },
              default: [],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId, stores = [] } = request.body;
      const totalT0 = performance.now();

      const result = await setupApp(fastify.pg, fastify.redis, {
        appleId,
        stores,
      });

      if (!result) {
        return reply
          .code(404)
          .send({ error: "App not found on the App Store." });
      }

      // Log call counts before starting ranking phase
      console.log(
        `[setup] Setup complete. Calls count: ${result.callsCount}, Search HTML: ${result.searchHtmlCount}, Suggestion API: ${result.suggestionApiCount}`,
      );

      // Rank all search terms for all stores in parallel
      const rankResult = await rankAllStores(
        appleId,
        result.stores,
      );

      // Merge ranking data into store results
      const rankMap = Object.fromEntries(
        rankResult.stores.map((r) => [r.store, r]),
      );

      const mergedStores = result.stores.map((s) => {
        const ranked = rankMap[s.store];
        return {
          store: s.store,
          meta: s.meta,
          tokens: s.tokens,
          localizedIntents: s.localizedIntents,
          intentTopApps: s.intentTopApps,
          seedKeywords: s.seedKeywords,
          keywords: ranked?.keywords ?? [],
          liveKeywords: ranked?.liveKeywords ?? 0,
        };
      });

      const totalMs = Math.round(performance.now() - totalT0);

      // Build per-store opportunity keyword list (non-failed, sorted by opportunity desc)
      const opportunities = {};
      for (const s of mergedStores) {
        opportunities[s.store] = s.keywords
          .filter((k) => k.opportunity != null && k.opportunity > 9)
          .sort((a, b) => b.opportunity - a.opportunity)
          .map(({ term, popularity, difficulty, opportunity, rank }) => ({
            keyword: term,
            popularity,
            difficulty,
            opportunity,
            rank,
          }));
      }

      // Build per-store combined timings (setup phases + ranking phases)
      const perStoreTimings = {};
      for (const s of mergedStores) {
        const setup = result.timings.stores[s.store] ?? {};
        const ranking = rankMap[s.store]?.timings ?? {};
        perStoreTimings[s.store] = {
          scrapeMs: setup.scrapeMs ?? 0,
          intentSearchMs: setup.intentSearchMs ?? 0,
          miningMs: setup.miningMs ?? 0,
          ranking: {
            totalMs: ranking.totalMs ?? 0,
            fetchMs: ranking.fetchMs ?? 0,
            retryMs: ranking.retryMs ?? 0,
          },
          totalMs:
            (setup.scrapeMs ?? 0) +
            (setup.intentSearchMs ?? 0) +
            (setup.miningMs ?? 0) +
            (ranking.totalMs ?? 0),
        };
      }

      return {
        appleId,
        callsCount: result.callsCount,
        searchHtmlCount: result.searchHtmlCount,
        suggestionApiCount: result.suggestionApiCount,
        totalLiveKeywords: rankResult.totalLiveKeywords,
        timings: {
          totalMs,
          setupMs: result.timings.setupMs,
          geminiMs: result.timings.geminiMs,
          rankingMs: rankResult.rankingMs,
          stores: perStoreTimings,
        },
        opportunities,
        stores: mergedStores,
      };
    },
  );

  // ── GET /api/apps/:appleId/keywords/:keyword/score ──────────────────────────
  // Single-keyword scoring: computes all signals (result popularity, suggest
  // popularity, difficulty, opportunity) without running the full setup pipeline.
  fastify.get(
    "/api/apps/:appleId/keywords/:keyword/score",
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
            store: { type: "string", default: "us" },
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
      const { store = "us", platform = "iphone" } = request.query;
      const totalT0 = performance.now();

      // Fetch popularity and difficulty in parallel
      const [popResult, diffResult] = await Promise.all([
        getResultsPopularity(fastify.redis, { keyword, store, platform }),
        getResultsDifficulty(fastify.redis, { keyword, store, platform }),
      ]);

      const popularity = popResult.popularity;
      const difficulty = diffResult.difficulty;
      const opportunity = popularity - difficulty;

      // Find app rank from popularity results (fetches top 20)
      const appMatch = popResult.results.find(
        (r) => String(r.id) === String(appleId),
      );
      const appRank = appMatch?.rank ?? null;

      const totalMs = Math.round(performance.now() - totalT0);

      return {
        keyword,
        store,
        platform,
        appRank,
        numberOfResults: popResult.total,
        popularity: {
          score: popularity,
          breakdown: popResult.breakdown,
        },
        difficulty: {
          score: difficulty,
          breakdown: diffResult.breakdown,
        },
        opportunity,
        top10: popResult.results.slice(0, 10).map((app) => ({
          rank: app.rank,
          id: app.id,
          name: app.name || "",
          subtitle: app.subtitle ?? null,
          ratingCount: app.ratingCount ?? null,
          relevance: app.relevance,
        })),
        timings: {
          totalMs,
        },
      };
    },
  );
}
