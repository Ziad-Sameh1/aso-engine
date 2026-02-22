import { CacheService } from "../services/cache.js";
import { config } from "../config/index.js";
import { runSearch } from "../services/searchService.js";
import { fetchAppMetadata } from "../services/appstore.js";
import { calculatePopularity } from "../services/popularity.js";
import { getKeywordSuggestions } from "../services/suggestionService.js";
import {
  resolveKeyword,
  getAppCurrentRank,
  getAppRankHistory,
  getAppCurrentRating,
  getAppRatingHistory,
  getAppByAppleId,
  getAppsByAppleIds,
  getLatestRatingsBulk,
  getLatestRankingsByStoreBulk,
  getKeywordCurrentPopularity,
  getKeywordCurrentCompetitiveness,
  upsertApp,
  insertSingleAppRating,
  incrementKeywordDemand,
  periodToDate,
  VALID_PERIODS,
} from "../services/db.js";

export async function appsRoutes(fastify) {
  const cache = new CacheService(fastify.redis);

  /**
   * Resolve a keyword from the DB. If not found, trigger a search to populate it,
   * then resolve again.
   */
  async function resolveOrSearch(
    normKeyword,
    keyword,
    store,
    platform,
    { limit = 50 } = {}
  ) {
    let kw = await resolveKeyword(fastify.pg, normKeyword, store, platform);
    if (!kw) {
      const result = await runSearch(fastify.pg, fastify.redis, {
        keyword,
        store,
        platform,
        limit,
      });
      kw = result.keywordId
        ? { id: result.keywordId }
        : await resolveKeyword(fastify.pg, normKeyword, store, platform);
    }
    if (kw) incrementKeywordDemand(fastify.pg, kw.id).catch(() => {});
    return kw;
  }

  // ── GET /api/apps/:appleId/rank ──────────────────────────────────────────
  fastify.get(
    "/api/apps/:appleId/rank",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: { appleId: { type: "string" } },
        },
        querystring: {
          type: "object",
          required: ["keyword"],
          properties: {
            keyword: { type: "string", minLength: 1 },
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
      const { appleId } = request.params;
      const { keyword, store, platform } = request.query;
      const normKeyword = keyword.toLowerCase().trim();
      const cacheKey = `rank:${appleId}:${store}:${platform}:${normKeyword}`;

      const cached = await cache.get(cacheKey);
      if (cached) return { ...cached, cached: true };

      const kw = await resolveOrSearch(normKeyword, keyword, store, platform);
      if (!kw)
        return reply
          .code(404)
          .send({ error: "Could not resolve keyword after search." });

      const row = await getAppCurrentRank(fastify.pg, appleId, kw.id);
      if (!row)
        return reply
          .code(404)
          .send({ error: "App not found in search results for this keyword." });

      const result = {
        appleId,
        keyword,
        store,
        platform,
        rank: row.rank,
        rankedAt: row.ranked_at,
      };
      await cache.set(cacheKey, result, config.cacheTtlRank);
      return { ...result, cached: false };
    }
  );

  // ── GET /api/apps/:appleId/rank/history ─────────────────────────────────
  fastify.get(
    "/api/apps/:appleId/rank/history",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: { appleId: { type: "string" } },
        },
        querystring: {
          type: "object",
          required: ["keyword"],
          properties: {
            keyword: { type: "string", minLength: 1 },
            store: { type: "string", default: "us" },
            platform: {
              type: "string",
              enum: ["iphone", "ipad"],
              default: "iphone",
            },
            period: { type: "string", enum: VALID_PERIODS, default: "7d" },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { keyword, store, platform, period } = request.query;
      const normKeyword = keyword.toLowerCase().trim();

      const kw = await resolveOrSearch(normKeyword, keyword, store, platform);
      if (!kw)
        return reply
          .code(404)
          .send({ error: "Could not resolve keyword after search." });

      const since = periodToDate(period);
      const history = await getAppRankHistory(
        fastify.pg,
        appleId,
        kw.id,
        since
      );
      return { appleId, keyword, store, platform, period, history };
    }
  );

  // ── POST /api/apps/summary (bulk: ratings + latest rankings by store, no cache) ─
  fastify.post(
    "/api/apps/summary",
    {
      schema: {
        body: {
          type: "object",
          required: ["appleIds", "store"],
          properties: {
            appleIds: {
              type: "array",
              items: { type: "string", minLength: 1 },
              minItems: 1,
            },
            store: { type: "string", minLength: 1 },
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
      const { appleIds, store, platform = "iphone" } = request.body;
      const cacheKey = `summary:${store}:${platform}:${appleIds.sort().join(",")}`;

      const cached = await cache.get(cacheKey);
      if (cached) return { ...cached, cached: true };

      const apps = await getAppsByAppleIds(fastify.pg, appleIds);
      if (!apps.length)
        return reply
          .code(400)
          .send({ error: "No apps found for the given apple IDs." });

      const appIdList = apps.map((a) => a.id);
      const [ratingsRows, rankingsRows] = await Promise.all([
        getLatestRatingsBulk(fastify.pg, appIdList, store, platform),
        getLatestRankingsByStoreBulk(fastify.pg, appIdList, store, platform),
      ]);

      const ratingByAppId = new Map(ratingsRows.map((r) => [r.app_id, r]));
      const rankingsByAppId = new Map();
      for (const row of rankingsRows) {
        const list = rankingsByAppId.get(row.app_id) ?? [];
        list.push({
          keyword: row.keyword,
          rank: row.current_rank,
          previousRank: row.previous_rank ?? null,
          rankedAt: row.current_ranked_at,
        });
        rankingsByAppId.set(row.app_id, list);
      }

      const results = apps.map((app) => {
        const rating = ratingByAppId.get(app.id);
        const keywords = rankingsByAppId.get(app.id) ?? [];
        return {
          appleId: app.apple_id,
          store,
          platform,
          ratingsCount: rating?.ratings_count ?? null,
          latestRating: rating
            ? {
                rating: rating.rating,
                ratingsCount: rating.ratings_count,
                recordedAt: rating.recorded_at,
              }
            : null,
          keywords,
        };
      });

      const result = { total: results.length, store, platform, apps: results };
      await cache.set(cacheKey, result, config.cacheTtlRank);
      return { ...result, cached: false };
    }
  );

  // ── GET /api/apps/:appleId/rating ────────────────────────────────────────
  fastify.get(
    "/api/apps/:appleId/rating",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: { appleId: { type: "string" } },
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
      const { appleId } = request.params;
      const { store, platform } = request.query;
      const cacheKey = `rating:${appleId}:${store}:${platform}`;

      const cached = await cache.get(cacheKey);
      if (cached) return { ...cached, cached: true };

      // Try DB first (populated by search results)
      let row = await getAppCurrentRating(fastify.pg, appleId, store, platform);

      // On miss, hit iTunes Lookup directly and persist
      if (!row) {
        const meta = await fetchAppMetadata(appleId, store);
        if (!meta)
          return reply
            .code(404)
            .send({ error: "App not found on the App Store." });

        const app = await upsertApp(fastify.pg, { appleId, ...meta });
        await insertSingleAppRating(
          fastify.pg,
          app.id,
          meta.rating,
          meta.ratingCount,
          store,
          platform
        );

        row = {
          rating: meta.rating,
          ratings_count: meta.ratingCount,
          recorded_at: new Date(),
        };
      }

      const result = {
        appleId,
        store,
        platform,
        rating: row.rating,
        ratingsCount: row.ratings_count,
        recordedAt: row.recorded_at,
      };
      await cache.set(cacheKey, result, config.cacheTtlRating);
      return { ...result, cached: false };
    }
  );

  // ── GET /api/apps/:appleId/keywords/:keyword ─────────────────────────────
  fastify.get(
    "/api/apps/:appleId/keywords/:keyword",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId", "keyword"],
          properties: {
            appleId: { type: "string" },
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
        response: {
          200: {
            type: "object",
            properties: {
              appleId: { type: "string" },
              app: {
                type: "object",
                properties: {
                  name: { type: ["string", "null"] },
                  developer: { type: ["string", "null"] },
                  bundleId: { type: ["string", "null"] },
                  price: { type: ["string", "null"] },
                  genre: { type: ["string", "null"] },
                },
              },
              keyword: { type: "string" },
              store: { type: "string" },
              platform: { type: "string" },
              rank: { type: ["number", "null"] },
              rankedAt: { type: ["string", "null"] },
              popularity: { type: ["number", "null"] },
              competitiveness: { type: ["number", "null"] },
              cached: { type: "boolean" },
              popularityBreakdown: {
                type: ["object", "null"],
                additionalProperties: true,
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId, keyword } = request.params;
      const { store, platform } = request.query;
      const normKeyword = keyword.toLowerCase().trim();
      const cacheKey = `app-keyword:${appleId}:${store}:${platform}:${normKeyword}`;

      const cached = await cache.get(cacheKey);
      if (cached) return { ...cached, cached: true };

      const kw = await resolveOrSearch(normKeyword, keyword, store, platform, {
        limit: 100,
      });
      if (!kw)
        return reply
          .code(404)
          .send({ error: "Could not resolve keyword after search." });

      const [
        app,
        rankRow,
        popularityRow,
        competitivenessRow,
        popularityResult,
      ] = await Promise.all([
        getAppByAppleId(fastify.pg, appleId),
        getAppCurrentRank(fastify.pg, appleId, kw.id),
        getKeywordCurrentPopularity(fastify.pg, kw.id),
        getKeywordCurrentCompetitiveness(fastify.pg, kw.id),
        calculatePopularity(normKeyword, store, platform, {
          redis: fastify.redis,
          mediaApiToken: config.appleMediaApiToken,
          appleAdsCookie: config.appleAdsCookie,
          appleAdsXsrfToken: config.appleAdsXsrfToken,
          appleAdsAdamId: config.appleAdsAdamId,
        }),
      ]);

      if (!app) return reply.code(404).send({ error: "App not found." });

      const result = {
        appleId,
        app: {
          name: app.name,
          developer: app.developer,
          bundleId: app.bundle_id,
          price: app.price,
          genre: app.genre,
        },
        keyword,
        store,
        platform,
        rank: rankRow?.rank ?? null,
        rankedAt: rankRow?.ranked_at ?? null,
        popularity: popularityRow?.popularity ?? null,
        competitiveness: competitivenessRow?.competitiveness ?? null,
        popularityBreakdown: popularityResult?.breakdown ?? null,
      };

      await cache.set(cacheKey, result, config.cacheTtlRank);
      return { ...result, cached: false };
    }
  );

  // ── POST /api/apps/:appleId/keywords ──────────────────────────────────────
  fastify.post(
    "/api/apps/:appleId/keywords",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string" },
          },
        },
        body: {
          type: "object",
          required: ["keywords"],
          properties: {
            keywords: {
              type: "array",
              items: { type: "string", minLength: 1 },
              minItems: 1,
              maxItems: 20,
            },
            store: { type: "string", default: "us", pattern: "^[a-z]{2}$" },
            platform: {
              type: "string",
              enum: ["iphone", "ipad"],
              default: "iphone",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              appleId: { type: "string" },
              app: { type: ["object", "null"], additionalProperties: true },
              store: { type: "string" },
              platform: { type: "string" },
              results: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { keywords, store = "us", platform = "iphone" } = request.body;

      // Fetch app once (shared across all keywords)
      const app = await getAppByAppleId(fastify.pg, appleId);
      if (!app) return reply.code(404).send({ error: "App not found." });

      // Process all keywords in parallel
      const results = await Promise.all(
        keywords.map(async (keyword) => {
          const normKeyword = keyword.toLowerCase().trim();
          const cacheKey = `app-keyword:${appleId}:${store}:${platform}:${normKeyword}`;

          // Check cache first
          const cached = await cache.get(cacheKey);
          if (cached) return { ...cached, cached: true };

          try {
            const kw = await resolveOrSearch(
              normKeyword,
              keyword,
              store,
              platform,
              { limit: 100 }
            );
            if (!kw) return { keyword, error: "Could not resolve keyword." };

            const [
              rankRow,
              popularityRow,
              competitivenessRow,
              popularityResult,
            ] = await Promise.all([
              getAppCurrentRank(fastify.pg, appleId, kw.id),
              getKeywordCurrentPopularity(fastify.pg, kw.id),
              getKeywordCurrentCompetitiveness(fastify.pg, kw.id),
              calculatePopularity(normKeyword, store, platform, {
                redis: fastify.redis,
                mediaApiToken: config.appleMediaApiToken,
                appleAdsCookie: config.appleAdsCookie,
                appleAdsXsrfToken: config.appleAdsXsrfToken,
                appleAdsAdamId: config.appleAdsAdamId,
              }),
            ]);

            const result = {
              keyword,
              rank: rankRow?.rank ?? null,
              rankedAt: rankRow?.ranked_at ?? null,
              popularity: popularityRow?.popularity ?? null,
              competitiveness: competitivenessRow?.competitiveness ?? null,
              popularityBreakdown: popularityResult?.breakdown ?? null,
            };

            await cache.set(cacheKey, result, config.cacheTtlRank);
            return { ...result, cached: false };
          } catch (err) {
            return { keyword, error: err.message };
          }
        })
      );

      return {
        appleId,
        app: {
          name: app.name,
          developer: app.developer,
          bundleId: app.bundle_id,
          price: app.price,
          genre: app.genre,
        },
        store,
        platform,
        results,
      };
    }
  );

  // ── POST /api/apps/:appleId/keywords/suggest ─────────────────────────────
  fastify.post(
    "/api/apps/:appleId/keywords/suggest",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string" },
          },
        },
        body: {
          type: "object",
          properties: {
            store: { type: "string", default: "us", pattern: "^[a-z]{2}$" },
            platform: {
              type: "string",
              enum: ["iphone", "ipad"],
              default: "iphone",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              appleId: { type: "string" },
              app: { type: "object", additionalProperties: true },
              store: { type: "string" },
              platform: { type: "string" },
              totalGenerated: { type: "number" },
              totalRanked: { type: "number" },
              cached: { type: "boolean" },
              timings: { type: "object", additionalProperties: true },
              results: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { store = "us", platform = "iphone" } = request.body ?? {};
      const cacheKey = `suggestions:${appleId}:${store}:${platform}`;

      const cached = await cache.get(cacheKey);
      if (cached) return { ...cached, cached: true };

      try {
        const data = await getKeywordSuggestions(
          fastify.pg,
          fastify.redis,
          appleId,
          { store, platform }
        );
        const result = { appleId, store, platform, ...data };
        await cache.set(cacheKey, result, 3600); // 1h — rankings change more often than suggestions
        return { ...result, cached: false };
      } catch (err) {
        fastify.log.error(
          { err, appleId },
          "[POST /api/apps/:appleId/keywords/suggest] failed"
        );
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // ── GET /api/apps/:appleId/rating/history ────────────────────────────────
  fastify.get(
    "/api/apps/:appleId/rating/history",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: { appleId: { type: "string" } },
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
            period: { type: "string", enum: VALID_PERIODS, default: "7d" },
          },
        },
      },
    },
    async (request) => {
      const { appleId } = request.params;
      const { store, platform, period } = request.query;
      const since = periodToDate(period);
      const history = await getAppRatingHistory(
        fastify.pg,
        appleId,
        store,
        platform,
        since
      );
      return { appleId, store, platform, period, history };
    }
  );
}
