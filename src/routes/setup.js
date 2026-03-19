import {
  setupApp,
  rankAllStores,
  DEFAULT_STORES,
} from "../services/setupService.js";
import { scrapeAppPageMetadata } from "../services/appstore.js";
import { getResultsPopularity } from "../services/resultsPopularityService.js";
import { getResultsDifficulty } from "../services/resultsDifficultyService.js";
import { config } from "../config/index.js";

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

      const totalMs = Math.round(performance.now() - totalT0);

      return {
        appleId,
        timings: {
          totalMs,
          setupMs: result.timings.setupMs,
          geminiMs: result.timings.geminiMs,
          stores: result.timings.stores,
        },
        stores: result.stores.map((s) => ({
          store: s.store,
          tokens: s.tokens,
          localizedIntents: s.localizedIntents,
          intentTopApps: s.intentTopApps,
          seedKeywords: s.seedKeywords,
        })),
      };
    },
  );

  // ── GET /api/apps/:appleId/ratings ───────────────────────────────────────────
  // Returns rating + review count + breakdown histogram for each requested store.
  // Query param `stores` is comma-separated (e.g. ?stores=us,gb,jp).
  // Defaults to DEFAULT_STORES when omitted.
  fastify.get(
    "/api/apps/:appleId/ratings",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string", minLength: 1 },
          },
        },
        querystring: {
          type: "object",
          properties: {
            stores: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { stores: storesParam } = request.query;
      const proxyUrl = config.proxyUrl ?? null;
      const totalT0 = performance.now();

      const targetStores = storesParam
        ? storesParam.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
        : DEFAULT_STORES;

      const storeResults = await Promise.all(
        targetStores.map(async (store) => {
          const t0 = performance.now();
          const meta = await scrapeAppPageMetadata(appleId, store, proxyUrl);
          const ms = Math.round(performance.now() - t0);
          if (!meta) return { store, found: false, ms };
          return {
            store,
            found: true,
            rating: meta.rating,
            reviewCount: meta.reviewCount,
            ratingBreakdown: meta.ratingBreakdown,
            ms,
          };
        }),
      );

      const totalMs = Math.round(performance.now() - totalT0);

      return {
        appleId,
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

  // ── GET /api/apps/:appleId/version-history ────────────────────────────────────
  // Returns the full version history for a single storefront.
  // Query param `store` defaults to "us".
  fastify.get(
    "/api/apps/:appleId/version-history",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string", minLength: 1 },
          },
        },
        querystring: {
          type: "object",
          properties: {
            store: { type: "string", default: "us" },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { store = "us" } = request.query;
      const proxyUrl = config.proxyUrl ?? null;
      const t0 = performance.now();

      const meta = await scrapeAppPageMetadata(appleId, store, proxyUrl);
      const ms = Math.round(performance.now() - t0);

      if (!meta) {
        return reply.code(404).send({ error: "App not found", appleId, store });
      }

      return {
        appleId,
        store,
        currentVersion: meta.versionHistory?.[0]?.version ?? null,
        versionHistory: meta.versionHistory ?? [],
        timings: { ms },
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
