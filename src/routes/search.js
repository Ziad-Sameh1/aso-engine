import { CacheService } from "../services/cache.js";
import { config } from "../config/index.js";
import { runSearch } from "../services/searchService.js";
import { incrementKeywordDemand, resolveKeyword as resolveKeywordId } from "../services/db.js";

export async function searchRoutes(fastify) {
  const cache = new CacheService(fastify.redis);

  fastify.get(
    "/api/search",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["keyword"],
          properties: {
            keyword:  { type: "string", minLength: 1 },
            store:    { type: "string", default: "us" },
            platform: { type: "string", enum: ["iphone", "ipad"], default: "iphone" },
            limit:    { type: "integer", minimum: 1, maximum: 130, default: 50 },
          },
        },
      },
    },
    async (request) => {
      const { keyword, store, platform, limit } = request.query;
      const normKeyword = keyword.toLowerCase().trim();
      const cacheKey = `search:${store}:${platform}:${normKeyword}`;

      const cached = await cache.get(cacheKey);
      if (cached) {
        // Still track demand even on cache hits (fire-and-forget)
        resolveKeywordId(fastify.pg, normKeyword, store, platform)
          .then((kw) => kw && incrementKeywordDemand(fastify.pg, kw.id))
          .catch(() => {});
        return { ...cached, cached: true };
      }

      const result = await runSearch(fastify.pg, fastify.redis, { keyword, store, platform, limit });
      if (result.keywordId) {
        incrementKeywordDemand(fastify.pg, result.keywordId).catch(() => {});
      }
      return result;
    }
  );
}
