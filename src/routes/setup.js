import { setupApp, rankAllStores } from "../services/setupService.js";

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

      const result = await setupApp(fastify.pg, fastify.redis, { appleId, stores });

      if (!result) {
        return reply.code(404).send({ error: "App not found on the App Store." });
      }

      // Log call counts before starting ranking phase
      console.log(`[setup] Setup complete. Calls count: ${result.callsCount}, Search HTML: ${result.searchHtmlCount}, Suggestion API: ${result.suggestionApiCount}`);

      // Rank all search terms for all stores in parallel
      const rankResult = await rankAllStores(appleId, result.stores, fastify.redis);

      // Merge ranking data into store results
      const rankMap = Object.fromEntries(
        rankResult.stores.map((r) => [r.store, r])
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
            metadataLookupMs: ranking.metadataLookupMs ?? 0,
          },
          totalMs: (setup.scrapeMs ?? 0) + (setup.intentSearchMs ?? 0) + (setup.miningMs ?? 0) + (ranking.totalMs ?? 0),
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
        stores: mergedStores,
      };
    }
  );
}
