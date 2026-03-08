import { CacheService } from "../services/cache.js";
import { config } from "../config/index.js";
import { runSearch } from "../services/searchService.js";
import { calculatePopularity } from "../services/popularity.js";
import {
  resolveKeyword,
  getKeywordCurrentPopularity,
  getKeywordPopularityHistory,
  getKeywordCurrentCompetitiveness,
  getKeywordCompetitivenessHistory,
  insertPopularity,
  incrementKeywordDemand,
  periodToDate,
  VALID_PERIODS,
} from "../services/db.js";

export async function keywordsRoutes(fastify) {
  const cache = new CacheService(fastify.redis);

  /**
   * Resolve a keyword from the DB. If not found, trigger a search to populate it,
   * then resolve again.
   */
  async function resolveOrSearch(normKeyword, keyword, store, platform) {
    let kw = await resolveKeyword(fastify.pg, normKeyword, store, platform);
    if (!kw) {
      const result = await runSearch(fastify.pg, fastify.redis, {
        keyword,
        store,
        platform,
      });
      kw = result.keywordId
        ? { id: result.keywordId }
        : await resolveKeyword(fastify.pg, normKeyword, store, platform);
    }
    if (kw) incrementKeywordDemand(fastify.pg, kw.id).catch(() => {});
    return kw;
  }

  // ── GET /api/keywords/popularity ─────────────────────────────────────────
  fastify.get(
    "/api/keywords/popularity",
    {
      schema: {
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
      const { keyword, store, platform } = request.query;
      const normKeyword = keyword.toLowerCase().trim();
      const cacheKey = `popularity:${store}:${platform}:${normKeyword}`;

      fastify.log.info(
        { keyword: normKeyword, store, platform, cacheKey },
        "[GET /api/keywords/popularity] request"
      );

      if (config.cacheTtlPopularity > 0) {
        const cached = await cache.get(cacheKey);
        if (cached) {
          fastify.log.info(
            { keyword: normKeyword, popularity: cached.popularity },
            "[GET /api/keywords/popularity] cache hit"
          );
          return { ...cached, cached: true };
        }
        fastify.log.debug(
          { cacheKey },
          "[GET /api/keywords/popularity] cache miss"
        );
      }

      fastify.log.debug(
        { cacheKey },
        "[GET /api/keywords/popularity] starting search"
      );

      const kw = await resolveOrSearch(normKeyword, keyword, store, platform);
      if (!kw) {
        fastify.log.warn(
          { keyword: normKeyword, store, platform },
          "[GET /api/keywords/popularity] keyword not resolved after search"
        );
        return reply
          .code(404)
          .send({ error: "Could not resolve keyword after search." });
      }
      fastify.log.debug(
        { keywordId: kw.id },
        "[GET /api/keywords/popularity] keyword resolved"
      );

      // Calculate live popularity score
      let popularity = null;
      let breakdown = null;
      const popResult = await calculatePopularity(normKeyword, store, platform, {
        redis: fastify.redis,
        mediaApiToken: config.appleMediaApiToken,
        appleAdsCookie: config.appleAdsCookie,
        appleAdsXsrfToken: config.appleAdsXsrfToken,
        appleAdsAdamId: config.appleAdsAdamId,
      });

      if (popResult?.score != null) {
        popularity = popResult.score;
        breakdown = popResult.breakdown ?? null;
        // Persist fresh score to DB (fire-and-forget)
        insertPopularity(fastify.pg, kw.id, popularity).catch(() => {});
        fastify.log.debug(
          { keywordId: kw.id, popularity },
          "[GET /api/keywords/popularity] live score calculated"
        );
      } else {
        // Fall back to last known DB value
        const row = await getKeywordCurrentPopularity(fastify.pg, kw.id);
        if (row) {
          popularity = row.popularity;
          fastify.log.debug(
            { keywordId: kw.id, popularity },
            "[GET /api/keywords/popularity] using DB fallback"
          );
        }
      }

      if (popularity == null) {
        fastify.log.warn(
          { keywordId: kw.id, keyword: normKeyword },
          "[GET /api/keywords/popularity] no popularity data available"
        );
        return reply.code(404).send({ error: "No popularity data found." });
      }

      const result = {
        keyword,
        store,
        platform,
        popularity,
        breakdown,
        fetchedAt: new Date().toISOString(),
      };
      if (config.cacheTtlPopularity > 0) {
        await cache.set(cacheKey, result, config.cacheTtlPopularity);
      }
      fastify.log.info(
        { keyword: normKeyword, popularity, keywordId: kw.id },
        "[GET /api/keywords/popularity] success"
      );
      return { ...result, cached: false };
    }
  );

  // ── GET /api/keywords/popularity/history ─────────────────────────────────
  fastify.get(
    "/api/keywords/popularity/history",
    {
      schema: {
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
      const { keyword, store, platform, period } = request.query;
      const normKeyword = keyword.toLowerCase().trim();

      const kw = await resolveOrSearch(normKeyword, keyword, store, platform);
      if (!kw)
        return reply
          .code(404)
          .send({ error: "Could not resolve keyword after search." });

      const since = periodToDate(period);
      const history = await getKeywordPopularityHistory(
        fastify.pg,
        kw.id,
        since
      );
      return { keyword, store, platform, period, history };
    }
  );

  // ── GET /api/keywords/competitiveness ────────────────────────────────────
  fastify.get(
    "/api/keywords/competitiveness",
    {
      schema: {
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
      const { keyword, store, platform } = request.query;
      const normKeyword = keyword.toLowerCase().trim();
      const cacheKey = `competitiveness:${store}:${platform}:${normKeyword}`;

      const cached = await cache.get(cacheKey);
      if (cached) return { ...cached, cached: true };

      const kw = await resolveOrSearch(normKeyword, keyword, store, platform);
      if (!kw)
        return reply
          .code(404)
          .send({ error: "Could not resolve keyword after search." });

      const row = await getKeywordCurrentCompetitiveness(fastify.pg, kw.id);
      if (!row)
        return reply
          .code(404)
          .send({ error: "No competitiveness data found." });

      const result = {
        keyword,
        store,
        platform,
        competitiveness: row.competitiveness,
        fetchedAt: row.fetched_at,
      };
      await cache.set(cacheKey, result, config.cacheTtlCompetitiveness);
      return { ...result, cached: false };
    }
  );

  // ── GET /api/keywords/competitiveness/history ────────────────────────────
  fastify.get(
    "/api/keywords/competitiveness/history",
    {
      schema: {
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
      const { keyword, store, platform, period } = request.query;
      const normKeyword = keyword.toLowerCase().trim();

      const kw = await resolveOrSearch(normKeyword, keyword, store, platform);
      if (!kw)
        return reply
          .code(404)
          .send({ error: "Could not resolve keyword after search." });

      const since = periodToDate(period);
      const history = await getKeywordCompetitivenessHistory(
        fastify.pg,
        kw.id,
        since
      );
      return { keyword, store, platform, period, history };
    }
  );
}
